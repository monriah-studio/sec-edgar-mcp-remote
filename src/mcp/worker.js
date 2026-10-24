// Remote MCP endpoint for the Worker: stateless Streamable HTTP at /mcp (JSON responses, no sessions,
// no Durable Object), so each request is independent and fits the Workers Free plan.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { createMcpServer } from './server.js';
import { serverCardFor } from './tools.js';
import { Sec } from '../sec.js';
import { dispatch } from '../api.js';

const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-session-id, last-event-id',
    'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

const keysOf = (env) => String(env.MCP_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Key from `Authorization: Bearer <key>`, `X-API-Key: <key>` or `?api_key=<key>`. */
function presentedKey(request, url) {
    const auth = request.headers.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return (m && m[1].trim()) || request.headers.get('x-api-key') || url.searchParams.get('api_key') || '';
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}

const withCors = (res) => {
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};

const rpcError = (status, code, message, extra = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } });

export function serverCard(env) {
    return new Response(JSON.stringify(serverCardFor(keysOf(env).length > 0)), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...CORS } });
}

export async function handleMcp(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Optional API key: open when MCP_API_KEYS is unset (local dev / free listing), enforced when set.
    const keys = keysOf(env);
    if (keys.length) {
        const k = presentedKey(request, url);
        if (!k || !keys.some((x) => timingSafeEqual(x, k))) {
            return rpcError(401, -32001, 'Missing or invalid API key. Send "Authorization: Bearer <key>" or "X-API-Key: <key>".', { 'www-authenticate': 'Bearer realm="sec-edgar-mcp"' });
        }
    }
    // Stateless JSON mode has no server-to-client stream and no sessions to delete.
    if (request.method === 'GET' || request.method === 'DELETE') return rpcError(405, -32000, 'Method not allowed: use POST (stateless Streamable HTTP).', { allow: 'POST, OPTIONS' });
    if (request.method !== 'POST') return rpcError(405, -32000, 'Method not allowed.', { allow: 'POST, OPTIONS' });

    const sec = new Sec(env, ctx);
    const backend = async (path, query) => {
        const r = await dispatch(sec, env, path, new URLSearchParams(query));
        if (r instanceof Response) throw Object.assign(new Error('Not available over MCP.'), { status: 400 });
        return r;
    };
    const server = createMcpServer(backend, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
        const res = await transport.handleRequest(request);
        const out = withCors(res);
        out.headers.set('x-sec-requests', String(sec.secCalls));
        out.headers.set('x-cache-hits', String(sec.cacheHits));
        return out;
    } finally {
        ctx?.waitUntil?.(Promise.resolve().then(() => server.close()).catch(() => {}));
    }
}
