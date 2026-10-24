// Minimal Node client using the official MCP SDK (npm i @modelcontextprotocol/sdk).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'sec-edgar-example', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('https://sec-edgar-api.kidriahx.workers.dev/mcp')));
console.log((await client.listTools()).tools.map((t) => t.name));
const r = await client.callTool({ name: 'get_company_filings', arguments: { ticker_or_cik: 'AAPL', forms: ['8-K'], limit: 3 } });
console.log(JSON.parse(r.content[0].text));
await client.close();
