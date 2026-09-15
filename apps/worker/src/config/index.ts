import path from 'node:path';
import {
  analysisEnvSchema,
  databaseEnvSchema,
  parseEnv,
  runtimeEnvSchema,
  scipEnvSchema,
  workerEnvSchema,
  type AnalysisEnv,
  type DatabaseEnv,
  type RuntimeEnv,
  type ScipEnv,
  type WorkerEnv,
} from '@ckg/shared';
import { findWorkspaceRoot } from '@ckg/shared/node';

/**
 * The single place the worker reads `process.env`. Everything else receives a
 * typed `WorkerConfig`, which is what makes the pipeline testable without
 * environment juggling.
 */

export interface WorkerConfig {
  runtime: RuntimeEnv;
  database: DatabaseEnv;
  scip: ScipEnv;
  analysis: AnalysisEnv & {
    workspaceDir: string;
    /** Base directory that a relative repository `sourcePath` resolves against. */
    repositoryBaseDir: string;
  };
  worker: WorkerEnv;
}

const workerEnvSchemaFull = runtimeEnvSchema
  .and(databaseEnvSchema)
  .and(scipEnvSchema)
  .and(analysisEnvSchema)
  .and(workerEnvSchema);

export function loadWorkerConfig(
  source: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const env = parseEnv(workerEnvSchemaFull, source);
  const repositoryBaseDir = findWorkspaceRoot();

  return {
    runtime: { NODE_ENV: env.NODE_ENV, LOG_LEVEL: env.LOG_LEVEL },
    database: { DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX },
    scip: {
      SCIP_TYPESCRIPT_COMMAND: env.SCIP_TYPESCRIPT_COMMAND,
      SCIP_INDEX_TIMEOUT_MS: env.SCIP_INDEX_TIMEOUT_MS,
    },
    analysis: {
      ANALYSIS_WORKSPACE_DIR: env.ANALYSIS_WORKSPACE_DIR,
      workspaceDir: path.resolve(repositoryBaseDir, env.ANALYSIS_WORKSPACE_DIR),
      repositoryBaseDir,
    },
    worker: {
      WORKER_POLL_INTERVAL_MS: env.WORKER_POLL_INTERVAL_MS,
      WORKER_CONCURRENCY: env.WORKER_CONCURRENCY,
      WORKER_RUN_ONCE: env.WORKER_RUN_ONCE,
    },
  };
}
