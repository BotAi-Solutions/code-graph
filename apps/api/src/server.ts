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
import { CodeSearchService } from './modules/code-search/index.js';
import { FilesystemService, NativeDirectoryPicker } from './modules/filesystem/index.js';
import { GraphService } from './modules/graph/index.js';
import { HealthService } from './modules/health/index.js';
import { ProjectService } from './modules/projects/index.js';
import { RepositoryService } from './modules/repositories/index.js';
import { SourceRoots, SourceService } from './modules/source/index.js';

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

  const sourceRepositories = new SourceRepositoryRepository(database);
  const projects = new ProjectService(new ProjectRepository(database), sourceRepositories, {
    repositoryBaseDirectory: config.filesystem.repositoryBaseDirectory,
    // Resolving symlinks only means something when the API shares a filesystem
    // with whoever is asking; the same switch decides both.
    canonicalizePaths: config.filesystem.LOCAL_FILESYSTEM_ENABLED,
  });
  const repositories = new RepositoryService(sourceRepositories, projects);
  const graph = new GraphService(new GraphRepository(database), projects);

  // One source-access policy, shared by the two things that read files.
  const sourceRoots = new SourceRoots(repositories, {
    enabled: config.filesystem.LOCAL_FILESYSTEM_ENABLED,
    repositoryBaseDirectory: config.filesystem.repositoryBaseDirectory,
  });

  const services: AppServices = {
    filesystem: new FilesystemService({
      enabled: config.filesystem.LOCAL_FILESYSTEM_ENABLED,
      picker: new NativeDirectoryPicker(),
      pickerTimeoutMs: config.filesystem.DIRECTORY_PICKER_TIMEOUT_MS,
    }),
    projects,
    repositories,
    analysis: new AnalysisService(new AnalysisJobRepository(database), projects, repositories),
    graph,
    source: new SourceService(repositories, graph, {
      enabled: config.filesystem.LOCAL_FILESYSTEM_ENABLED,
      repositoryBaseDirectory: config.filesystem.repositoryBaseDirectory,
    }),
    codeSearch: new CodeSearchService(sourceRoots, projects),
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
