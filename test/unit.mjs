// Offline unit tests for the Form 4 parser (uses a real Form 4 saved from EDGAR).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseForm4, flatten, padCik } from '../src/form4.js';

const xml = readFileSync(new URL('./sample_form4.xml', import.meta.url), 'utf8');
const f = parseForm4(xml, { accessionNumber: '0002135904-26-000006', filingDate: '2026-10-19' });
assert.equal(f.issuer.ticker, 'BOSC');
assert.equal(f.issuer.cik, '0001005516');
assert.equal(f.insider.name, 'Cohen Eyal');
assert.ok(f.insider.isDirector && f.insider.isOfficer);
const rows = flatten(f);
assert.ok(rows.length >= 1);
for (const r of rows) {
    assert.match(r.transactionCode, /^[A-Z]$/);
    if (r.shares != null && r.pricePerShare != null) assert.equal(r.totalValue, Math.round(r.shares * r.pricePerShare * 100) / 100);
}
assert.equal(padCik('320193'), '0000320193');
// .txt full-submission wrapper is also accepted
assert.ok(parseForm4(`<SEC-DOCUMENT>\n<XML>\n${xml}\n</XML>`, {}).transactions.length === f.transactions.length);
assert.equal(parseForm4('<html>not a form 4</html>'), null);
console.log(`unit tests passed (${rows.length} transactions parsed)`);
