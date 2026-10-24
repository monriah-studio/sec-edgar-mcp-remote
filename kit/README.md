# Client configs

Copy-paste configs for the free SEC EDGAR MCP server. The endpoint is

```
https://sec-edgar-api.kidriahx.workers.dev/mcp
```

It uses Streamable HTTP, is stateless, needs no API key and has no auth. Every file below uses the server name `sec-edgar`. For a step-by-step walkthrough, see [docs/SETUP.md](../docs/SETUP.md).

| Client | File in this folder | Where it goes |
| --- | --- | --- |
| Claude Desktop | [`claude-desktop/claude_desktop_config.json`](claude-desktop/claude_desktop_config.json) | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json` (merge into `mcpServers`) |
| Claude Code | [`claude-code/add.sh`](claude-code/add.sh) or [`claude-code/.mcp.json`](claude-code/.mcp.json) | Run the command, or put `.mcp.json` at your project root |
| Cursor | [`cursor/.cursor/mcp.json`](cursor/.cursor/mcp.json) | `<project>/.cursor/mcp.json` or global `~/.cursor/mcp.json` |
| VS Code (Copilot agent mode) | [`vscode/.vscode/mcp.json`](vscode/.vscode/mcp.json) | `<workspace>/.vscode/mcp.json` |
| VS Code (portable format) | [`vscode/mcp-config.json`](vscode/mcp-config.json) | Workspace-root `.mcp.json` or `~/.copilot/mcp-config.json` |
| Windsurf / Devin Desktop | [`windsurf/mcp_config.json`](windsurf/mcp_config.json) | `~/.config/devin/mcp_config.json` (Windows `%APPDATA%\devin\mcp_config.json`). Older Windsurf builds: `~/.codeium/windsurf/mcp_config.json` |
| Anything else | [`generic/`](generic/) | `mcp.json` (`type: streamable-http`), `curl.sh`, `client.mjs` (Node SDK), `client.py` (Python SDK) |

## Notes per client

- **Claude Desktop.** The JSON config file only launches local (stdio) servers, so the config runs [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a bridge. You need Node.js 18 or newer. `--transport http-only` skips the SSE fallback. Restart Claude Desktop after you edit the file. Alternatively, skip the file and add the URL under **Settings → Connectors → Add custom connector**. Remote connectors are brokered by Anthropic's cloud, which works because this endpoint is public.
- **Claude Code.** `claude mcp add --transport http sec-edgar <url>` adds the server at local scope. Add `--scope user` to use it in every project, or `--scope project` to write `.mcp.json` for your team. Check with `claude mcp list` or `/mcp`.
- **Cursor.** Remote servers only need `url`. Afterwards, check **Settings → MCP** for a green dot and 7 tools.
- **VS Code.** Use `servers` (not `mcpServers`) with `"type": "http"` in `.vscode/mcp.json`. You can also run **MCP: Add Server → HTTP** from the Command Palette. Tools show up in Copilot Chat's agent mode tool picker.
- **Windsurf.** The key is `serverUrl` (`url` is also accepted). Open the file via Cascade's **… → MCPs → Open MCP config file**, then refresh.
