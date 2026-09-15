import { createLogger } from '@ckg/shared/logger';
import { loadEnvFile } from '@ckg/shared/node';
import {
  AnalysisJobRepository,
  GraphRepository,
  ProjectRepository,
  SourceRepositoryRepository,
  createDatabaseFromEnv,
} from '@ckg/database';
import { buildApp, type AppServices } from './app.js';
import { loadApiConfig } from './config/index.js';
import { AnalysisService } from './modules/analysis/index.js';
import { GraphService } from './modules/graph/index.js';
import { HealthService } from './modules/health/index.js';
import { ProjectService } from './modules/projects/index.js';
import { RepositoryService } from './modules/repositories/index.js';

/**
 * Composition root. This is the only file that knows both how to reach the
 * database and how to build the HTTP app; everything else receives what it
 * needs.
 */
async function main(): Promise<void> {
  // Before configuration is read, and only here: config loaders stay pure.
  loadEnvFile();

  const config = loadApiConfig();

  const logger = createLogger({
    module: 'api',
    level: config.runtime.LOG_LEVEL,
    base: { service: 'api' },
  });

  const database = createDatabaseFromEnv(config.database, 'ckg-api');

  const projects = new ProjectService(new ProjectRepository(database));
  const repositories = new RepositoryService(
    new SourceRepositoryRepository(database),
    projects,
  );

  const services: AppServices = {
    projects,
    repositories,
    analysis: new AnalysisService(new AnalysisJobRepository(database), projects, repositories),
    graph: new GraphService(new GraphRepository(database), projects),
    health: new HealthService(database),
  };

  const app = await buildApp({ config, services, logger });

  const close = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await database.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  await app.listen({ port: config.http.PORT, host: config.http.HOST });
  logger.info(
    { port: config.http.PORT, host: config.http.HOST, docs: '/docs' },
    'API listening',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
