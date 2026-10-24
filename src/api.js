// Endpoint logic shared by the REST router (src/index.js) and the MCP server (src/mcp/).
import { SecError, archiveBase, form4XmlUrl } from './sec.js';
import { parseForm4, flatten, padCik } from './form4.js';

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };

export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data, null, 2), { status, headers: { ...JSON_HEADERS, ...extra } });
export const err = (status, message) => json({ error: { status, message } }, status);
const intParam = (sp, name, def, min, max) => {
    const v = sp.get(name);
    if (v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new SecError(400, `Parameter "${name}" must be a number.`);
    return Math.min(max, Math.max(min, Math.floor(n)));
};
const dateParam = (sp, name) => {
    const v = sp.get(name);
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new SecError(400, `Parameter "${name}" must be YYYY-MM-DD.`);
    return v;
};
const listParam = (sp, name) => (sp.get(name) || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86400000));

// ---------------- insider trades for one company / insider ----------------
export async function insiderTrades(sec, id, sp) {
    const who = await sec.resolve(id);
    const limit = intParam(sp, 'limit', 10, 1, 25); // number of Form 4 filings to parse
    const codes = new Set(listParam(sp, 'codes'));
    const side = (sp.get('side') || '').toLowerCase(); // buy | sell
    const since = dateParam(sp, 'since');
    const includeDerivative = sp.get('includeDerivative') !== 'false';
    const subs = await sec.submissions(who.cik);
    const r = subs.recent;
    const idx = [];
    for (let i = 0; i < r.form.length && idx.length < limit; i++) {
        if (r.form[i] !== '4' && r.form[i] !== '4/A') continue;
        if (since && r.filingDate[i] < since) break; // recent[] is newest first
        idx.push(i);
    }
    const filings = await Promise.all(idx.map((i) => sec.cached(`f4_v1:${r.accessionNumber[i]}`, 30 * 86400, async () => {
        // Accession folders live under the filer agent's or issuer's CIK; the subject CIK always works.
        const url = form4XmlUrl(who.cik, r.accessionNumber[i], r.primaryDocument[i]);
        const text = await sec.text(url);
        return parseForm4(text, { accessionNumber: r.accessionNumber[i], filingDate: r.filingDate[i], form: r.form[i], filingUrl: url, indexUrl: `${archiveBase(who.cik, r.accessionNumber[i])}/` });
    })));
    let rows = filings.filter(Boolean).flatMap(flatten);
    if (!includeDerivative) rows = rows.filter((t) => !t.isDerivative);
    if (codes.size) rows = rows.filter((t) => codes.has(t.transactionCode));
    if (side === 'buy') rows = rows.filter((t) => t.transactionCode === 'P');
    if (side === 'sell') rows = rows.filter((t) => t.transactionCode === 'S');
    const buys = rows.filter((t) => t.transactionCode === 'P');
    const sells = rows.filter((t) => t.transactionCode === 'S');
    const sum = (a, k) => Math.round(a.reduce((s, x) => s + (x[k] || 0), 0) * 100) / 100;
    return {
        query: { id, cik: who.cik, ticker: who.ticker || subs.tickers[0] || null, name: subs.name },
        filingsParsed: filings.filter(Boolean).length,
        summary: {
            transactions: rows.length,
            openMarketBuys: buys.length, openMarketBuyShares: sum(buys, 'shares'), openMarketBuyValue: sum(buys, 'totalValue'),
            openMarketSells: sells.length, openMarketSellShares: sum(sells, 'shares'), openMarketSellValue: sum(sells, 'totalValue'),
            distinctInsiders: new Set(rows.map((t) => t.insiderCik)).size,
        },
        transactions: rows,
    };
}

