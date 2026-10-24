---
name: company-financial-snapshot
description: Builds a multi-year financial snapshot for a U.S. public company from SEC XBRL data (revenue, net income, cash, margins, growth), de-duplicating periods correctly. Use when the user asks for a company's financials, revenue or profit trend, fundamentals, or a multi-year table for a ticker.
license: MIT
compatibility: Requires the sec-edgar MCP server (https://sec-edgar-api.kidriahx.workers.dev/mcp) connected to the client.
metadata:
  server: sec-edgar
  tools: get_company_snapshot get_company_concept
---

# Company financial snapshot

Uses the `sec-edgar` MCP server. In Claude Code the tools appear as `mcp__sec-edgar__<tool>`.

## 1. Latest snapshot and the right XBRL tags

Call `get_company_snapshot` with `{ "ticker_or_cik": "AAPL" }` (its only argument).

- `metrics.<name>` for revenue, grossProfit, operatingIncome, netIncome, epsDiluted, totalAssets, operatingCashFlow, totalLiabilities, stockholdersEquity, cash, longTermDebt and sharesOutstanding. Each has `annual`, `fy`, `periodEnd`, `priorAnnual`, `growthPct`, `latest`, `latestPeriodEnd`, `latestPeriod`, `unit` and `tag`.
- `ratios`: `netMarginPct`, `grossMarginPct`, `debtToEquity`.
- **Write down each metric's `tag`** (e.g. `us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax` for AAPL, `us-gaap:Revenues` for NVDA). Companies use different tags, so don't guess one.

## 2. History per metric

Call `get_company_concept` with the tag minus its `us-gaap:` prefix:

```json
{ "ticker_or_cik": "AAPL", "concept": "RevenueFromContractWithCustomerExcludingAssessedTax", "period": "annual", "limit": 10 }
{ "ticker_or_cik": "AAPL", "concept": "NetIncomeLoss", "period": "annual", "limit": 10 }
{ "ticker_or_cik": "AAPL", "concept": "CashAndCashEquivalentsAtCarryingValue", "period": "all", "limit": 40 }
```

- `period`: `"annual" | "quarterly" | "all"` (default annual). `limit` 1-40. Optional: `taxonomy` (`"us-gaap"` default, `"ifrs-full"` for IFRS filers such as many foreign issuers, `"dei"`, `"srt"`) and `unit` (`"USD"`, `"USD/shares"`, `"shares"`).
- Each value has `value`, `start`, `end`, `fy`, `fp`, `form` and `filed`. Check `totalPeriods` and `availableUnits` too.

## 3. De-duplicate and label periods (important)

- **Label every period by its `end` date (and `start`), never by `fy`/`fp`.** `fy`/`fp` describe the filing that reported the number, so the comparatives in a 10-K share that 10-K's `fy`. For example, AAPL's FY2023 and FY2024 revenue both show up with `fy: 2025` from the 10-K filed 2025-10-31.
- Flow metrics (revenue, net income, cash flow): an annual period runs about 360-371 days from `start` to `end`. Keep one value per `end`, preferring the most recent `filed` (that picks up restatements).
- Instant metrics (cash, assets, debt, equity) have **no `start`**, so `period: "annual"` can't tell year-end balances apart from 10-Q quarter-ends. Take the fiscal-year `end` dates from the revenue series and keep the cash rows whose `end` matches. Fall back to rows with `form` = `10-K`.
- If the series stops early, older years may sit under a different tag (e.g. `SalesRevenueNet` or `Revenues` before ASC 606). Try those and say so if you stitch series together.

## Output

A table by fiscal year-end (`end`): revenue, YoY %, net income, net margin %, cash. Add the latest quarter from `metrics.*.latest` / `latestPeriodEnd`. Note the tags used and that figures are as reported in SEC XBRL, in USD (not investment advice).
