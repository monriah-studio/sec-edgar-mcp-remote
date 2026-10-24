// Live smoke test of the agent-kit skill workflows against the public endpoint.
// No dependencies (Node 18+). Usage: node test/skills.mjs [endpoint]
const URL_ = process.argv[2] || 'https://sec-edgar-api.kidriahx.workers.dev/mcp';
let id = 0, failures = 0;

async function call(name, args) {
    const res = await fetch(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${name}: ${body.error.message}`);
    if (body.result.isError) throw new Error(`${name}: ${body.result.content?.[0]?.text}`);
    return JSON.parse(body.result.content[0].text);
}
function check(cond, msg) { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; }
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const bare = (tag) => tag.replace(/^[a-z-]+:/, '');

async function insiderBuyingScan() {
    console.log('\n[insider-buying-scan]');
    let m = await call('get_market_insider_buys', { days: 14, min_insiders: 2, limit: 10 });
    if (!m.results?.length) m = await call('get_market_insider_buys', { days: 30, min_insiders: 1, limit: 10 });
    check(Array.isArray(m.results) && m.results.length > 0, `market scan: ${m.results?.length} issuers, window ${JSON.stringify(m.window)}`);
    const top = m.results[0];
    console.log(`       top: ${top.ticker} ${top.insiderCount} insiders $${top.totalValueUsd}`);
    const t = await call('get_insider_trades', { ticker_or_cik: top.ticker || top.cik, side: 'buy', filings: 10, max_rows: 25 });
    check(t.summary && Array.isArray(t.transactions), `trades ${top.ticker}: ${t.transactions.length} buy rows, ${t.summary.openMarketBuys} open-market buys`);
    check(t.transactions.every((r) => r.code === 'P'), 'side=buy returns only code P');
    const f = await call('get_company_filings', { ticker_or_cik: top.ticker || top.cik, forms: ['8-K'], limit: 5 });
    check(Array.isArray(f.filings), `context 8-Ks: ${f.filings.length}`);
}

async function financialSnapshot(ticker) {
    console.log(`\n[company-financial-snapshot] ${ticker}`);
    const s = await call('get_company_snapshot', { ticker_or_cik: ticker });
    const revTag = s.metrics?.revenue?.tag;
    check(!!revTag, `snapshot revenue tag ${revTag}, FY ${s.metrics.revenue.fy} ${s.metrics.revenue.annual}`);
    const rev = await call('get_company_concept', { ticker_or_cik: ticker, concept: bare(revTag), period: 'annual', limit: 10 });
    // de-dup flow series: ~1-year periods, one per end, latest filed wins
    const byEnd = new Map();
    for (const v of rev.values) {
        const len = (Date.parse(v.end) - Date.parse(v.start)) / 864e5;
        if (len < 350 || len > 380) continue;
        const prev = byEnd.get(v.end);
        if (!prev || v.filed > prev.filed) byEnd.set(v.end, v);
    }
    const years = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
    check(years.length >= 3, `revenue: ${years.length} fiscal years (${years.map((y) => y.end).join(', ')})`);
    const fyMismatch = rev.values.filter((v) => String(v.fy) !== v.end.slice(0, 4)).length;
    console.log(`       rows whose fy != end year (why we label by end): ${fyMismatch}`);
    const ni = await call('get_company_concept', { ticker_or_cik: ticker, concept: bare(s.metrics.netIncome.tag), period: 'annual', limit: 10 });
    check(ni.values.length > 0, `net income rows: ${ni.values.length}`);
    const cashTag = bare(s.metrics.cash?.tag || 'us-gaap:CashAndCashEquivalentsAtCarryingValue');
    const cash = await call('get_company_concept', { ticker_or_cik: ticker, concept: cashTag, period: 'all', limit: 40 });
    const ends = new Set(years.map((y) => y.end));
    const fyCash = cash.values.filter((v) => ends.has(v.end));
    check(fyCash.length > 0, `cash (${cashTag}): ${cash.values.length} rows -> ${new Set(fyCash.map((v) => v.end)).size} matched fiscal year-ends`);
}

async function filingMonitor(watchlist) {
    console.log(`\n[filing-monitor] ${watchlist.join(', ')}`);
    for (const t of watchlist) {
        const f = await call('get_company_filings', { ticker_or_cik: t, forms: ['8-K'], since: daysAgo(120), limit: 10 });
        check(Array.isArray(f.filings), `${t}: ${f.filings.length} 8-Ks since ${daysAgo(120)}; items e.g. ${JSON.stringify(f.filings[0]?.items)}`);
        if (f.filings[0]?.items) check(typeof f.filings[0].items === 'string', 'get_company_filings items is a string');
    }
    const ciks = [];
    for (const t of watchlist) ciks.push((await call('resolve_company', { ticker_or_cik: t })).cik);
    const s = await call('search_filings', { query: '"share repurchase"', forms: ['8-K'], ciks, start_date: daysAgo(365), limit: 10 });
    check(Array.isArray(s.hits), `search_filings across ${ciks.join(',')}: ${s.hits.length} hits`);
    if (s.hits[0]?.items) check(Array.isArray(s.hits[0].items), 'search_filings items is an array');
}

async function earningsPrep(ticker) {
    console.log(`\n[earnings-prep] ${ticker}`);
    const f = await call('get_company_filings', { ticker_or_cik: ticker, forms: ['8-K', '10-Q', '10-K'], limit: 15 });
    const er = f.filings.find((x) => x.form === '8-K' && (x.items || '').split(',').includes('2.02'));
    check(!!er, `last earnings 8-K: ${er?.filed} ${er?.url}`);
    const periodic = f.filings.find((x) => x.form === '10-Q' || x.form === '10-K');
    check(!!periodic, `latest periodic: ${periodic?.form} period ${periodic?.period}`);
    const { cik } = await call('resolve_company', { ticker_or_cik: ticker });
    const s = await call('search_filings', { query: '"results of operations"', forms: ['8-K'], ciks: [cik], start_date: daysAgo(365), limit: 5 });
    check(s.hits.some((h) => (h.items || []).includes('2.02')), `full-text earnings hits: ${s.hits.length}`);
    const snap = await call('get_company_snapshot', { ticker_or_cik: ticker });
    check(!!snap.metrics.revenue.latest, `latest quarter revenue ${snap.metrics.revenue.latest} (${snap.metrics.revenue.latestPeriod} ${snap.metrics.revenue.latestPeriodEnd})`);
    const q = await call('get_company_concept', { ticker_or_cik: ticker, concept: bare(snap.metrics.revenue.tag), period: 'quarterly', limit: 12 });
    const quarters = new Map();
    for (const v of q.values) { const len = (Date.parse(v.end) - Date.parse(v.start)) / 864e5; if (len > 80 && len < 100) quarters.set(v.end, v); }
    check(quarters.size >= 4, `quarterly revenue: ${quarters.size} distinct ~90-day quarters`);
    const it = await call('get_insider_trades', { ticker_or_cik: ticker, filings: 15, max_rows: 30 });
    check(!!it.summary, `insiders: ${it.transactions.length} rows, ${it.summary.distinctInsiders} insiders, buys ${it.summary.openMarketBuys}, sells ${it.summary.openMarketSells}`);
}

try {
    await insiderBuyingScan();
    await financialSnapshot('AAPL');
    await financialSnapshot('NVDA');
    await filingMonitor(['NVDA', 'AAPL', 'MSFT']);
    await earningsPrep('AAPL');
} catch (e) { console.error('ERROR', e.message); failures++; }
console.log(failures ? `\n${failures} check(s) failed` : '\nall skill workflows passed');
process.exit(failures ? 1 : 0);
