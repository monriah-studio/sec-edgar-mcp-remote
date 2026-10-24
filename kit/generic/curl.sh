#!/usr/bin/env sh
# Raw Streamable HTTP check: the server is stateless, so a single POST with no session works.
URL=https://sec-edgar-api.kidriahx.workers.dev/mcp
H='-H content-type:application/json -H accept:application/json,text/event-stream'

# List the 7 tools
curl -s $H "$URL" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
echo
# Call one tool
curl -s $H "$URL" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"resolve_company","arguments":{"ticker_or_cik":"AAPL"}}}'
echo
