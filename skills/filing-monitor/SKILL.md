---
name: filing-monitor
description: Checks a watchlist of tickers for recent SEC 8-K filings (and optionally 10-K/10-Q), decodes 8-K item numbers into plain events such as earnings, executive changes, deals and cyber incidents, and flags what is new. Use when the user asks what a set of companies filed recently, wants a filings digest, or asks to watch tickers for 8-Ks.
license: MIT
compatibility: Requires the sec-edgar MCP server (https://sec-edgar-api.kidriahx.workers.dev/mcp) connected to the client.
metadata:
  server: sec-edgar
  tools: get_company_filings search_filings resolve_company
---

# Filing monitor

Uses the `sec-edgar` MCP server. In Claude Code the tools appear as `mcp__sec-edgar__<tool>`.

## 1. Per-ticker filings

For each ticker in the watchlist (keep to about 10 per run), call `get_company_filings`:

```json
{ "ticker_or_cik": "NVDA", "forms": ["8-K"], "since": "2026-07-01", "limit": 10 }
```

- `forms` is an array (e.g. `["8-K","8-K/A"]`, `["10-K","10-Q"]`). `since` / `until` are YYYY-MM-DD. `limit` 1-50 (default 10).
- Default `since` to 30 days ago unless the user gives a window. If they gave a "last checked" date, only report filings with `filed` after it.
- Each filing has `form`, `filed`, `period`, `items` (comma-separated **string**, e.g. `"2.02,9.01"`), `description`, `accession` and `url`.

## 2. Decode 8-K items

| Item | Meaning |
| --- | --- |
| 1.01 | Material definitive agreement |
| 1.02 | Termination of a material agreement |
| 1.05 | Material cybersecurity incident |
| 2.01 | Acquisition or disposition completed |
| 2.02 | Results of operations (earnings) |
| 2.03 | New material debt obligation |
| 2.05 / 2.06 | Exit costs / material impairment |
| 3.01 | Delisting notice |
| 4.01 / 4.02 | Auditor change / non-reliance (restatement) |
| 5.02 | Director or officer departure/appointment, compensation |
| 5.03 | Charter or bylaw amendment |
| 5.07 | Shareholder vote results |
| 7.01 | Reg FD disclosure |
| 8.01 | Other events |
| 9.01 | Exhibits (ignore on its own) |

Flag as high priority: 1.05, 2.06, 3.01, 4.02, 5.02, 1.01, 2.01.

## 3. Optional: topic search across the watchlist

To find, for example, buyback or guidance language, get the CIKs with `resolve_company` `{ "ticker_or_cik": "AAPL" }` (returns `cik`), then call `search_filings`:

```json
{ "query": "\"share repurchase\"", "forms": ["8-K"], "ciks": ["320193", "1045810"], "start_date": "2026-01-01", "limit": 10 }
```

- `ciks` takes up to 10 digit strings (leading zeros are fine). Here `items` is an **array**, not a string. Use double quotes for exact phrases.

## Output

Group by ticker, newest first: date, form, decoded items, one-line description, link (`url`). Put a "High priority" section at the top, and list tickers with no filings in the window on one line. For scheduled or bulk monitoring of many tickers, see the README section "Need bulk or scheduled data?".
