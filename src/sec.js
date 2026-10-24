// SEC EDGAR access layer: declared User-Agent, global <=10 req/s pacing (Durable Object token
// reservation when bound, per-request pacing always), and layered caching
// (isolate memory -> Cache API -> KV for selected keys).
import { padCik } from './form4.js';

const MIN_SPACING_MS = 115; // <=8.7 req/s per caller; the Durable Object limiter enforces the global ceiling
const SLOT_BLOCK = 5; // slots reserved per limiter call (keeps limiter subrequests low)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mem = new Map(); // isolate-local cache: key -> { exp, val }

export class SecError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export function userAgent(env) {
    return env.SEC_USER_AGENT || 'MonRiah Studio SEC EDGAR API kidriahx@gmail.com';
}

/** Per-request client. Tracks subrequests (Workers Free allows 50 per invocation). */
export class Sec {
    constructor(env, ctx) {
        this.env = env; this.ctx = ctx;
        this.lastAt = 0; this.slotsLeft = 0; this.paceChain = Promise.resolve(); this.subrequests = 0; this.secCalls = 0; this.cacheHits = 0;
        this.maxSubrequests = Number(env.MAX_SUBREQUESTS || 45);
    }

    budgetLeft() { return this.maxSubrequests - this.subrequests; }

    // Serialize pacing so parallel fetches in one request share reserved slots instead of racing.
    pace() {
        const run = this.paceChain.then(() => this.paceInner());
        this.paceChain = run.catch(() => {});
        return run;
    }

    async paceInner() {
        // Global limiter: reserve one slot in the shared Durable Object (if configured).
        if (this.env.SEC_LIMITER && this.slotsLeft <= 0 && this.budgetLeft() > 1) {
            try {
                this.subrequests++;
                const stub = this.env.SEC_LIMITER.get(this.env.SEC_LIMITER.idFromName('global'));
                const r = await stub.fetch(`https://limiter/acquire?n=${SLOT_BLOCK}`);
                const { waitMs } = await r.json();
                if (waitMs > 0) await sleep(Math.min(waitMs, 5000));
                this.lastAt = 0;
            } catch { /* limiter unavailable: fall back to local pacing */ }
            this.slotsLeft = SLOT_BLOCK;
        }
        this.slotsLeft--;
        const wait = this.lastAt + MIN_SPACING_MS - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastAt = Date.now();
    }

