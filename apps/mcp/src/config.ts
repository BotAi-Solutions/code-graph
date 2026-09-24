import {
  apiEnvSchema,
  mcpEnvSchema,
  parseEnv,
  runtimeEnvSchema,
  type McpEnv,
  type RuntimeEnv,
} from '@ckg/shared';

/**
 * The single place the MCP server reads `process.env`, matching the API's and
 * the worker's config loaders. Everything else receives a typed `McpConfig`.
 */

export interface McpConfig {
  runtime: RuntimeEnv;
  mcp: McpEnv & {
    /** The API's base URL with no trailing slash, ready to concatenate paths onto. */
    apiBaseUrl: string;
  };
  /**
   * Where the client says the current project is, as the environment handed
   * it over — unvalidated. `project-root.ts` turns this into a directory, so
   * nothing else needs to know which variable it came from.
   */
  project: ProjectDirectoryHint | null;
}

/** A directory named by the environment, and which variable named it. */
export interface ProjectDirectoryHint {
  path: string;
  source: ProjectDirectoryVariable;
}

/**
 * The variables that can name the current project, in order of preference.
 *
 * `CLAUDE_PROJECT_DIR` is set by Claude Code in the environment of every stdio
 * server it launches, and it is the only one that follows the person from
 * repository to repository without per-repository configuration.
 * `CODERAG_PROJECT_DIR` is for other clients, which can set it in their own
 * server configuration.
 *
 * The working directory is deliberately not a fallback: Claude Code starts a
 * user-scoped server in its own configuration directory, not the project, so
 * `process.cwd()` would name the wrong directory with confidence.
 */
export const PROJECT_DIRECTORY_VARIABLES = ['CLAUDE_PROJECT_DIR', 'CODERAG_PROJECT_DIR'] as const;
export type ProjectDirectoryVariable = (typeof PROJECT_DIRECTORY_VARIABLES)[number];

const mcpEnvSchemaFull = runtimeEnvSchema.and(apiEnvSchema).and(mcpEnvSchema);

/**
 * Resolves where the API is.
 *
 * `MCP_API_BASE_URL` wins when it is set. Otherwise the API's own `PORT` from
 * the same `.env` decides, which is what makes the default configuration work
 * for someone who moved the API off a busy port and never thought about MCP —
 * the web dev server's proxy target is resolved the same way, for the same
 * reason.
 *
 * `HOST` is deliberately not consulted: it is the address the API *binds* to,
 * commonly `0.0.0.0`, which is not an address anything can connect to.
 */
export function loadMcpConfig(
  source: Record<string, string | undefined> = process.env,
): McpConfig {
  const env = parseEnv(mcpEnvSchemaFull, source);
  const configured = env.MCP_API_BASE_URL ?? `http://localhost:${String(env.PORT)}`;

  let parsed: URL;
  try {
    // Parsed rather than pattern-matched so a typo fails here, with the
    // variable's name, instead of at the first tool call with a fetch error.
    parsed = new URL(configured);
  } catch {
    throw new Error(
      'Invalid environment configuration:\n  - MCP_API_BASE_URL: must be an absolute http(s) URL',
    );
  }

  // `new URL` accepts far more than an address: `localhost:3000` parses
  // happily, as a `localhost:` scheme with `3000` for a path. Checking the
  // protocol is what turns the commonest typo into a startup error instead of
  // every tool call reporting that the API cannot be reached.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      'Invalid environment configuration:\n  - MCP_API_BASE_URL: must be an absolute http(s) URL',
    );
  }

  const apiBaseUrl = parsed.toString().replace(/\/+$/, '');

  let project: ProjectDirectoryHint | null = null;
  for (const variable of PROJECT_DIRECTORY_VARIABLES) {
    const value = source[variable]?.trim();
    if (value) {
      project = { path: value, source: variable };
      break;
    }
  }

  return {
    runtime: { NODE_ENV: env.NODE_ENV, LOG_LEVEL: env.LOG_LEVEL },
    mcp: {
      MCP_API_BASE_URL: env.MCP_API_BASE_URL,
      MCP_REQUEST_TIMEOUT_MS: env.MCP_REQUEST_TIMEOUT_MS,
      MCP_AUTO_ENSURE_PROJECT: env.MCP_AUTO_ENSURE_PROJECT,
      apiBaseUrl,
    },
    project,
  };
}
