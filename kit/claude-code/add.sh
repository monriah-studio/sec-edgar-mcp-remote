#!/usr/bin/env sh
# Adds the free SEC EDGAR MCP server to Claude Code (local scope by default).
# Use --scope user for all your projects, or --scope project to write .mcp.json for your team.
claude mcp add --transport http sec-edgar https://sec-edgar-api.kidriahx.workers.dev/mcp