// ---------------- market-wide Form 4 scanning (cron + on-demand) ----------------
const BUYS_KEY = 'market_buys_v2';
const SEEN_KEY = 'market_seen_v2';
const BUY_FIELDS = ['ticker', 'issuerName', 'issuerCik', 'insiderName', 'insiderCik', 'insiderRole', 'isDirector', 'isOfficer', 'isTenPercentOwner', 'transactionDate', 'transactionCode', 'shares', 'pricePerShare', 'totalValue', 'sharesOwnedAfter', 'directOrIndirect', 'securityTitle', 'is10b51Plan', 'accessionNumber', 'filingDate', 'filingUrl'];
const compact = (t) => Object.fromEntries(BUY_FIELDS.map((k) => [k, t[k] ?? null]));

async function eftsForm4Page(sec, startdt, enddt, from = 0) {
    const url = `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}`;
    const d = await sec.json(url);
    const hits = d?.hits?.hits || [];
    return {
        total: d?.hits?.total?.value ?? hits.length,
        hits: hits.map((h) => {
            const [adsh, file] = String(h._id).split(':');
            const s = h._source || {};
            return { adsh, file, ciks: s.ciks || [], names: s.display_names || [], fileDate: s.file_date, form: s.form };
        }).filter((h) => h.form === '4' || h.form === '4/A' || !h.form),
    };
}

/** Parse up to `maxFilings` unseen Form 4s from EDGAR full-text search and keep purchases (code P). */
export async function scanMarket(sec, store, { maxFilings, days = 2 }) {
    const seen = new Set(store.seen || []);
    const buys = store.buys || [];
    const startdt = daysAgo(days); const enddt = isoDay(new Date());
    let parsed = 0; let pages = 0; let from = 0; let total = 0;
    const todo = [];
    while (todo.length < maxFilings && pages < 3) {
        const page = await eftsForm4Page(sec, startdt, enddt, from);
        pages++; total = page.total;
        for (const h of page.hits) {
            if (seen.has(h.adsh) || todo.some((t) => t.adsh === h.adsh)) continue;
            if (!/\.xml$/i.test(h.file || '')) { seen.add(h.adsh); continue; }
            todo.push(h);
            if (todo.length >= maxFilings) break;
        }
        from += 100;
        if (from >= total) break;
    }
    // Leave room for the remaining fetches inside the subrequest budget.
    const room = Math.max(0, sec.budgetLeft() - 2);
    const batch = todo.slice(0, Math.min(todo.length, room));
    const results = await Promise.all(batch.map(async (h) => {
        // Folder lives under each listed CIK; try the issuer (last) then the owner.
        const cik = h.ciks[h.ciks.length - 1] || h.ciks[0];
        const url = `${archiveBase(cik, h.adsh)}/${h.file}`;
        try {
            const text = await sec.text(url);
            return { h, f: parseForm4(text, { accessionNumber: h.adsh, filingDate: h.fileDate, filingUrl: url }) };
        } catch (e) { return { h, f: null, e }; }
    }));
    for (const { h, f } of results) {
        seen.add(h.adsh); parsed++;
        if (!f) continue;
        for (const t of flatten(f)) if (t.transactionCode === 'P' && !t.isDerivative) buys.push(compact(t));
    }
    const cutoff = daysAgo(31);
    // Bounded sizes keep JSON parse/stringify well inside the Free plan's 10 ms CPU limit.
    const keptBuys = buys.filter((b) => (b.filingDate || '') >= cutoff).slice(-1500);
    return { store: { updatedAt: new Date().toISOString(), seen: [...seen].slice(-6000), buys: keptBuys }, parsed, eftsTotal: total, pending: Math.max(0, todo.length - batch.length) };
}

export async function loadStore(env, { withSeen = true } = {}) {
    if (!env.CACHE) return { seen: [], buys: [] };
    const [b, seen] = await Promise.all([env.CACHE.get(BUYS_KEY, 'json'), withSeen ? env.CACHE.get(SEEN_KEY, 'json') : null]);
    return { updatedAt: b?.updatedAt || null, buys: b?.buys || [], seen: seen || [], seenCount: b?.seenCount ?? (seen ? seen.length : null) };
}

