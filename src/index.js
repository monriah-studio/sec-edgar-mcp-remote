import { Sec, SecError, SecRateLimiter } from './sec.js';
import { JSON_HEADERS, json, err, dispatch, scanMarket, loadStore, saveStore } from './api.js';
// MCP (SDK + zod) is imported statically on purpose: its ~50 ms one-time init runs in global scope at isolate
// startup (1 s startup limit) instead of inside the first /mcp request (10 ms CPU limit on Workers Free).
import { handleMcp, serverCard } from './mcp/worker.js';
import OPENAPI_YAML from '../openapi.yaml';

export { SecRateLimiter };

const VERSION = '1.0.0';

// ---------------- router ----------------
async function route(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const sp = url.searchParams;
    // MCP (Streamable HTTP) endpoint. Has its own optional key (MCP_API_KEYS); RAPIDAPI_PROXY_SECRET does not apply.
    if (p === '/mcp') return handleMcp(request, env, ctx);
    if (p === '/.well-known/mcp/server-card.json' || p === '/.well-known/mcp.json') return serverCard(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...JSON_HEADERS, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, OPTIONS' } });
    if (request.method !== 'GET') return err(405, 'Only GET is supported.');
    if (p === '/' || p === '/v1') return json({ name: 'SEC EDGAR Insider Trades & Financials API', version: VERSION, docs: '/openapi.yaml', endpoints: ['/v1/insider-trades/{tickerOrCik}', '/v1/insider-buys', '/v1/filings/{tickerOrCik}', '/v1/company/{tickerOrCik}/snapshot', '/v1/company/{tickerOrCik}/facts', '/v1/company/{tickerOrCik}/concept/{taxonomy}/{tag}', '/v1/search', '/v1/resolve/{tickerOrCik}'], mcp: { endpoint: '/mcp', transport: 'streamable-http', serverCard: '/.well-known/mcp/server-card.json' }, dataSource: 'U.S. SEC EDGAR (public domain). Not affiliated with the SEC.' });
    if (p === '/health') return json({ ok: true, version: VERSION, time: new Date().toISOString() });
    if (p === '/openapi.yaml') return new Response(OPENAPI_YAML, { headers: { 'content-type': 'application/yaml; charset=utf-8', 'access-control-allow-origin': '*' } });

    // When published behind RapidAPI, reject calls that bypass the gateway.
    if (env.RAPIDAPI_PROXY_SECRET && request.headers.get('x-rapidapi-proxy-secret') !== env.RAPIDAPI_PROXY_SECRET) {
        return err(401, 'Missing or invalid X-RapidAPI-Proxy-Secret. Subscribe via RapidAPI.');
    }

    const sec = new Sec(env, ctx);
    const body = await dispatch(sec, env, p, sp);
    if (body === null) return err(404, `Unknown endpoint: ${p}. See /openapi.yaml`);
    if (body instanceof Response) return body; // raw company facts stream
    return json(body, 200, { 'x-sec-requests': String(sec.secCalls), 'x-cache-hits': String(sec.cacheHits), 'cache-control': 'public, max-age=300' });
}

export default {
    async fetch(request, env, ctx) {
        try {
            return await route(request, env, ctx);
        } catch (e) {
            if (e instanceof SecError) return err(e.status, e.message);
            console.error(e);
            return err(500, `Internal error: ${e.message}`);
        }
    },
    // Cron trigger: keep the market-wide insider-buy store fresh (one KV write per run).
    async scheduled(event, env, ctx) {
        const sec = new Sec(env, ctx);
        const store = await loadStore(env);
        let r;
        try {
            r = await scanMarket(sec, store, { maxFilings: Number(env.CRON_MAX_FILINGS || 40), days: 2 });
        } catch (e) {
            // Transient SEC errors: keep the existing store; the next run (10 min) catches up.
            console.warn(`scan failed: ${e.message} (secCalls=${sec.secCalls})`);
            return;
        }
        await saveStore(env, r.store);
        console.log(`scan: parsed=${r.parsed} buysStored=${r.store.buys.length} pending=${r.pending} eftsTotal=${r.eftsTotal} secCalls=${sec.secCalls}`);
    },
};
