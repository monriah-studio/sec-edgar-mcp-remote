# Setup guide

This guide gets the free SEC EDGAR MCP server working in your AI client in about two minutes. You need no account, API key or payment.

**Endpoint:** `https://sec-edgar-api.kidriahx.workers.dev/mcp` (Streamable HTTP, stateless)

## 1. Check that the endpoint responds (optional)

```bash
curl -s https://sec-edgar-api.kidriahx.workers.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"resolve_company","arguments":{"ticker_or_cik":"AAPL"}}}'
```

You should see `{"cik":"0000320193","ticker":"AAPL","name":"Apple Inc."}` inside the result.

## 2. Add the server to your client

Pick your client. The ready-made files are in [`kit/`](../kit/).

### Claude Code

```bash
claude mcp add --transport http sec-edgar https://sec-edgar-api.kidriahx.workers.dev/mcp
claude mcp list          # should show sec-edgar ... ✓ Connected
```

Add `--scope user` to use the server in all projects, or `--scope project` to share it through `.mcp.json`.

### Claude Desktop

Option A, the Connectors UI: open **Settings → Connectors → Add custom connector**, name it `SEC EDGAR` and paste the endpoint URL.

Option B, the config file (needs Node.js 18+):

1. Open **Settings → Developer → Edit Config**. That opens `claude_desktop_config.json`, which lives at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
2. Merge in [`kit/claude-desktop/claude_desktop_config.json`](../kit/claude-desktop/claude_desktop_config.json):
   ```json
   { "mcpServers": { "sec-edgar": { "command": "npx", "args": ["-y", "mcp-remote", "https://sec-edgar-api.kidriahx.workers.dev/mcp", "--transport", "http-only"] } } }
   ```
3. Fully quit and restart Claude Desktop. Do not put a bare `"url"` entry in this file, because it only supports stdio servers.

### Cursor

Save [`kit/cursor/.cursor/mcp.json`](../kit/cursor/.cursor/mcp.json) as `.cursor/mcp.json` in your project, or merge it into `~/.cursor/mcp.json` to use it everywhere:

```json
{ "mcpServers": { "sec-edgar": { "url": "https://sec-edgar-api.kidriahx.workers.dev/mcp" } } }
```

Then open **Cursor Settings → MCP** and confirm the server shows 7 tools.

### VS Code (GitHub Copilot agent mode)

Save [`kit/vscode/.vscode/mcp.json`](../kit/vscode/.vscode/mcp.json) as `.vscode/mcp.json`:

```json
{ "servers": { "sec-edgar": { "type": "http", "url": "https://sec-edgar-api.kidriahx.workers.dev/mcp" } } }
```

You can also run **MCP: Add Server → HTTP** from the Command Palette and paste the URL. Open Copilot Chat in **Agent** mode and enable the tools in the tool picker. If you use the portable `mcpServers` format (a workspace-root `.mcp.json` or `~/.copilot/mcp-config.json`), use [`kit/vscode/mcp-config.json`](../kit/vscode/mcp-config.json).

### Windsurf (Devin Desktop / Cascade)

Open Cascade's **… → MCPs → Open MCP config file**, merge in [`kit/windsurf/mcp_config.json`](../kit/windsurf/mcp_config.json), and refresh:

```json
{ "mcpServers": { "sec-edgar": { "serverUrl": "https://sec-edgar-api.kidriahx.workers.dev/mcp" } } }
```

The file is `~/.config/devin/mcp_config.json` (Windows `%APPDATA%\devin\mcp_config.json`). Older Windsurf builds use `~/.codeium/windsurf/mcp_config.json`.

### Other clients and code

Any client that supports Streamable HTTP can use [`kit/generic/mcp.json`](../kit/generic/mcp.json). For code, see [`kit/generic/client.mjs`](../kit/generic/client.mjs) (Node, `@modelcontextprotocol/sdk`) and [`kit/generic/client.py`](../kit/generic/client.py) (Python, `mcp`).

## 3. Install the skills (optional)

The [`skills/`](../skills/) folder holds four Agent Skills (`SKILL.md` files) that teach the agent good workflows for these tools:

| Skill | What it does |
| --- | --- |
| `insider-buying-scan` | Market-wide cluster buys, then per-company trade detail |
| `company-financial-snapshot` | Multi-year XBRL table with correct period de-duplication |
| `filing-monitor` | 8-K digest for a watchlist with decoded item numbers |
| `earnings-prep` | One-page brief before an earnings report |

- **Claude Code:** copy them into a skills folder:
  ```bash
  git clone https://github.com/monriah-studio/sec-edgar-mcp-remote
  mkdir -p ~/.claude/skills && cp -r sec-edgar-mcp-remote/skills/* ~/.claude/skills/
  # or, per project: cp -r sec-edgar-mcp-remote/skills/* .claude/skills/
  ```
  They load automatically when relevant, or you can run them as `/insider-buying-scan` and so on.
- **Claude apps (claude.ai / Desktop):** first add the server as a custom connector (see above). Then zip one skill folder from its parent directory, so the archive contains `insider-buying-scan/SKILL.md`:
  ```bash
  cd sec-edgar-mcp-remote/skills && zip -r insider-buying-scan.zip insider-buying-scan/
  ```
  Upload it under **Customize → Skills → + → Create skill → Upload a skill**. This needs **Code execution and file creation** turned on under Settings → Capabilities. The frontmatter uses only Agent Skills spec fields, so the upload validates.
- **Other agents:** paste the body of the `SKILL.md` into your system prompt or rules file.

## 4. Try it

Start with one of the [example prompts](../prompts/README.md), for example:

> Which stocks had cluster insider buying in the last 14 days? Show who bought for the top 3.

## Troubleshooting

- **Server shows 0 tools or won't connect.** Check the URL ends in `/mcp`. For Claude Desktop with mcp-remote, run `npx -y mcp-remote https://sec-edgar-api.kidriahx.workers.dev/mcp --transport http-only` in a terminal and look at the errors (Node 18+ required).
- **The market insider scan returns few results.** It is built from a rolling scan of recent Form 4 filings that began when the server was deployed, up to 30 days. Use `days: 30` and `min_insiders: 1` to widen it.
- **XBRL years look duplicated or mislabeled.** Label periods by `end`, not `fy`. See the `company-financial-snapshot` skill.
- **Self-test.** Run `node test/skills.mjs` from the repo (Node 18+, no install needed) to exercise every skill workflow against the live endpoint.
