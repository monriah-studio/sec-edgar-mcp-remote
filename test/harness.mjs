// Live test harness: runs each endpoint against a running worker (default: `npx wrangler dev` on :8787),
// checks the response shape, and saves real responses to test/responses/.
// Usage: node test/harness.mjs [baseUrl]
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8787';
const OUT = new URL('./responses/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const headers = process.env.RAPIDAPI_PROXY_SECRET ? { 'x-rapidapi-proxy-secret': process.env.RAPIDAPI_PROXY_SECRET } : {};

const cases = [
    ['health', '/health', 200, (d) => assert.equal(d.ok, true)],
    ['resolve_ticker', '/v1/resolve/AAPL', 200, (d) => assert.equal(d.cik, '0000320193')],
    ['resolve_cik', '/v1/resolve/789019', 200, (d) => assert.equal(d.ticker, 'MSFT')],
    ['insider_trades_aapl', '/v1/insider-trades/AAPL?limit=5', 200, (d) => { assert.ok(d.filingsParsed > 0); assert.ok(Array.isArray(d.transactions)); for (const t of d.transactions) { assert.ok(t.insiderName); assert.match(t.transactionCode, /^[A-Z]$/); } }],
    ['insider_trades_tsla_sells', '/v1/insider-trades/TSLA?side=sell&limit=8', 200, (d) => d.transactions.forEach((t) => assert.equal(t.transactionCode, 'S'))],
    ['insider_trades_by_insider_cik', '/v1/insider-trades/1214156?limit=3', 200, (d) => assert.ok(d.filingsParsed > 0)],
    ['insider_buys', '/v1/insider-buys?days=7', 200, (d) => { assert.ok(Array.isArray(d.results)); d.results.forEach((c) => c.transactions.forEach((t) => assert.equal(t.transactionCode, 'P'))); }],
    ['insider_cluster_buys', '/v1/insider-buys?days=30&minInsiders=2', 200, (d) => d.results.forEach((c) => assert.ok(c.insiderCount >= 2))],
    ['filings_msft', '/v1/filings/MSFT?forms=10-K,10-Q,8-K&limit=10', 200, (d) => { assert.ok(d.count > 0); d.filings.forEach((f) => assert.match(f.form, /^(10-K|10-Q|8-K)/)); }],
    ['snapshot_aapl', '/v1/company/AAPL/snapshot', 200, (d) => { assert.ok(d.metrics.revenue?.latestAnnual?.value > 0); assert.ok(d.metrics.netIncome?.latestAnnual); }],
    ['snapshot_jpm', '/v1/company/JPM/snapshot', 200, (d) => assert.ok(d.metrics.netIncome?.latestAnnual?.value > 0)],
    ['concept_msft_netincome', '/v1/company/MSFT/concept/us-gaap/NetIncomeLoss', 200, (d) => assert.equal(d.tag, 'NetIncomeLoss')],
    ['search_buyback_8k', '/v1/search?q=%22share%20repurchase%22&forms=8-K', 200, (d) => assert.ok(d.total > 0)],
    ['error_unknown_ticker', '/v1/resolve/ZZZZZZ', 404, (d) => assert.ok(d.error)],
    ['error_bad_param', '/v1/insider-trades/AAPL?limit=abc', 400, (d) => assert.ok(d.error)],
];

let failed = 0;
for (const [name, path, status, check] of cases) {
    const t0 = Date.now();
    try {
        const r = await fetch(BASE + path, { headers });
        const d = await r.json();
        assert.equal(r.status, status, `HTTP ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
        check(d);
        writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(d, null, 2));
        console.log(`PASS ${name} (${Date.now() - t0} ms, sec=${r.headers.get('x-sec-requests') ?? '-'}, cacheHits=${r.headers.get('x-cache-hits') ?? '-'})`);
    } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${e.message}`);
    }
}
// Raw company facts is large: just check it streams valid JSON.
const r = await fetch(`${BASE}/v1/company/AAPL/facts`, { headers });
const facts = await r.json();
if (r.status === 200 && facts.entityName) console.log(`PASS company_facts_raw (${Object.keys(facts.facts).join(', ')})`); else { failed++; console.log('FAIL company_facts_raw'); }
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