export async function saveStore(env, store) {
    if (!env.CACHE) return;
    // Two KV writes per scan (Free tier: 1,000 writes/day; cron uses 288/day).
    await Promise.all([
        env.CACHE.put(BUYS_KEY, JSON.stringify({ updatedAt: store.updatedAt, seenCount: (store.seen || []).length, buys: store.buys })),
        env.CACHE.put(SEEN_KEY, JSON.stringify(store.seen)),
    ]).catch((e) => console.warn(`KV write failed: ${e.message}`));
}

export async function insiderBuys(sec, env, sp) {
    const days = intParam(sp, 'days', 7, 1, 30);
    const minValue = intParam(sp, 'minValue', 0, 0, 1e12);
    const minInsiders = intParam(sp, 'minInsiders', 1, 1, 20);
    const limit = intParam(sp, 'limit', 50, 1, 500);
    const role = (sp.get('role') || '').toLowerCase(); // officer | director | tenpercent
    let store = await loadStore(env, { withSeen: false });
    let scannedNow = 0;
    if (!store.updatedAt) {
        // Cold start (cron has not run yet): scan the most recent filings on demand.
        store = await loadStore(env);
        const r = await scanMarket(sec, store, { maxFilings: Math.min(35, sec.budgetLeft() - 6), days: 2 });
        store = r.store; scannedNow = r.parsed;
        await saveStore(env, store);
    }
    const cutoff = daysAgo(days);
    let buys = (store.buys || []).filter((b) => (b.filingDate || b.transactionDate || '') >= cutoff);
    if (role === 'officer') buys = buys.filter((b) => b.isOfficer);
    if (role === 'director') buys = buys.filter((b) => b.isDirector);
    if (role === 'tenpercent') buys = buys.filter((b) => b.isTenPercentOwner);
    const byIssuer = new Map();
    for (const b of buys) {
        const k = b.issuerCik || b.ticker;
        if (!byIssuer.has(k)) byIssuer.set(k, { ticker: b.ticker, issuerName: b.issuerName, issuerCik: b.issuerCik, insiders: new Map(), transactions: [] });
        const g = byIssuer.get(k);
        g.transactions.push(b);
        const ins = g.insiders.get(b.insiderCik) || { name: b.insiderName, cik: b.insiderCik, role: b.insiderRole, shares: 0, value: 0 };
        ins.shares += b.shares || 0; ins.value += b.totalValue || 0;
        g.insiders.set(b.insiderCik, ins);
    }
    let clusters = [...byIssuer.values()].map((g) => {
        const value = g.transactions.reduce((s, t) => s + (t.totalValue || 0), 0);
        const shares = g.transactions.reduce((s, t) => s + (t.shares || 0), 0);
        const dates = g.transactions.map((t) => t.transactionDate).filter(Boolean).sort();
        return {
            ticker: g.ticker, issuerName: g.issuerName, issuerCik: g.issuerCik,
            insiderCount: g.insiders.size, isClusterBuy: g.insiders.size >= 2,
            totalShares: Math.round(shares * 1000) / 1000, totalValue: Math.round(value * 100) / 100,
            avgPrice: shares ? Math.round((value / shares) * 10000) / 10000 : null,
            firstTransactionDate: dates[0] || null, lastTransactionDate: dates[dates.length - 1] || null,
            insiders: [...g.insiders.values()].map((i) => ({ ...i, value: Math.round(i.value * 100) / 100 })),
            transactions: g.transactions,
        };
    }).filter((c) => c.insiderCount >= minInsiders && c.totalValue >= minValue);
    clusters.sort((a, b) => (b.insiderCount - a.insiderCount) || (b.totalValue - a.totalValue));
    clusters = clusters.slice(0, limit);
    return {
        window: { days, from: cutoff, to: isoDay(new Date()) },
        dataUpdatedAt: store.updatedAt || null,
        coverageNote: 'Built from Form 4 filings parsed by a scheduled scan of EDGAR full-text search (every 10 minutes when the cron trigger is enabled). Only open-market purchases (code P, non-derivative) are included. Coverage starts when the API is deployed.',
        filingsTracked: store.seen?.length || store.seenCount || null,
        scannedThisRequest: scannedNow,
        issuers: clusters.length,
        clusterBuys: clusters.filter((c) => c.isClusterBuy).length,
        results: clusters,
    };
}

