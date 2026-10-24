// MCP tool catalog for the SEC EDGAR API. Pure JavaScript with no Worker or Node dependencies,
// so the Worker (/mcp) and the stdio npm package (packages/sec-edgar-mcp) share one copy.
//
// Each tool maps to one REST endpoint: `request(args)` returns { path, query } and `compact(data, args)`
// shrinks the REST JSON into a small, agent-friendly result (fewer fields, capped rows).

export const SERVER_INFO = { name: 'sec-edgar-mcp', title: 'SEC EDGAR Insider Trades & Financials', version: '1.0.0' };

export const INSTRUCTIONS = 'U.S. SEC EDGAR data: Form 4 insider trades, market-wide insider buying/cluster buys, filings, XBRL financials and full-text search. '
    + 'Pass a ticker (AAPL) or a CIK (320193) as ticker_or_cik. Results are compact JSON; follow documentUrl/filingUrl links for full documents. '
    + 'Data comes from SEC EDGAR (public domain). Not investment advice.';

const ID = { type: 'string', description: 'Stock ticker (e.g. "AAPL", "BRK.B") or SEC CIK number (e.g. "320193").', minLength: 1, maxLength: 12 };
const DATE = (d) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `${d} (YYYY-MM-DD).` });
const FORMS = (d) => ({ type: 'array', items: { type: 'string', maxLength: 12 }, maxItems: 15, description: d });
const int = (min, max, def, d) => ({ type: 'integer', minimum: min, maximum: max, default: def, description: d });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const clamp = (v, min, max, def) => {
    const n = Number(v);
    return v == null || v === '' || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, Math.floor(n)));
};
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((s) => String(s).trim()).filter(Boolean).join(',');
const enc = encodeURIComponent;
const need = (v, name) => {
    const s = v == null ? '' : String(v).trim();
    if (!s) throw new ToolInputError(`"${name}" is required.`);
    return s;
};
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
// Drop null/undefined/false-y empty values to keep payloads small.
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));

export class ToolInputError extends Error {}

