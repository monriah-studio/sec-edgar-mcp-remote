// Builds an MCP server (official TypeScript SDK, low-level Server class) around the shared tool catalog.
// Used by the Worker (/mcp, Streamable HTTP) and by the stdio npm package.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO, INSTRUCTIONS, toolList, runTool } from './tools.js';

/**
 * @param backend (path, query) => Promise<object>  REST-shaped data source
 * @param options extra SDK Server options (e.g. jsonSchemaValidator)
 */
export function createMcpServer(backend, options = {}) {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS, ...options });
    const tools = toolList();
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => runTool(req.params.name, req.params.arguments, backend));
    return server;
}
