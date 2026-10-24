# SEC EDGAR MCP (remote)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server and JSON API for U.S. **SEC EDGAR** data, running on Cloudflare Workers. It gives AI agents Form 4 insider trades, market-wide cluster buys, company filings, XBRL financials and EDGAR full-text search as compact JSON, with no XML parsing or CIK lookups needed.

- **Remote MCP endpoint (Streamable HTTP, stateless):** `https://sec-edgar-api.kidriahx.workers.dev/mcp`
- **Server card:** `https://sec-edgar-api.kidriahx.workers.dev/.well-known/mcp/server-card.json`
- **REST API spec:** `https://sec-edgar-api.kidriahx.workers.dev/openapi.yaml`
- **MCP Registry name:** `io.github.monriah-studio/sec-edgar-mcp`

Data comes straight from SEC EDGAR (public domain) under SEC fair-access rules: a declared User-Agent, a global rate limit of about 8.7 req/s (under SEC's 10 req/s) and caching. Not affiliated with the SEC. Not investment advice.

## Tools

| Tool | What it returns |
|---|---|
| `get_insider_trades` | Form 4 transactions for a company (ticker/CIK) or an insider (reporting-owner CIK): who bought or sold, role, shares, price, dollar value, 10b5-1 flag and filing link, with buy/sell totals. |
| `get_market_insider_buys` | Open-market insider purchases across the whole market, grouped by company, with cluster-buy detection (2+ insiders). |
| `get_company_filings` | Latest 10-K, 10-Q, 8-K (with item numbers), S-1, proxy and other filings, with direct document links. |
| `get_company_snapshot` | Revenue, margins, net income, EPS, cash flow, balance sheet and debt, with YoY growth, from XBRL. |
| `get_company_concept` | Annual or quarterly history of any XBRL tag (e.g. `NetIncomeLoss`, `Revenues`). |
| `search_filings` | EDGAR full-text search with phrase, form and date filters. |
| `resolve_company` | Ticker ↔ CIK lookup. |

## Connect a client

Any MCP client that supports Streamable HTTP can use the URL directly. For example:

```json
{
  "mcpServers": {
    "sec-edgar": {
      "type": "http",
      "url": "https://sec-edgar-api.kidriahx.workers.dev/mcp"
    }
  }
}
```

If the operator has set `MCP_API_KEYS`, send a key as `Authorization: Bearer <key>`, `X-API-Key: <key>` or `?api_key=<key>`.

Example prompts:
- "Which companies had cluster insider buying (2+ insiders) in the last 30 days?"
- "Show NVIDIA's last 10 insider sales and whether they were under 10b5-1 plans."
- "Compare Apple's revenue, net margin and debt-to-equity with last year."
- "Find 8-K filings this year that mention 'share repurchase'."

## REST endpoints

The same Worker also serves a REST API (see `openapi.yaml`):
`/v1/insider-trades/{tickerOrCik}`, `/v1/insider-buys`, `/v1/filings/{tickerOrCik}`, `/v1/company/{tickerOrCik}/snapshot`, `/v1/company/{tickerOrCik}/facts`, `/v1/company/{tickerOrCik}/concept/{taxonomy}/{tag}`, `/v1/search`, `/v1/resolve/{tickerOrCik}`, plus `/health`.

## Run locally

Requires Node.js 18+. No Cloudflare account is needed for local dev.

```bash
npm install
npx wrangler dev --test-scheduled          # serves http://localhost:8787 (MCP at /mcp)
node test/unit.mjs                         # unit tests
node test/harness.mjs http://localhost:8787   # REST against live EDGAR
node test/mcp.mjs http://localhost:8787       # MCP: lists tools and calls each one
curl "localhost:8787/__scheduled?cron=*/10+*+*+*+*"   # run the insider-buy cron once
```

Optional local secrets go in `.dev.vars` (git-ignored; see `.dev.vars.example`).

## Deploy your own (Cloudflare Workers Free)

1. `npx wrangler login`
2. `npx wrangler kv namespace create CACHE`, then put the printed id in `wrangler.toml` (`[[kv_namespaces]]`).
3. Set `SEC_USER_AGENT` in `wrangler.toml` to your own name and a monitored email (SEC fair-access requirement).
4. `npx wrangler deploy`
5. Optional: `npx wrangler secret put MCP_API_KEYS` (protects `/mcp`) and `npx wrangler secret put RAPIDAPI_PROXY_SECRET` (protects REST).

The Durable Object rate limiter (`SecRateLimiter`) and the `*/10 * * * *` cron are created automatically.

## Project layout

- `src/index.js`: router and REST endpoints
- `src/sec.js`: SEC client, global rate limiter (Durable Object), caching
- `src/form4.js`: Form 4 XML parser
- `src/mcp/`: MCP server (`tools.js` defines the 7 tools)
- `test/`: unit tests, live harness, MCP test and sample responses
- `server.json`: MCP Registry metadata

## License

MIT © 2026 MonRiah Studio. See [LICENSE](LICENSE).