// ---------------- filings list ----------------
export async function filings(sec, id, sp) {
    const who = await sec.resolve(id);
    const subs = await sec.submissions(who.cik);
    const forms = new Set(listParam(sp, 'forms'));
    const limit = intParam(sp, 'limit', 50, 1, 1000);
    const since = dateParam(sp, 'since');
    const until = dateParam(sp, 'until');
    const r = subs.recent;
    const out = [];
    for (let i = 0; i < r.form.length && out.length < limit; i++) {
        const f = String(r.form[i]).toUpperCase();
        if (forms.size && !forms.has(f) && !forms.has(f.replace(/\/A$/, ''))) continue;
        if (since && r.filingDate[i] < since) break;
        if (until && r.filingDate[i] > until) continue;
        const base = archiveBase(who.cik, r.accessionNumber[i]);
        out.push({
            accessionNumber: r.accessionNumber[i], form: r.form[i], filingDate: r.filingDate[i], reportDate: r.reportDate[i] || null,
            acceptanceDateTime: r.acceptanceDateTime[i] || null, items: r.items[i] || null, size: r.size[i] || null,
            primaryDocument: r.primaryDocument[i] || null, description: r.primaryDocDescription[i] || null,
            documentUrl: r.primaryDocument[i] ? `${base}/${r.primaryDocument[i]}` : null, indexUrl: `${base}/${r.accessionNumber[i]}-index.htm`,
        });
    }
    const { recent, olderFilingFiles, ...company } = subs;
    return { company: { ...company, ticker: who.ticker || subs.tickers[0] || null }, count: out.length, filings: out, note: 'Covers the ~1,000 most recent filings EDGAR lists in the submissions API.' };
}

// ---------------- company facts / financial snapshot ----------------
const METRICS = [
    ['revenue', 'us-gaap', ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'], 'USD', 'duration'],
    ['grossProfit', 'us-gaap', ['GrossProfit'], 'USD', 'duration'],
    ['operatingIncome', 'us-gaap', ['OperatingIncomeLoss'], 'USD', 'duration'],
    ['netIncome', 'us-gaap', ['NetIncomeLoss', 'ProfitLoss'], 'USD', 'duration'],
    ['epsDiluted', 'us-gaap', ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], 'USD/shares', 'duration'],
    ['operatingCashFlow', 'us-gaap', ['NetCashProvidedByUsedInOperatingActivities'], 'USD', 'duration'],
    ['totalAssets', 'us-gaap', ['Assets'], 'USD', 'instant'],
    ['totalLiabilities', 'us-gaap', ['Liabilities'], 'USD', 'instant'],
    ['stockholdersEquity', 'us-gaap', ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], 'USD', 'instant'],
    ['cash', 'us-gaap', ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], 'USD', 'instant'],
    ['longTermDebt', 'us-gaap', ['LongTermDebtNoncurrent', 'LongTermDebt'], 'USD', 'instant'],
    ['sharesOutstanding', 'dei', ['EntityCommonStockSharesOutstanding'], 'shares', 'instant'],
];

