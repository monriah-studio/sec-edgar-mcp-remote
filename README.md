# SEC EDGAR MCP (remote)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server and JSON API for U.S. **SEC EDGAR** data, running on Cloudflare Workers. It gives AI agents Form 4 insider trades, market-wide cluster buys, company filings, XBRL financials and EDGAR full-text search as compact JSON, with no XML parsing or CIK lookups needed.

- **Remote MCP endpoint (Streamable HTTP, stateless):** `https://sec-edgar-api.kidriahx.workers.dev/mcp`
- **Server card:** `https://sec-edgar-api.kidriahx.workers.dev/.well-known/mcp/server-card.json`
- **REST API spec:** `https://sec-edgar-api.kidriahx.workers.dev/openapi.yaml`
- **MCP Registry name:** `io.github.monriah-studio/sec-edgar-mcp`
- **Tutorial:** [Give your AI agent SEC EDGAR data: a free remote MCP server for insider trades and XBRL financials](https://dev.to/monriahstudio/give-your-ai-agent-sec-edgar-data-a-free-remote-mcp-server-for-insider-trades-and-xbrl-financials-31j4) (dev.to)

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

Claude Code users can run `claude mcp add --transport http sec-edgar https://sec-edgar-api.kidriahx.workers.dev/mcp`. Each client uses a slightly different format, so see the [agent kit](#agent-kit) below for exact files.

If the operator has set `MCP_API_KEYS`, send a key as `Authorization: Bearer <key>`, `X-API-Key: <key>` or `?api_key=<key>`. The public endpoint above needs no key.

Example prompts:
- "Which companies had cluster insider buying (2+ insiders) in the last 30 days?"
- "Show NVIDIA's last 10 insider sales and whether they were under 10b5-1 plans."
- "Compare Apple's revenue, net margin and debt-to-equity with last year."
- "Find 8-K filings this year that mention 'share repurchase'."

More are in [`prompts/`](prompts/README.md).

## Agent kit

Everything you need to plug the server into an agent, tested against the live endpoint:

- **[`docs/SETUP.md`](docs/SETUP.md)**: a step-by-step setup guide for each client, plus troubleshooting.
- **[`kit/`](kit/README.md)**: copy-paste configs for Claude Desktop (via `mcp-remote` or a custom connector), Claude Code, Cursor, VS Code, Windsurf, and a generic Streamable HTTP example (`curl`, Node SDK, Python SDK).
- **[`skills/`](skills/)**: four [Agent Skills](https://agentskills.io) (`SKILL.md`) that teach the agent reliable workflows:
  - `insider-buying-scan`: market-wide cluster buys, then per-company trade detail and context
  - `company-financial-snapshot`: a multi-year XBRL table (revenue, net income, cash) that de-duplicates periods correctly
  - `filing-monitor`: an 8-K digest for a watchlist, with decoded item numbers
  - `earnings-prep`: a one-page brief before an earnings report
- **[`prompts/`](prompts/README.md)**: 10 example prompts and the tools each one should trigger.
- **`test/skills.mjs`**: `node test/skills.mjs` runs every skill workflow against the live endpoint (Node 18+, no install).

## Need bulk or scheduled data?

This MCP server is free and is meant for interactive, agent-sized lookups: one company or a handful of filings per call. If you need more than that, such as daily 8-K alerts across the whole market, filings for hundreds of tickers, keyword sweeps over a date range, or results delivered to a dataset, webhook or spreadsheet on a schedule, we also publish a paid Apify Actor built on the same SEC sources:

**[SEC EDGAR Filings & Financials API](https://apify.com/monriah-studio/sec-edgar-filings)** (Apify)
- `companyFilings`: 8-K or any form by ticker
- `marketFilings`: every filing of chosen forms across all companies in a date range, with 8-K item and full-text keyword filters
- `financials`: XBRL snapshots for a list of tickers
- Scheduling and change detection (`onlyNewSinceLastRun`), so you only get filings you haven't seen
- Pay per result: **$0.002 per filing row** and **$0.005 per company snapshot**, with a `maxResults` cap. Apify's free plan includes monthly platform credit.

You don't need it to use anything in this repo. The MCP server stays free, and the Actor is optional for batch and scheduled jobs. Insider trades aren't part of that Actor; for those, use this server's `get_insider_trades` and `get_market_insider_buys`.

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
- `test/`: unit tests, live harness, MCP test, skill-workflow smoke test (`skills.mjs`) and sample responses
- `kit/`: client configs, `skills/`: Agent Skills, `prompts/`: example prompts, `docs/SETUP.md`: setup guide
- `server.json`: MCP Registry metadata

## License

MIT © 2026 MonRiah Studio. See [LICENSE](LICENSE).
