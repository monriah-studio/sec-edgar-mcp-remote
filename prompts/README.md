# Example prompts

Paste any of these into a client that has the `sec-edgar` server connected. Each one names the tools it should trigger, so you can check that the agent picks the right ones. With the [skills](../skills/) installed, prompts 1, 3, 5 and 8 load the matching skill automatically.

1. **Cluster buys this week** (`get_market_insider_buys` → `get_insider_trades`)
   > Which stocks had cluster insider buying (2+ insiders) in the last 14 days? For the top 3, show who bought, their roles, the dollar amounts, and whether any trades were under a 10b5-1 plan.

2. **Big officer buys** (`get_market_insider_buys` with `role` and `min_value`)
   > Show open-market purchases by officers worth at least $250,000 in the last 30 days, ranked by total value.

3. **Five-year fundamentals** (`get_company_snapshot` → `get_company_concept`)
   > Build a table of Apple's revenue, net income, net margin and year-end cash for the last 5 fiscal years. Label each year by its period end date.

4. **Compare two companies** (`get_company_snapshot` ×2)
   > Compare NVIDIA and AMD: latest annual revenue, revenue growth, gross margin, net margin and debt-to-equity. Which is more profitable?

5. **Watchlist digest** (`get_company_filings` per ticker)
   > Check NVDA, AAPL, MSFT, TSLA and AMZN for 8-K filings in the last 30 days. Decode the item numbers into plain English and flag anything about executive changes, acquisitions or cybersecurity.

6. **Keyword search** (`search_filings`)
   > Find 8-Ks filed in the last 90 days that mention "going concern". List the company, filing date and a link.

7. **Insider selling check** (`get_insider_trades` with `side: "sell"`)
   > Has anyone at Tesla sold stock on the open market recently? Summarize by insider, with total shares, value, and whether the sales were pre-planned (10b5-1).

8. **Earnings prep** (`get_company_filings`, `get_company_snapshot`, `get_company_concept`, `get_insider_trades`)
   > I'm preparing for Apple's next earnings report. When did they last report, how did the last 8 quarters of revenue trend, what material events happened since then, and what have insiders been doing?

9. **Single XBRL concept** (`get_company_concept`)
   > Show Microsoft's diluted EPS (EarningsPerShareDiluted, unit USD/shares) for the last 8 quarters.

10. **Buyback language across a watchlist** (`resolve_company` → `search_filings` with `ciks`)
    > Did Apple, NVIDIA or Microsoft mention a "share repurchase" in any 8-K this year? Show the matching filings.