function summarizeConcept(units, kind) {
    const facts = units.filter((u) => u.form && /^(10-K|10-Q|20-F|40-F|10-K\/A|10-Q\/A)/.test(u.form));
    if (!facts.length) return null;
    const pick = (arr) => arr.sort((a, b) => (b.end.localeCompare(a.end)) || (b.filed || '').localeCompare(a.filed || ''))[0];
    const days = (u) => (u.start ? (new Date(u.end) - new Date(u.start)) / 86400000 : 0);
    let annual; let quarter; let priorAnnual;
    if (kind === 'duration') {
        const ann = facts.filter((u) => days(u) > 340 && days(u) < 380);
        const q = facts.filter((u) => days(u) > 80 && days(u) < 100);
        annual = ann.length ? pick([...ann]) : null;
        quarter = q.length ? pick([...q]) : null;
        if (annual) priorAnnual = pick(ann.filter((u) => u.end < annual.start || (new Date(annual.end) - new Date(u.end)) / 86400000 > 330)) || null;
    } else {
        const latest = pick([...facts]);
        quarter = latest;
        const ann = facts.filter((u) => /^(10-K|20-F|40-F)/.test(u.form) && u.fp === 'FY');
        annual = ann.length ? pick([...ann]) : null;
        if (annual) priorAnnual = pick(ann.filter((u) => (new Date(annual.end) - new Date(u.end)) / 86400000 > 330)) || null;
    }
    const fmt = (u) => (u ? { value: u.val, periodStart: u.start || null, periodEnd: u.end, fiscalYear: u.fy, fiscalPeriod: u.fp, form: u.form, filed: u.filed, accessionNumber: u.accn } : null);
    const growth = annual && priorAnnual && priorAnnual.val ? Math.round(((annual.val - priorAnnual.val) / Math.abs(priorAnnual.val)) * 10000) / 100 : null;
    return { latestAnnual: fmt(annual), priorAnnual: fmt(priorAnnual), annualGrowthPct: growth, latest: fmt(quarter) };
}

export async function snapshot(sec, id) {
    const who = await sec.resolve(id);
    const subs = await sec.submissions(who.cik);
    return sec.cached(`snap_v2:${who.cik}`, 6 * 3600, async () => {
        const metrics = {};
        // Fetch every candidate tag and keep the one with the most recent data (companies switch tags over time).
        await Promise.all(METRICS.map(async ([key, tax, tags, unit, kind]) => {
            const found = await Promise.all(tags.map(async (tag) => {
                const d = await sec.json(`https://data.sec.gov/api/xbrl/companyconcept/CIK${who.cik}/${tax}/${tag}.json`);
                const units = d?.units?.[unit];
                const s = units?.length ? summarizeConcept(units, kind) : null;
                return s ? { tag: `${tax}:${tag}`, unit, ...s } : null;
            }));
            const end = (x) => x?.latest?.periodEnd || x?.latestAnnual?.periodEnd || '';
            metrics[key] = found.filter(Boolean).sort((a, b) => end(b).localeCompare(end(a)))[0] || null;
        }));
        const v = (k) => metrics[k]?.latestAnnual?.value ?? null;
        const ratios = {
            netMarginPct: v('revenue') && v('netIncome') != null ? Math.round((v('netIncome') / v('revenue')) * 10000) / 100 : null,
            grossMarginPct: v('revenue') && v('grossProfit') != null ? Math.round((v('grossProfit') / v('revenue')) * 10000) / 100 : null,
            debtToEquity: v('stockholdersEquity') && v('totalLiabilities') != null ? Math.round((v('totalLiabilities') / v('stockholdersEquity')) * 100) / 100 : null,
        };
        return {
            company: { cik: who.cik, ticker: who.ticker || subs.tickers[0] || null, name: subs.name, sic: subs.sic, sicDescription: subs.sicDescription, fiscalYearEnd: subs.fiscalYearEnd, exchanges: subs.exchanges },
            metrics, ratios,
            source: 'SEC XBRL companyconcept API (data.sec.gov). Values as reported in 10-K/10-Q (or 20-F/40-F) filings.',
        };
    }, { kv: true });
}

