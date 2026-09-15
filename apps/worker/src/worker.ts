import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@ckg/shared/logger';
import { loadEnvFile } from '@ckg/shared/node';
import {
  AnalysisJobRepository,
  GraphRepository,
  SourceRepositoryRepository,
  createDatabaseFromEnv,
} from '@ckg/database';
import { LanguageDetectionService } from '@ckg/language-detection';
import { createDefaultIndexerRegistry } from '@ckg/scip';
import { loadWorkerConfig, type WorkerConfig } from './config/index.js';
import { AnalyzeRepositoryJob } from './jobs/analyze-repository.job.js';
import { AnalysisProcessor } from './processors/analysis.processor.js';
import { AnalysisWorkspace } from './services/analysis-workspace.js';
import { PostgresAnalysisJobQueue } from './services/job-queue.js';
import { RepositoryLoader } from './services/repository-loader.js';

/**
 * Worker entry point. Wires the pipeline's dependencies once and hands them to
 * the processor; everything below this file is plain objects and interfaces.
 */

export interface Worker {
  processor: AnalysisProcessor;
  shutdown: () => Promise<void>;
}

export function createWorker(config: WorkerConfig): Worker {
  const logger = createLogger({
    module: 'worker',
    level: config.runtime.LOG_LEVEL,
    base: { service: 'worker' },
  });

  const database = createDatabaseFromEnv(config.database, 'ckg-worker');

  const analysisJobs = new AnalysisJobRepository(database);
  const repositories = new SourceRepositoryRepository(database);
  const graph = new GraphRepository(database);

  const indexers = createDefaultIndexerRegistry({
    typescriptCommand: config.scip.SCIP_TYPESCRIPT_COMMAND,
    timeoutMs: config.scip.SCIP_INDEX_TIMEOUT_MS,
    executableSearchRoots: [process.cwd()],
  });

  const job = new AnalyzeRepositoryJob({
    analysisJobs,
    repositories,
    graph,
    languageDetection: new LanguageDetectionService(),
    indexers,
    repositoryLoader: new RepositoryLoader({ baseDirectory: config.analysis.repositoryBaseDir }),
    workspace: new AnalysisWorkspace(config.analysis.workspaceDir),
    logger,
    scipTimeoutMs: config.scip.SCIP_INDEX_TIMEOUT_MS,
  });

  const processor = new AnalysisProcessor({
    queue: new PostgresAnalysisJobQueue(analysisJobs),
    job,
    analysisJobs,
    logger,
    pollIntervalMs: config.worker.WORKER_POLL_INTERVAL_MS,
  });

  logger.info(
    {
      repositoryBaseDir: config.analysis.repositoryBaseDir,
      workspaceDir: config.analysis.workspaceDir,
    },
    'worker configured',
  );

  return {
    processor,
    shutdown: async () => {
      processor.stop();
      await database.close();
    },
  };
}

async function main(): Promise<void> {
  // Before configuration is read, and only here: config loaders stay pure.
  loadEnvFile();

  const config = loadWorkerConfig();
  const worker = createWorker(config);

  const shutdown = (signal: string): void => {
    process.stderr.write(`worker received ${signal}, shutting down\n`);
    void worker.shutdown().then(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  if (config.worker.WORKER_RUN_ONCE) {
    // Used by scripts and tests: drain the queue, then exit.
    while (await worker.processor.tick()) {
      /* keep draining */
    }
    await worker.shutdown();
    return;
  }

  await worker.processor.start();
}

// Only run when executed directly, so tests can import `createWorker`.
const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPoint !== null && fileURLToPath(import.meta.url) === entryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