    async cached(key, ttlSec, producer, { kv = false } = {}) {
        const now = Date.now();
        const m = mem.get(key);
        if (m && m.exp > now) { this.cacheHits++; return m.val; }
        const cacheKey = new Request(`https://cache.sec-edgar-api.internal/${encodeURIComponent(key)}`);
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        if (cache) {
            try {
                const hit = await cache.match(cacheKey);
                if (hit) { const val = await hit.json(); mem.set(key, { exp: now + ttlSec * 1000, val }); this.cacheHits++; return val; }
            } catch { /* ignore */ }
        }
        if (kv && this.env.CACHE) {
            try {
                const val = await this.env.CACHE.get(key, 'json');
                if (val !== null) { mem.set(key, { exp: now + ttlSec * 1000, val }); this.cacheHits++; return val; }
            } catch { /* ignore */ }
        }
        const val = await producer();
        if (mem.size > 500) mem.delete(mem.keys().next().value);
        mem.set(key, { exp: now + ttlSec * 1000, val });
        const body = JSON.stringify(val);
        const writes = [];
        if (cache) writes.push(cache.put(cacheKey, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttlSec}` } })).catch(() => {}));
        // KV free tier: 1,000 writes/day. Only selected keys use KV; failures (quota) are ignored.
        if (kv && this.env.CACHE && body.length < 20_000_000) writes.push(this.env.CACHE.put(key, body, { expirationTtl: Math.max(60, ttlSec) }).catch(() => {}));
        if (writes.length) this.ctx?.waitUntil ? this.ctx.waitUntil(Promise.all(writes)) : await Promise.all(writes);
        return val;
    }

    async raw(url, { accept = '*/*', allow404 = true } = {}) {
        for (let i = 0; i < 3; i++) {
            if (this.budgetLeft() <= 0) throw new SecError(503, 'Subrequest budget for this request exhausted; narrow the query (lower limit).');
            await this.pace();
            this.subrequests++; this.secCalls++;
            const r = await fetch(url, { headers: { 'user-agent': userAgent(this.env), accept, 'accept-encoding': 'gzip, deflate' } });
            if (r.status === 404 && allow404) return null;
            if (r.status === 429 || r.status === 503 || r.status >= 500) {
                const ra = Number(r.headers.get('retry-after'));
                await sleep(ra ? Math.min(ra * 1000, 5000) : 800 * 2 ** i);
                continue;
            }
            // SEC's edge (notably efts.sec.gov) sometimes returns a transient 403; retry once after a pause.
            if (r.status === 403 && i === 0) { await sleep(1500); continue; }
            if (r.status === 403) throw new SecError(502, `SEC refused the request (403) for ${url}. Check SEC_USER_AGENT and request rate.`);
            if (!r.ok) throw new SecError(502, `SEC returned HTTP ${r.status} for ${url}`);
            return r;
        }
        throw new SecError(503, `SEC is rate limiting or unavailable for ${url}; retry shortly.`);
    }

    async json(url) { const r = await this.raw(url, { accept: 'application/json' }); return r ? r.json() : null; }
    async text(url) { const r = await this.raw(url); return r ? r.text() : null; }

    // ---------- ticker / CIK resolution ----------
    async tickerFile() {
        // ~1 MB text; resolved by regex (no full JSON.parse) to stay inside the 10 ms CPU budget.
        return this.cached('company_tickers_v1', 86400, async () => this.text('https://www.sec.gov/files/company_tickers.json'), { kv: true });
    }

    async resolve(idRaw) {
        const id = String(idRaw || '').trim().toUpperCase().replace(/^\$/, '');
        if (!id) throw new SecError(400, 'Missing ticker or CIK.');
        return this.cached(`resolve_v1:${id}`, 86400, async () => {
            const txt = await this.tickerFile();
            if (/^\d{1,10}$/.test(id)) {
                const n = String(Number(id));
                const m = txt.match(new RegExp(`"cik_str":${n},"ticker":"([^"]*)","title":"((?:[^"\\\\]|\\\\.)*)"`));
                return { cik: padCik(id), ticker: m ? m[1] : null, name: m ? JSON.parse(`"${m[2]}"`) : null };
            }
            if (!/^[A-Z0-9.\-]{1,10}$/.test(id)) throw new SecError(400, `Invalid ticker: ${idRaw}`);
            const esc = id.replace(/[.\-]/g, (c) => `\\${c}`);
            const m = txt.match(new RegExp(`"cik_str":(\\d+),"ticker":"${esc}","title":"((?:[^"\\\\]|\\\\.)*)"`))
                || (id.includes('.') ? txt.match(new RegExp(`"cik_str":(\\d+),"ticker":"${id.replace('.', '-')}","title":"((?:[^"\\\\]|\\\\.)*)"`)) : null);
            if (!m) throw new SecError(404, `Ticker not found in SEC company_tickers.json: ${id}`);
            return { cik: padCik(m[1]), ticker: id, name: JSON.parse(`"${m[2]}"`) };
        });
    }

    async submissions(cik) {
        return this.cached(`subs_v1:${cik}`, 600, async () => {
            const d = await this.json(`https://data.sec.gov/submissions/CIK${cik}.json`);
            if (!d) throw new SecError(404, `No EDGAR submissions for CIK ${cik}`);
            const r = d.filings?.recent || {};
            // Keep a compact copy (drops unused columns) for caching.
            return {
                cik, name: d.name, tickers: d.tickers || [], exchanges: d.exchanges || [], sic: d.sic, sicDescription: d.sicDescription,
                entityType: d.entityType, fiscalYearEnd: d.fiscalYearEnd, stateOfIncorporation: d.stateOfIncorporation, website: d.website || null,
                ein: d.ein || null, category: d.category || null, phone: d.phone || null, businessAddress: d.addresses?.business || null,
                insiderTransactionForIssuerExists: !!d.insiderTransactionForIssuerExists, insiderTransactionForOwnerExists: !!d.insiderTransactionForOwnerExists,
                recent: {
                    accessionNumber: r.accessionNumber || [], filingDate: r.filingDate || [], reportDate: r.reportDate || [], acceptanceDateTime: r.acceptanceDateTime || [],
                    form: r.form || [], items: r.items || [], size: r.size || [], primaryDocument: r.primaryDocument || [], primaryDocDescription: r.primaryDocDescription || [],
                },
                olderFilingFiles: (d.filings?.files || []).map((f) => f.name),
            };
        });
    }
}

export function archiveBase(cik, accession) {
    return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accession.replace(/-/g, '')}`;
}

export function form4XmlUrl(cik, accession, primaryDocument) {
    let doc = primaryDocument || 'form4.xml';
    if (/xslF345/i.test(doc)) doc = doc.split('/').pop();
    if (!/\.xml$/i.test(doc)) return `${archiveBase(cik, accession)}/${accession}.txt`;
    return `${archiveBase(cik, accession)}/${doc}`;
}

/** Durable Object: global token reservation so all isolates together stay under SEC's 10 req/s. */
export class SecRateLimiter {
    constructor(state) { this.state = state; this.next = 0; }
    async fetch(request) {
        const spacing = 115; // ~8.7 req/s global, under SEC's 10 req/s
        const n = Math.min(10, Math.max(1, Number(new URL(request.url).searchParams.get('n')) || 1));
        const now = Date.now();
        const slot = Math.max(now, this.next);
        this.next = slot + spacing * n;
        return new Response(JSON.stringify({ waitMs: slot - now }), { headers: { 'content-type': 'application/json' } });
    }
}
