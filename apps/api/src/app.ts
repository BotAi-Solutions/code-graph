import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { API_PREFIX, APP_NAME } from '@ckg/shared';
import type { ApiConfig } from './config/index.js';
import { registerErrorHandler } from './common/errors/index.js';
import { createLogController } from './common/middleware/index.js';
import { analysisRoutes, type AnalysisService } from './modules/analysis/index.js';
import { filesystemRoutes, type FilesystemService } from './modules/filesystem/index.js';
import { graphRoutes, type GraphService } from './modules/graph/index.js';
import { healthRoutes, type HealthService } from './modules/health/index.js';
import { projectRoutes, type ProjectService } from './modules/projects/index.js';
import { repositoryRoutes, type RepositoryService } from './modules/repositories/index.js';
import { sourceRoutes, type SourceService } from './modules/source/index.js';

/**
 * Assembles the HTTP layer from already-constructed services.
 *
 * `buildApp` takes its dependencies rather than creating them, so a test can
 * hand it in-memory stores and exercise every route without a database or a
 * running worker.
 */

export interface AppServices {
  filesystem: FilesystemService;
  projects: ProjectService;
  repositories: RepositoryService;
  analysis: AnalysisService;
  graph: GraphService;
  source: SourceService;
  health: HealthService;
}

export interface BuildAppOptions {
  config: ApiConfig;
  services: AppServices;
  /**
   * Typed as Fastify's own logger interface rather than pino's concrete one:
   * naming the concrete type here would specialise every `FastifyInstance`
   * generic downstream.
   */
  logger?: FastifyBaseLogger;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, services } = options;

  const app = Fastify({
    // Fastify owns request logging; `loggerInstance` keeps it on the same
    // structured logger the rest of the process uses.
    ...(options.logger ? { loggerInstance: options.logger } : { logger: false }),
    logController: createLogController(),
    genReqId: () => crypto.randomUUID(),
    ajv: { customOptions: { coerceTypes: false } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  await app.register(cors, {
    origin: config.http.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Code Knowledge Graph API',
        description:
          'Analyses repositories with SCIP, stores a normalised code knowledge graph and serves it for traversal.',
        version: '0.1.0',
      },
      servers: [{ url: `http://${config.http.HOST}:${String(config.http.PORT)}` }],
      tags: [
        { name: 'health', description: 'Liveness and dependencies' },
        {
          name: 'filesystem',
          description: 'Choosing and sizing up a local project folder',
        },
        { name: 'projects', description: 'Units of analysis' },
        { name: 'repositories', description: 'Source repositories attached to a project' },
        { name: 'analysis', description: 'Analysis runs' },
        { name: 'graph', description: 'Code knowledge graph queries' },
        {
          name: 'source',
          description: 'Reading source from a project\u2019s indexed repository',
        },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Health sits outside the API prefix: orchestrators expect /health.
  await app.register(healthRoutes(services.health));

  await app.register(
    async (api) => {
      await api.register(filesystemRoutes(services.filesystem));
      await api.register(projectRoutes(services.projects));
      await api.register(repositoryRoutes(services.repositories));
      await api.register(analysisRoutes(services.analysis));
      await api.register(graphRoutes(services.graph));
      await api.register(sourceRoutes(services.source));
    },
    { prefix: API_PREFIX },
  );

  app.log.debug({ app: APP_NAME }, 'application assembled');

  return app;
}