export async function rawFacts(sec, id) {
    const who = await sec.resolve(id);
    // Stream the (multi-MB) JSON straight through: no parsing, so it fits the Free plan CPU limit.
    const r = await sec.raw(`https://data.sec.gov/api/xbrl/companyfacts/CIK${who.cik}.json`, { accept: 'application/json' });
    if (!r) throw new SecError(404, `No XBRL company facts for CIK ${who.cik}`);
    return new Response(r.body, { headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=21600' } });
}

export async function concept(sec, id, taxonomy, tag) {
    const who = await sec.resolve(id);
    if (!/^[\w-]+$/.test(taxonomy) || !/^[\w-]+$/.test(tag)) throw new SecError(400, 'Invalid taxonomy or tag.');
    return sec.cached(`concept_v1:${who.cik}:${taxonomy}:${tag}`, 6 * 3600, async () => {
        const d = await sec.json(`https://data.sec.gov/api/xbrl/companyconcept/CIK${who.cik}/${taxonomy}/${tag}.json`);
        if (!d) throw new SecError(404, `No ${taxonomy}:${tag} facts for CIK ${who.cik}`);
        return d;
    });
}

// ---------------- full-text search ----------------
export async function search(sec, sp) {
    const q = (sp.get('q') || '').trim();
    if (!q) throw new SecError(400, 'Parameter "q" is required (EDGAR full-text search syntax; use quotes for phrases).');
    const forms = listParam(sp, 'forms').join(',');
    const startdt = dateParam(sp, 'startdt') || daysAgo(365);
    const enddt = dateParam(sp, 'enddt') || isoDay(new Date());
    const from = intParam(sp, 'from', 0, 0, 9900);
    const ciks = (sp.get('ciks') || '').split(',').map((c) => c.trim()).filter(Boolean).map(padCik).join(',');
    const qs = new URLSearchParams({ q, dateRange: 'custom', startdt, enddt, from: String(from) });
    if (forms) qs.set('forms', forms);
    if (ciks) qs.set('ciks', ciks);
    return sec.cached(`efts_v1:${qs}`, 900, async () => {
        const d = await sec.json(`https://efts.sec.gov/LATEST/search-index?${qs}`);
        const hits = (d?.hits?.hits || []).map((h) => {
            const [adsh, file] = String(h._id).split(':');
            const s = h._source || {};
            const cik = (s.ciks || [])[0];
            return {
                accessionNumber: adsh, form: s.form, fileType: s.file_type || null, fileDescription: s.file_description || null, filingDate: s.file_date,
                periodEnding: s.period_ending || null, companies: s.display_names || [], ciks: s.ciks || [], items: s.items || [], locations: s.biz_locations || [],
                documentUrl: cik && file ? `${archiveBase(cik, adsh)}/${file}` : null, score: h._score,
            };
        });
        return { query: { q, forms: forms || null, startdt, enddt, from }, total: d?.hits?.total?.value ?? hits.length, returned: hits.length, nextFrom: from + hits.length < (d?.hits?.total?.value || 0) ? from + 100 : null, hits };
    });
}

/**
 * Map a REST path to its endpoint. Returns a JSON-serializable body, a Response (raw facts stream),
 * or null for an unknown path. Shared by the REST router and the MCP tools.
 */
export async function dispatch(sec, env, p, sp) {
    let m;
    if ((m = p.match(/^\/v1\/insider-trades\/([^/]+)$/))) return insiderTrades(sec, decodeURIComponent(m[1]), sp);
    if (p === '/v1/insider-buys') return insiderBuys(sec, env, sp);
    if ((m = p.match(/^\/v1\/filings\/([^/]+)$/))) return filings(sec, decodeURIComponent(m[1]), sp);
    if ((m = p.match(/^\/v1\/company\/([^/]+)\/snapshot$/))) return snapshot(sec, decodeURIComponent(m[1]));
    if ((m = p.match(/^\/v1\/company\/([^/]+)\/facts$/))) return rawFacts(sec, decodeURIComponent(m[1]));
    if ((m = p.match(/^\/v1\/company\/([^/]+)\/concept\/([^/]+)\/([^/]+)$/))) return concept(sec, decodeURIComponent(m[1]), m[2], m[3]);
    if (p === '/v1/search') return search(sec, sp);
    if ((m = p.match(/^\/v1\/resolve\/([^/]+)$/))) return sec.resolve(decodeURIComponent(m[1]));
    return null;
}
