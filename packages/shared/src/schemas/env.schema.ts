import { z } from 'zod';

/**
 * Single source of truth for environment variables. Apps compose the slices
 * they need; nothing else in the codebase touches `process.env`.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'));

export const runtimeEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
});

export const apiEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
});

/**
 * The local-filesystem boundary.
 *
 * Choosing a project folder means the API reads directory listings on the
 * machine it runs on, and opens that machine's native folder dialog. That is
 * exactly right for the local-first tool this is, and exactly wrong for an API
 * reachable by anyone else — so it is one switch, and it is documented as the
 * thing you turn off when the API stops being yours alone.
 */
export const filesystemEnvSchema = z.object({
  LOCAL_FILESYSTEM_ENABLED: booleanish.default(true),
  /**
   * Hard ceiling on the native dialog. A dialog nobody answers must not pin a
   * request open forever.
   */
  DIRECTORY_PICKER_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
});

/**
 * The MCP server, which is an adapter and nothing else.
 *
 * Notably absent: `DATABASE_URL`. The MCP process reaches the graph over the
 * same HTTP API the web client uses and has no database credentials of its own,
 * which is the property that keeps it a thin adapter rather than a second way
 * into the data.
 */
export const mcpEnvSchema = z.object({
  /**
   * Where the API is. Left unset it follows the API's own `PORT` from the same
   * `.env`, so moving the API off a busy port needs no second edit — the web
   * dev server's proxy resolves its target the same way.
   */
  MCP_API_BASE_URL: z.string().min(1).optional(),
  /**
   * Ceiling on one call to the API.
   *
   * An MCP client is a conversation: a request that hangs stalls the person
   * waiting on it, so an answer that says the API did not respond beats one
   * that never arrives.
   */
  MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export const scipEnvSchema = z.object({
  SCIP_TYPESCRIPT_COMMAND: z.string().min(1).default('scip-typescript'),
  SCIP_INDEX_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
});

export const analysisEnvSchema = z.object({
  ANALYSIS_WORKSPACE_DIR: z.string().min(1).default('./.workspace'),
});

export const workerEnvSchema = z.object({
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  WORKER_RUN_ONCE: booleanish.default(false),
});

export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type FilesystemEnv = z.infer<typeof filesystemEnvSchema>;
export type McpEnv = z.infer<typeof mcpEnvSchema>;
export type ScipEnv = z.infer<typeof scipEnvSchema>;
export type AnalysisEnv = z.infer<typeof analysisEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Parses an environment slice and fails fast with a readable, secret-free
 * message. Values are never echoed back — only the offending variable names.
 */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Record<string, string | undefined>,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid environment configuration:\n${issues}`);
}
