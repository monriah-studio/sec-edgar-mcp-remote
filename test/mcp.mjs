// MCP client test: connects to /mcp over Streamable HTTP with the official SDK client, lists tools,
// calls every tool against live EDGAR, checks result shapes and payload size, saves results to test/responses/mcp_*.json.
// Usage: node test/mcp.mjs [baseUrl]   (default http://localhost:8787; set MCP_API_KEY when MCP_API_KEYS is enabled)
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');
const OUT = new URL('./responses/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const headers = process.env.MCP_API_KEY ? { authorization: `Bearer ${process.env.MCP_API_KEY}` } : {};
const MAX_BYTES = 12_000; // "compact" budget per tool result

const client = new Client({ name: 'sec-edgar-mcp-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers } }));
let failed = 0;

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = ['get_company_concept', 'get_company_filings', 'get_company_snapshot', 'get_insider_trades', 'get_market_insider_buys', 'resolve_company', 'search_filings'];
try {
    assert.deepEqual(names, expected);
    for (const t of tools) { assert.ok(t.description.length > 60, `${t.name} description`); assert.equal(t.inputSchema.type, 'object'); assert.equal(t.annotations?.readOnlyHint, true); }
    console.log(`PASS tools/list (${tools.length} tools: ${names.join(', ')})`);
} catch (e) { failed++; console.log(`FAIL tools/list: ${e.message}`); }

const cases = [
    ['resolve_company', { ticker_or_cik: 'AAPL' }, (d) => assert.equal(d.cik, '0000320193')],
    ['resolve_company', { ticker_or_cik: '789019' }, (d) => assert.equal(d.ticker, 'MSFT'), 'resolve_cik'],
    ['get_insider_trades', { ticker_or_cik: 'AAPL', filings: 5 }, (d) => { assert.ok(d.filingsParsed > 0); assert.ok(d.transactions.length <= 25); d.transactions.forEach((t) => { assert.ok(t.insider); assert.match(t.code, /^[A-Z]$/); }); }],
    ['get_insider_trades', { ticker_or_cik: 'TSLA', side: 'sell', filings: 8, max_rows: 10 }, (d) => { assert.ok(d.transactions.length <= 10); d.transactions.forEach((t) => assert.equal(t.code, 'S')); }, 'insider_trades_tsla_sells'],
    ['get_market_insider_buys', { days: 7, limit: 5 }, (d) => { assert.ok(Array.isArray(d.results)); assert.ok(d.results.length <= 5); d.results.forEach((c) => assert.ok(c.insiderCount >= 1)); }],
    ['get_market_insider_buys', { days: 30, min_insiders: 2 }, (d) => d.results.forEach((c) => assert.ok(c.insiderCount >= 2)), 'market_cluster_buys'],
    ['get_company_filings', { ticker_or_cik: 'MSFT', forms: ['10-K', '10-Q', '8-K'], limit: 5 }, (d) => { assert.ok(d.count > 0 && d.count <= 5); d.filings.forEach((f) => assert.match(f.form, /^(10-K|10-Q|8-K)/)); }],
    ['get_company_snapshot', { ticker_or_cik: 'AAPL' }, (d) => { assert.ok(d.metrics.revenue.annual > 0); assert.ok(d.metrics.netIncome.annual); assert.ok('netMarginPct' in d.ratios); }],
    ['get_company_concept', { ticker_or_cik: 'MSFT', concept: 'NetIncomeLoss' }, (d) => { assert.equal(d.concept, 'us-gaap:NetIncomeLoss'); assert.ok(d.values.length > 0 && d.values.length <= 10); assert.ok(d.values[0].end >= d.values[d.values.length - 1].end); }],
    ['get_company_concept', { ticker_or_cik: 'AAPL', concept: 'EarningsPerShareDiluted', unit: 'USD/shares', period: 'quarterly', limit: 4 }, (d) => { assert.equal(d.unit, 'USD/shares'); assert.ok(d.values.length <= 4); }, 'concept_quarterly_eps'],
    ['search_filings', { query: '"share repurchase"', forms: ['8-K'], limit: 5 }, (d) => { assert.ok(d.total > 0); assert.ok(d.hits.length <= 5); d.hits.forEach((h) => assert.match(h.form, /^8-K/)); }],
    ['resolve_company', { ticker_or_cik: 'ZZZZZZ' }, null, 'error_unknown_ticker'],
    ['get_insider_trades', {}, null, 'error_missing_arg'],
];

for (const [name, args, check, label = name] of cases) {
    const t0 = Date.now();
    try {
        const r = await client.callTool({ name, arguments: args });
        const text = r.content?.[0]?.text || '';
        if (check === null) {
            assert.equal(r.isError, true, 'expected isError');
            console.log(`PASS ${label} (isError: ${text.slice(0, 90)})`);
            continue;
        }
        assert.ok(!r.isError, text.slice(0, 300));
        const d = JSON.parse(text);
        check(d);
        assert.ok(text.length <= MAX_BYTES, `result too large: ${text.length} bytes`);
        writeFileSync(new URL(`mcp_${label}.json`, OUT), JSON.stringify(d, null, 2));
        console.log(`PASS ${label} (${Date.now() - t0} ms, ${text.length} bytes)`);
    } catch (e) {
        failed++;
        console.log(`FAIL ${label}: ${e.message}`);
    }
}
await client.close();
console.log(failed ? `${failed} FAILED` : 'ALL MCP TESTS PASSED');
process.exit(failed ? 1 : 0);
