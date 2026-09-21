#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { APP_NAME } from '@ckg/shared';
import { createLogger } from '@ckg/shared/logger';
import { loadEnvFile } from '@ckg/shared/node';
import { ApiClient } from './api-client.js';
import { loadMcpConfig, type McpConfig } from './config.js';
import { registerGetIndexStatus } from './tools/get-index-status.js';
import { registerGetNode } from './tools/get-node.js';
import { registerGetSource } from './tools/get-source.js';
import { registerResolveProject } from './tools/resolve-project.js';
import { registerSearchCode } from './tools/search-code.js';
import { registerSearchGraph } from './tools/search-graph.js';
import { registerTracePath } from './tools/trace-path.js';

/**
 * MCP entry point: the graph, as tools an agent can call.
 *
 * This process is an adapter and holds no domain logic. It speaks MCP over
 * stdio on one side and the existing HTTP API on the other, so a tool is a
 * schema, a request and a rendering — never a query. It has no database
 * credentials, which is what makes that structural rather than a convention.
 *
 *   MCP client ──stdio──▶ apps/mcp ──HTTP──▶ apps/api ──▶ services ──▶ database
 *
 * **stdout belongs to the protocol.** Every JSON-RPC frame the client reads
 * comes from this process's stdout, so one stray `console.log` anywhere in this
 * app corrupts the session. Logging goes to stderr, which is why the logger is
 * built with `destination: 'stderr'` and why nothing here prints.
 */

export function createMcpServer(config: McpConfig): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: '0.1.0' },
    {
      instructions:
        'Query a repository knowledge graph: code symbols, the calls and references between them, ' +
        'and the APIs, services, data stores and documentation around them. ' +
        'Start with resolve_project to turn a working directory into a project id, then get_index_status to check that project can answer before trusting what it says, then search_graph to find nodes in it, then get_node to inspect one and trace_path to see how two of them are connected. search_code searches the source text itself, for anything the graph does not record, and get_source reads the code at any location the others report. Every call after the first carries the same projectId; there is no implicit project.',
    },
  );

  const api = new ApiClient({
    baseUrl: config.mcp.apiBaseUrl,
    timeoutMs: config.mcp.MCP_REQUEST_TIMEOUT_MS,
  });

  // Registered in the order an agent uses them: which project, whether that
  // project can answer anything, then asking it something.
  registerResolveProject(server, api);
  registerGetIndexStatus(server, api);
  registerSearchGraph(server, api);
  registerGetNode(server, api);
  registerTracePath(server, api);
  registerSearchCode(server, api);
  registerGetSource(server, api);

  return server;
}

async function main(): Promise<void> {
  // Before configuration is read, and only here: config loaders stay pure.
  loadEnvFile();

  const config = loadMcpConfig();

  const logger = createLogger({
    module: 'mcp',
    level: config.runtime.LOG_LEVEL,
    base: { service: 'mcp' },
    // Not negotiable in this process: stdout is the transport.
    destination: 'stderr',
  });

  const server = createMcpServer(config);
  const transport = new StdioServerTransport();

  const close = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  await server.connect(transport);

  logger.info({ api: config.mcp.apiBaseUrl, transport: 'stdio' }, 'MCP server ready');
}

// Only run when executed directly, so tests can import `createMcpServer` and
// drive it over an in-memory transport without ever touching stdio.
const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPoint !== null && fileURLToPath(import.meta.url) === entryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