export const TOOLS = [
    {
        name: 'get_insider_trades',
        title: 'Insider trades (Form 4) for a company or insider',
        description: 'Recent SEC Form 4 insider transactions for one company (ticker or issuer CIK) or one insider (reporting-owner CIK). '
            + 'Returns a summary (open-market buy/sell counts, shares, dollar value, distinct insiders) and one row per transaction: date, insider, role, '
            + 'transaction code (P=open-market buy, S=sale, A=award, M=option exercise, F=tax withholding, G=gift), shares, price, value, shares owned after, 10b5-1 flag and filing link. '
            + 'Use side="buy" to see only open-market purchases.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker_or_cik: ID,
                side: { type: 'string', enum: ['buy', 'sell'], description: 'Only open-market purchases (buy, code P) or sales (sell, code S).' },
                codes: FORMS('Only these transaction codes, e.g. ["P","S"] or ["M","F"].'),
                since: DATE('Only filings on or after this date'),
                filings: int(1, 25, 5, 'How many of the most recent Form 4 filings to parse (each costs one SEC request). Default 5.'),
                include_derivative: { type: 'boolean', default: false, description: 'Include derivative (option/RSU) transactions. Default false.' },
                max_rows: int(1, 100, 25, 'Maximum transaction rows to return. Default 25.'),
            },
            required: ['ticker_or_cik'],
            additionalProperties: false,
        },
        request: (a) => ({
            path: `/v1/insider-trades/${enc(need(a.ticker_or_cik, 'ticker_or_cik'))}`,
            query: prune({ limit: clamp(a.filings, 1, 25, 5), side: a.side, codes: list(a.codes), since: a.since, includeDerivative: a.include_derivative ? 'true' : 'false' }),
        }),
        compact: (d, a) => {
            const max = clamp(a.max_rows, 1, 100, 25);
            const s = d.summary || {};
            return {
                company: prune(d.query || {}),
                filingsParsed: d.filingsParsed,
                summary: prune({ transactions: s.transactions, openMarketBuys: s.openMarketBuys, buyShares: s.openMarketBuyShares, buyValueUsd: s.openMarketBuyValue, openMarketSells: s.openMarketSells, sellShares: s.openMarketSellShares, sellValueUsd: s.openMarketSellValue, distinctInsiders: s.distinctInsiders }),
                returned: Math.min(max, (d.transactions || []).length),
                transactions: (d.transactions || []).slice(0, max).map((t) => prune({
                    date: t.transactionDate, insider: t.insiderName, role: t.insiderRole, code: t.transactionCode, shares: t.shares, price: t.pricePerShare,
                    valueUsd: t.totalValue, ownedAfter: t.sharesOwnedAfter, derivative: t.isDerivative || undefined, plan10b51: t.is10b51Plan || undefined,
                    ticker: t.ticker, filed: t.filingDate, url: t.filingUrl,
                })),
            };
        },
    },
    {
        name: 'get_market_insider_buys',
        title: 'Market-wide insider buying and cluster buys',
        description: 'Recent open-market insider purchases (Form 4 code P) across all U.S. public companies, grouped by issuer and ranked by number of buying insiders, then dollar value. '
            + 'A "cluster buy" is 2+ insiders buying the same stock. Filter by look-back days, minimum total value, minimum insiders and role. '
            + 'Data is built from a rolling scan of recent EDGAR Form 4 filings (coverage starts at deployment, up to 30 days).',
        inputSchema: {
            type: 'object',
            properties: {
                days: int(1, 30, 7, 'Look-back window in days. Default 7.'),
                min_value: { type: 'number', minimum: 0, description: 'Minimum total purchase value per issuer in USD, e.g. 100000.' },
                min_insiders: int(1, 20, 1, 'Minimum distinct buying insiders per issuer; use 2 for cluster buys only. Default 1.'),
                role: { type: 'string', enum: ['officer', 'director', 'tenpercent'], description: 'Only purchases by officers, directors or 10% owners.' },
                limit: int(1, 50, 10, 'Maximum issuers to return. Default 10.'),
            },
            additionalProperties: false,
        },
        request: (a) => ({
            path: '/v1/insider-buys',
            query: prune({ days: clamp(a.days, 1, 30, 7), minValue: a.min_value != null ? Math.max(0, Math.floor(Number(a.min_value) || 0)) : undefined, minInsiders: clamp(a.min_insiders, 1, 20, 1), role: a.role, limit: clamp(a.limit, 1, 50, 10) }),
        }),
        compact: (d) => ({
            window: d.window,
            dataUpdatedAt: d.dataUpdatedAt,
            issuers: d.issuers,
            clusterBuys: d.clusterBuys,
            results: (d.results || []).map((c) => prune({
                ticker: c.ticker, issuer: c.issuerName, cik: c.issuerCik, insiderCount: c.insiderCount, clusterBuy: c.isClusterBuy,
                totalValueUsd: c.totalValue, totalShares: c.totalShares, avgPrice: c.avgPrice, firstDate: c.firstTransactionDate, lastDate: c.lastTransactionDate,
                insiders: (c.insiders || []).slice(0, 5).map((i) => prune({ name: i.name, role: i.role, valueUsd: r2(i.value) })),
                latestFilingUrl: (c.transactions || []).map((t) => t.filingUrl).filter(Boolean).pop(),
            })),
            note: 'Open-market, non-derivative purchases only. Not investment advice.',
        }),
    },
    {
        name: 'get_company_filings',
        title: 'Company SEC filings list',
        description: 'Latest SEC filings for a company (10-K, 10-Q, 8-K with item numbers, S-1, DEF 14A, 4, 13D/G...), newest first, with filing date, report period, '
            + 'description and direct document URL. Filter by form types and a date range.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker_or_cik: ID,
                forms: FORMS('Only these form types, e.g. ["10-K","10-Q","8-K"]. Amendments (/A) are included.'),
                since: DATE('Only filings on or after this date'),
                until: DATE('Only filings on or before this date'),
                limit: int(1, 50, 10, 'Maximum filings to return. Default 10.'),
            },
            required: ['ticker_or_cik'],
            additionalProperties: false,
        },
        request: (a) => ({
            path: `/v1/filings/${enc(need(a.ticker_or_cik, 'ticker_or_cik'))}`,
            query: prune({ forms: list(a.forms), since: a.since, until: a.until, limit: clamp(a.limit, 1, 50, 10) }),
        }),
        compact: (d) => {
            const c = d.company || {};
            return {
                company: prune({ name: c.name, cik: c.cik, ticker: c.ticker, exchanges: [...new Set(c.exchanges || [])], industry: c.sicDescription, fiscalYearEnd: c.fiscalYearEnd }),
                count: d.count,
                filings: (d.filings || []).map((f) => prune({ form: f.form, filed: f.filingDate, period: f.reportDate, items: f.items, description: f.description, accession: f.accessionNumber, url: f.documentUrl })),
            };
        },
    },
    {
        name: 'get_company_snapshot',
        title: 'Company financial snapshot (XBRL)',
        description: 'Key financials from a company\'s 10-K/10-Q XBRL data: revenue, gross profit, operating income, net income, diluted EPS, operating cash flow, '
            + 'total assets, liabilities, equity, cash, long-term debt and shares outstanding. Each metric has the latest annual value, prior annual value, '
            + 'YoY growth % and the latest reported period, plus net margin, gross margin and debt-to-equity. Values in USD as reported.',
        inputSchema: { type: 'object', properties: { ticker_or_cik: ID }, required: ['ticker_or_cik'], additionalProperties: false },
        request: (a) => ({ path: `/v1/company/${enc(need(a.ticker_or_cik, 'ticker_or_cik'))}/snapshot`, query: {} }),
        compact: (d) => {
            const metrics = {};
            for (const [k, m] of Object.entries(d.metrics || {})) {
                if (!m) { metrics[k] = null; continue; }
                metrics[k] = prune({
                    annual: m.latestAnnual?.value, fy: m.latestAnnual?.fiscalYear, periodEnd: m.latestAnnual?.periodEnd,
                    priorAnnual: m.priorAnnual?.value, growthPct: m.annualGrowthPct,
                    latest: m.latest?.value, latestPeriodEnd: m.latest?.periodEnd, latestPeriod: m.latest ? `${m.latest.fiscalYear ?? ''} ${m.latest.fiscalPeriod ?? ''}`.trim() : null,
                    unit: m.unit, tag: m.tag,
                });
            }
            const c = d.company || {};
            return { company: prune({ name: c.name, cik: c.cik, ticker: c.ticker, industry: c.sicDescription, fiscalYearEnd: c.fiscalYearEnd, exchanges: [...new Set(c.exchanges || [])] }), metrics, ratios: d.ratios };
        },
    },
    {
        name: 'get_company_concept',
        title: 'Historical values of one XBRL financial concept',
        description: 'Time series of a single XBRL concept for a company, from SEC companyconcept data, newest first and de-duplicated by period. '
            + 'Examples: us-gaap NetIncomeLoss, Revenues, RevenueFromContractWithCustomerExcludingAssessedTax, Assets, EarningsPerShareDiluted, '
            + 'LongTermDebt, ResearchAndDevelopmentExpense; dei EntityCommonStockSharesOutstanding. Use period="annual" for fiscal years (10-K) or "quarterly" for 3-month periods.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker_or_cik: ID,
                concept: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'XBRL tag name, e.g. "NetIncomeLoss".' },
                taxonomy: { type: 'string', enum: ['us-gaap', 'dei', 'ifrs-full', 'srt'], default: 'us-gaap', description: 'XBRL taxonomy. Default us-gaap (ifrs-full for IFRS filers).' },
                unit: { type: 'string', description: 'Unit to return, e.g. "USD", "USD/shares", "shares". Default: the first unit reported.' },
                period: { type: 'string', enum: ['annual', 'quarterly', 'all'], default: 'annual', description: 'Which periods to return. Default annual.' },
                limit: int(1, 40, 10, 'Maximum data points to return. Default 10.'),
            },
            required: ['ticker_or_cik', 'concept'],
            additionalProperties: false,
        },
        request: (a) => {
            const tag = need(a.concept, 'concept');
            const tax = a.taxonomy || 'us-gaap';
            if (!/^[\w-]+$/.test(tag) || !/^[\w-]+$/.test(tax)) throw new ToolInputError('Invalid taxonomy or concept.');
            return { path: `/v1/company/${enc(need(a.ticker_or_cik, 'ticker_or_cik'))}/concept/${tax}/${tag}`, query: {} };
        },
        compact: (d, a) => {
            const units = d.units || {};
            const unitNames = Object.keys(units);
            const unit = a.unit && units[a.unit] ? a.unit : unitNames[0];
            const period = a.period || 'annual';
            const max = clamp(a.limit, 1, 40, 10);
            const days = (u) => (u.start ? (Date.parse(u.end) - Date.parse(u.start)) / 86400000 : 0);
            let facts = (units[unit] || []).filter((u) => u.form && /^(10-K|10-Q|20-F|40-F|8-K|6-K)/.test(u.form));
            if (period === 'annual') facts = facts.filter((u) => !u.start || (days(u) > 340 && days(u) < 380));
            if (period === 'quarterly') facts = facts.filter((u) => !u.start || (days(u) > 80 && days(u) < 100));
            // One value per period: keep the latest filing for each (start, end) pair.
            const byPeriod = new Map();
            for (const u of facts) {
                const k = `${u.start || ''}|${u.end}`;
                const prev = byPeriod.get(k);
                if (!prev || (u.filed || '') > (prev.filed || '')) byPeriod.set(k, u);
            }
            const rows = [...byPeriod.values()].sort((x, y) => y.end.localeCompare(x.end) || (y.start || '').localeCompare(x.start || ''));
            return {
                company: prune({ name: d.entityName, cik: d.cik != null ? String(d.cik).padStart(10, '0') : null }),
                concept: `${d.taxonomy}:${d.tag}`, label: d.label, unit, availableUnits: unitNames, period,
                totalPeriods: rows.length,
                values: rows.slice(0, max).map((u) => prune({ value: u.val, start: u.start, end: u.end, fy: u.fy, fp: u.fp, form: u.form, filed: u.filed })),
            };
        },
    },
    {
        name: 'search_filings',
        title: 'EDGAR full-text search',
        description: 'Full-text search across SEC filings since 2001 (EDGAR FTS). Supports quoted phrases ("share repurchase"), boolean OR, and filters for form types, '
            + 'date range and company CIKs. Returns matching filings with company, form, filing date, 8-K items and a document URL. Default range: last 365 days.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', minLength: 1, maxLength: 500, description: 'Search text. Use double quotes for exact phrases, e.g. "going concern".' },
                forms: FORMS('Only these form types, e.g. ["8-K"] or ["10-K","10-Q"].'),
                start_date: DATE('Earliest filing date. Default 365 days ago'),
                end_date: DATE('Latest filing date. Default today'),
                ciks: { type: 'array', items: { type: 'string', pattern: '^\\d{1,10}$' }, maxItems: 10, description: 'Only filings by these company CIKs (use resolve_company to get a CIK from a ticker).' },
                offset: int(0, 9900, 0, 'Result offset for paging (EDGAR returns pages of 100). Default 0.'),
                limit: int(1, 50, 10, 'Maximum hits to return. Default 10.'),
            },
            required: ['query'],
            additionalProperties: false,
        },
        request: (a) => ({
            path: '/v1/search',
            query: prune({ q: need(a.query, 'query'), forms: list(a.forms), startdt: a.start_date, enddt: a.end_date, ciks: list(a.ciks), from: a.offset ? clamp(a.offset, 0, 9900, 0) : undefined }),
        }),
        compact: (d, a) => {
            const max = clamp(a.limit, 1, 50, 10);
            return {
                query: prune(d.query || {}), total: d.total, returned: Math.min(max, (d.hits || []).length), nextOffset: d.nextFrom,
                hits: (d.hits || []).slice(0, max).map((h) => prune({ form: h.form, filed: h.filingDate, companies: (h.companies || []).slice(0, 3), period: h.periodEnding, items: h.items, description: h.fileDescription, accession: h.accessionNumber, url: h.documentUrl })),
            };
        },
    },
    {
        name: 'resolve_company',
        title: 'Resolve ticker or CIK',
        description: 'Convert a stock ticker to its SEC CIK and company name, or a CIK to its ticker and name. Use it to get the CIK needed by search_filings.',
        inputSchema: { type: 'object', properties: { ticker_or_cik: ID }, required: ['ticker_or_cik'], additionalProperties: false },
        request: (a) => ({ path: `/v1/resolve/${enc(need(a.ticker_or_cik, 'ticker_or_cik'))}`, query: {} }),
        compact: (d) => d,
    },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool list in MCP `tools/list` shape. */
export const toolList = () => TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: { title, ...READ_ONLY } }));

/**
 * Run a tool through a backend `(path, query) => Promise<json>` that throws errors with
 * `.status` and `.message`. Returns an MCP CallToolResult with compact JSON text.
 */
export async function runTool(name, args, backend) {
    const tool = TOOL_MAP.get(name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    try {
        const a = args || {};
        const { path, query } = tool.request(a);
        const data = await backend(path, query);
        return { content: [{ type: 'text', text: JSON.stringify(tool.compact(data, a)) }] };
    } catch (e) {
        const status = e?.status ? ` (HTTP ${e.status})` : '';
        return { isError: true, content: [{ type: 'text', text: `Error${status}: ${e?.message || e}` }] };
    }
}

/** Static server card (served at /.well-known/mcp/server-card.json for registries that cannot scan). */
export const serverCardFor = (authRequired) => ({
    serverInfo: { name: SERVER_INFO.name, title: SERVER_INFO.title, version: SERVER_INFO.version },
    authentication: { required: !!authRequired, schemes: authRequired ? ['bearer', 'x-api-key'] : [] },
    tools: toolList(),
    resources: [],
    prompts: [],
});
