---
name: insider-buying-scan
description: Finds recent open-market insider buying (SEC Form 4, code P) across U.S. stocks, highlights cluster buys where 2+ insiders bought, then pulls per-company trade detail and context. Use when the user asks about insider buying, cluster buys, "which insiders are buying", or insider activity for a ticker.
license: MIT
compatibility: Requires the sec-edgar MCP server (https://sec-edgar-api.kidriahx.workers.dev/mcp) connected to the client.
metadata:
  server: sec-edgar
  tools: get_market_insider_buys get_insider_trades get_company_filings get_company_snapshot
---

# Insider buying scan

Uses the `sec-edgar` MCP server. In Claude Code the tools appear as `mcp__sec-edgar__<tool>`.

## 1. Market-wide scan

Call `get_market_insider_buys`:

```json
{ "days": 14, "min_insiders": 2, "limit": 10 }
```

- `days` 1-30 (default 7). `min_insiders` 2 = cluster buys only (default 1). `limit` 1-50 (default 10).
- Optional: `min_value` (USD per issuer, e.g. `100000`), `role` = `"officer" | "director" | "tenpercent"`.
- Read `window` and `dataUpdatedAt` and state them. Coverage is a rolling scan that started when the server was deployed (max 30 days), so a short history is not proof nobody bought.
- Each result has `ticker`, `issuer`, `insiderCount`, `clusterBuy`, `totalValueUsd`, `avgPrice`, `firstDate`, `lastDate`, `insiders` (up to 5, with `name`, `role`, `valueUsd`) and `latestFilingUrl`.
- If nothing comes back, retry with `min_insiders: 1` and/or `days: 30` and say you widened it.

## 2. Per-company detail (top 3-5 names)

For each ticker, call `get_insider_trades`:

```json
{ "ticker_or_cik": "RAPP", "side": "buy", "filings": 10, "max_rows": 25 }
```

- `side`: `"buy"` (code P) or `"sell"` (code S). For other codes use `codes`, e.g. `["P","S"]`. Don't send both.
- `filings` 1-25 (default 5) is how many recent Form 4s get parsed. `since` (YYYY-MM-DD) narrows it.
- From `summary`: `openMarketBuys`, `buyValueUsd`, `openMarketSells`, `sellValueUsd`, `distinctInsiders`.
- From `transactions`: check `role` (CEO/CFO buys carry more signal than directors), `price`, `ownedAfter` (size relative to existing stake), and `plan10b51` (pre-planned trades carry less signal).
- Also run `{ "ticker_or_cik": "<T>", "side": "sell", "filings": 10 }` when you need to know whether insiders are also selling.

## 3. Context (optional but recommended)

- `get_company_filings` `{ "ticker_or_cik": "<T>", "forms": ["8-K"], "limit": 5 }`: recent events (8-K `items` is a comma string, e.g. `"2.02,9.01"`; 2.02 = earnings, 5.02 = officer/director change, 1.01 = material agreement).
- `get_company_snapshot` `{ "ticker_or_cik": "<T>" }`: size and profitability (`metrics.revenue.annual`, `metrics.netIncome.annual`, `ratios`).

## Output

A table: ticker, issuer, # insiders, total $, avg price, date range, notable buyers (role). Then 2-3 lines per top name covering the buyers' roles, size against their holdings, 10b5-1 status, and any recent 8-K. Link `latestFilingUrl` or the transaction `url`. End with: "Insider buying is one signal, not investment advice."
