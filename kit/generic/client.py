# Minimal Python client using the official MCP SDK (pip install mcp).
# Works with SDK 1.x (streamablehttp_client) and 2.x (streamable_http_client).
import asyncio, json
from mcp import ClientSession

try:
    from mcp.client.streamable_http import streamable_http_client as connect
except ImportError:  # mcp 1.x
    from mcp.client.streamable_http import streamablehttp_client as connect

URL = "https://sec-edgar-api.kidriahx.workers.dev/mcp"

async def main():
    async with connect(URL) as streams:
        read, write = streams[0], streams[1]
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print([t.name for t in tools.tools])
            r = await session.call_tool("get_company_snapshot", {"ticker_or_cik": "NVDA"})
            print(json.dumps(json.loads(r.content[0].text)["ratios"], indent=2))

asyncio.run(main())
