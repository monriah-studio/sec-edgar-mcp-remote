---
name: earnings-prep
description: Prepares an earnings brief for a U.S. public company from SEC data covering the last earnings 8-K (Item 2.02), latest 10-Q/10-K, trailing financial trend, recent insider trades and other material 8-Ks. Use when the user is preparing for an earnings call or report, or asks "what should I know before X reports".
license: MIT
compatibility: Requires the sec-edgar MCP server (https://sec-edgar-api.kidriahx.workers.dev/mcp) connected to the client.
metadata:
  server: sec-edgar
  tools: resolve_company get_company_filings search_filings get_company_snapshot get_company_concept get_insider_trades
---

# Earnings prep

Uses the `sec-edgar` MCP server. In Claude Code the tools appear as `mcp__sec-edgar__<tool>`.

## Steps

1. **Recent filings**: call `get_company_filings` with `{ "ticker_or_cik": "AAPL", "forms": ["8-K","10-Q","10-K"], "limit": 15 }`.
   - Last earnings release = newest 8-K whose `items` string contains `2.02`. Its `filed` date shows the reporting cadence (next report is usually about 3 months later). Note `company.fiscalYearEnd` (MMDD).
   - Latest periodic report = newest 10-Q/10-K (`period` = quarter end).
   - Any other material 8-Ks since the last earnings (5.02, 1.01, 2.01, 1.05...).
2. **Earnings history via full text (optional)**: `resolve_company` `{ "ticker_or_cik": "AAPL" }` → `cik`, then `search_filings` `{ "query": "\"results of operations\"", "forms": ["8-K"], "ciks": ["320193"], "start_date": "<one year ago>", "limit": 5 }`. Hits with `items` (array) including `"2.02"` are the earnings 8-Ks.
3. **Numbers**: `get_company_snapshot` `{ "ticker_or_cik": "AAPL" }`, then report the latest annual figures and the latest quarter (`metrics.revenue.latest`, `latestPeriodEnd`, `latestPeriod`), `growthPct`, and `ratios`.
4. **Quarterly trend**: `get_company_concept` with the snapshot's revenue tag (drop the `us-gaap:` prefix), e.g. `{ "ticker_or_cik": "AAPL", "concept": "RevenueFromContractWithCustomerExcludingAssessedTax", "period": "quarterly", "limit": 12 }`. Label quarters by `start`–`end`, not `fy`/`fp` (those belong to the filing). Keep only ~90-day periods, one per `end`. Fiscal Q4 is usually absent (it's inside the 10-K), so derive it as annual minus Q1-Q3 only if you say so.
5. **Insiders**: `get_insider_trades` `{ "ticker_or_cik": "AAPL", "filings": 15, "max_rows": 30 }`. Summarize `summary` and note open-market buys/sells and whether sales are 10b5-1 (`plan10b51`). Codes M/F/A are mostly compensation mechanics.

## Output

A one-page brief with: Last report (date, link) · Latest quarter vs year-ago · Annual trend table · Margin/balance-sheet notes · Events since last report · Insider activity · Questions to watch. Cite filing URLs. Not investment advice.
