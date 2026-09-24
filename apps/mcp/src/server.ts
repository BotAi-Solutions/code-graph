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
import { ProjectRootError } from './project-root.js';
import { ProjectEnsurer, type EnsureOutcome } from './project-ensurer.js';
import { registerEnsureProject } from './tools/ensure-project.js';
import { registerGetIndexStatus } from './tools/get-index-status.js';
import { registerGetNode } from './tools/get-node.js';
import { registerGetSource } from './tools/get-source.js';
import { registerIndexProject } from './tools/index-project.js';
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

/** The server, and the piece of it the startup check drives. */
export interface McpRuntime {
  server: McpServer;
  projects: ProjectEnsurer;
}

export function createMcpServer(config: McpConfig): McpServer {
  return createMcpRuntime(config).server;
}

export function createMcpRuntime(config: McpConfig): McpRuntime {
  const server = new McpServer(
    { name: APP_NAME, version: '0.1.0' },
    {
      instructions:
        'Query a repository knowledge graph: code symbols, the calls and references between them, ' +
        'and the APIs, services, data stores and documentation around them. ' +
        'When it is uncertain whether the repository open in this session is registered and indexed, call ensure_project once (no arguments needed): it returns the projectId and queues indexing only if the project is new, never indexed or stale. ' +
        'Otherwise start with resolve_project to turn a working directory into a project id, then get_index_status before relying on graph results. ' +
        'If nothing is indexed, or the state is never_indexed, call index_project with the repository root and poll get_index_status until ready. ' +
        'If the state is stale, files changed after indexing: graph relationships and line numbers near the changed files may be outdated — say so when it matters, read those files with get_source, and re-index with index_project when appropriate. ' +
        'Use search_graph to find symbols, routes, tables and other structure; get_node for one symbol’s details and relationships; trace_path for how two nodes connect through calls or dependencies; search_code for literal text in the source; get_source to read the code at any location the others report. ' +
        'Every call after the first carries the same projectId; there is no implicit project.',
    },
  );

  const api = new ApiClient({
    baseUrl: config.mcp.apiBaseUrl,
    timeoutMs: config.mcp.MCP_REQUEST_TIMEOUT_MS,
  });

  const projects = new ProjectEnsurer(api, config.project);

  // Registered in the order an agent uses them: the one-call opening move,
  // then its parts — which project, whether that project can answer anything,
  // making it able to if not — then asking it something.
  registerEnsureProject(server, projects);
  registerResolveProject(server, api);
  registerGetIndexStatus(server, api);
  registerIndexProject(server, api);
  registerSearchGraph(server, api);
  registerGetNode(server, api);
  registerTracePath(server, api);
  registerSearchCode(server, api);
  registerGetSource(server, api);

  return { server, projects };
}

interface StartupLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  debug(details: object, message: string): void;
}

/**
 * The startup check: register the current project and queue indexing if it
 * needs it, without holding up the session.
 *
 * Only ever fired and forgotten by `main` — the server is already answering
 * tool calls while this runs, and a run it queues is left to the worker. It
 * never throws: an API that is not running yet, or a directory that is not a
 * project, is a line on stderr, and `ensure_project` reports the same thing to
 * the model if it is called. An early `ensure_project` call shares this
 * check's result rather than repeating it.
 */
export async function ensureCurrentProjectOnStartup(
  runtime: McpRuntime,
  config: McpConfig,
  logger: StartupLogger,
): Promise<EnsureOutcome | null> {
  if (!config.mcp.MCP_AUTO_ENSURE_PROJECT) {
    logger.debug({}, 'automatic project check disabled (MCP_AUTO_ENSURE_PROJECT=false)');
    return null;
  }
  if (!runtime.projects.hasCurrentProject) {
    logger.debug({}, 'no current project directory in the environment; skipping the startup check');
    return null;
  }

  try {
    const outcome = await runtime.projects.ensure();
    logger.info(
      {
        projectId: outcome.projectId,
        rootPath: outcome.rootPath,
        action: outcome.action,
        status: outcome.status,
        indexingJobId: outcome.indexingJobId,
      },
      'current project checked',
    );
    return outcome;
  } catch (error) {
    logger.warn(
      {
        code: error instanceof ProjectRootError ? error.code : undefined,
        err: error instanceof Error ? error.message : String(error),
      },
      'could not check the current project on startup; ensure_project will report why',
    );
    return null;
  }
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

  const runtime = createMcpRuntime(config);
  const { server } = runtime;
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

  // Deliberately not awaited: the session is usable while this runs.
  void ensureCurrentProjectOnStartup(runtime, config, logger);
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
