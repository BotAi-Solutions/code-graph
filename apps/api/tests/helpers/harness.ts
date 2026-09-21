import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ApiResponse, CodeGraph, Project, ProjectSummary } from '@ckg/shared';
import { buildApp } from '../../src/app.js';
import type { ApiConfig } from '../../src/config/index.js';
import { AnalysisService } from '../../src/modules/analysis/index.js';
import { CodeSearchService } from '../../src/modules/code-search/index.js';
import { FilesystemService } from '../../src/modules/filesystem/index.js';
import { GraphService } from '../../src/modules/graph/index.js';
import { HealthService } from '../../src/modules/health/index.js';
import { ProjectService } from '../../src/modules/projects/index.js';
import { RepositoryService } from '../../src/modules/repositories/index.js';
import { SourceRoots, SourceService } from '../../src/modules/source/index.js';
import {
  InMemoryAnalysisJobStore,
  InMemoryGraphStore,
  InMemoryProjectStore,
  InMemoryRepositoryStore,
  StubHealthProbe,
} from './in-memory-stores.js';

/** The monorepo root, so a relative repository `sourcePath` resolves the same
 * way here as it does under the worker. */
const WORKSPACE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const CONFIG: ApiConfig = {
  runtime: { NODE_ENV: 'test', LOG_LEVEL: 'error' },
  database: { DATABASE_URL: 'postgresql://unused', DATABASE_POOL_MAX: 1 },
  http: { PORT: 0, HOST: '127.0.0.1', CORS_ORIGIN: '*', corsOrigins: ['*'] },
  filesystem: {
    LOCAL_FILESYSTEM_ENABLED: true,
    DIRECTORY_PICKER_TIMEOUT_MS: 1000,
    repositoryBaseDirectory: WORKSPACE_ROOT,
  },
};

/** The sample application's shape, as the builder would produce it. */
function sampleGraph(projectId: string): CodeGraph {
  const node = (id: string, type: CodeGraph['nodes'][number]['type'], name: string) => ({
    id,
    projectId,
    type,
    name,
    filePath: `src/${name}.ts`,
    startLine: 1,
    endLine: 20,
  });

  const edge = (
    source: string,
    relationship: CodeGraph['edges'][number]['relationship'],
    target: string,
    metadata?: Record<string, unknown>,
  ) => ({
    id: `${source}-${relationship}-${target}`,
    projectId,
    sourceNodeId: source,
    targetNodeId: target,
    relationship,
    ...(metadata ? { metadata } : {}),
  });

  return {
    nodes: [
      node('repo', 'repository', 'sample'),
      node('controller', 'class', 'UserController'),
      node('service', 'class', 'UserService'),
      node('repository', 'class', 'UserRepository'),
      node('model', 'interface', 'User'),
    ],
    edges: [
      edge('repo', 'CONTAINS', 'controller'),
      edge('controller', 'CALLS', 'service'),
      edge('service', 'CALLS', 'repository'),
      edge('repository', 'REFERENCES', 'model'),
    ],
  };
}

/**
 * The same application with its architectural layer, as the analyzers add it:
 * a route, a table, a package and the service itself.
 */
function architecturalGraph(projectId: string): CodeGraph {
  const base = sampleGraph(projectId);

  const node = (
    id: string,
    type: CodeGraph['nodes'][number]['type'],
    name: string,
    extra: Record<string, unknown> = {},
  ) => ({ id, projectId, type, name, ...extra });

  const edge = (
    source: string,
    relationship: CodeGraph['edges'][number]['relationship'],
    target: string,
    metadata: Record<string, unknown>,
  ) => ({
    id: `${source}-${relationship}-${target}`,
    projectId,
    sourceNodeId: source,
    targetNodeId: target,
    relationship,
    metadata,
  });

  return {
    nodes: [
      ...base.nodes,
      node('api', 'api', 'POST /users', {
        qualifiedName: 'POST /users',
        filePath: 'src/api/user.routes.ts',
        startLine: 4,
        metadata: { httpMethod: 'POST', path: '/users', framework: 'express' },
      }),
      node('table', 'table', 'users', { qualifiedName: 'postgresql.users' }),
      node('svc', 'service', 'users-service', { qualifiedName: 'users-service' }),
      node('pkg', 'module', 'express', {
        qualifiedName: 'express',
        metadata: { external: true },
      }),
    ],
    edges: [
      ...base.edges,
      edge('api', 'ROUTES_TO', 'controller', { source: 'api-analyzer', confidence: 'high' }),
      edge('repository', 'WRITES_TO', 'table', {
        source: 'database-analyzer',
        confidence: 'high',
        statement: 'INSERT',
      }),
      edge('svc', 'DEPENDS_ON', 'pkg', { source: 'import-analyzer', confidence: 'high' }),
      edge('svc', 'CONTAINS', 'api', { source: 'api-analyzer', confidence: 'high' }),
    ],
  };
}

interface Harness {
  app: FastifyInstance;
  projects: InMemoryProjectStore;
  repositories: InMemoryRepositoryStore;
  analyses: InMemoryAnalysisJobStore;
  graph: InMemoryGraphStore;
}

async function createHarness(
  options: {
    healthy?: boolean;
    filesystemEnabled?: boolean;
    /**
     * Whether path resolution may resolve symlinks. Off by default so the
     * route suite's assertions depend on the paths a test wrote and not on the
     * runner's own filesystem; the resolution suite turns it on where that is
     * the thing under test.
     */
    canonicalizePaths?: boolean;
    /** Overridden by suites that build a throwaway repository on disk. */
    repositoryBaseDirectory?: string;
  } = {},
): Promise<Harness> {
  const projectStore = new InMemoryProjectStore();
  const repositoryStore = new InMemoryRepositoryStore();
  const analysisStore = new InMemoryAnalysisJobStore();
  const graphStore = new InMemoryGraphStore();

  // The listing joins across all four, the way the SQL does.
  projectStore.repositories = repositoryStore;
  projectStore.analyses = analysisStore;
  projectStore.graph = graphStore;

  const projects = new ProjectService(projectStore, repositoryStore, {
    repositoryBaseDirectory: WORKSPACE_ROOT,
    canonicalizePaths: options.canonicalizePaths ?? false,
  });
  const repositories = new RepositoryService(repositoryStore, projects);
  const graph = new GraphService(graphStore, projects);

  // The real source-access policy, so the suites that search or read files go
  // through the same root resolution production does.
  const sourceRoots = new SourceRoots(repositories, {
    enabled: options.filesystemEnabled ?? true,
    repositoryBaseDirectory: options.repositoryBaseDirectory ?? WORKSPACE_ROOT,
  });

  const app = await buildApp({
    config: CONFIG,
    services: {
      filesystem: new FilesystemService({
        enabled: true,
        picker: { isAvailable: () => false, pick: async () => null },
        pickerTimeoutMs: 1000,
      }),
      projects,
      repositories,
      analysis: new AnalysisService(analysisStore, projects, repositories),
      graph,
      source: new SourceService(repositories, graph, {
        enabled: options.filesystemEnabled ?? true,
        repositoryBaseDirectory: options.repositoryBaseDirectory ?? WORKSPACE_ROOT,
      }),
      codeSearch: new CodeSearchService(sourceRoots, projects),
      health: new HealthService(new StubHealthProbe(options.healthy ?? true)),
    },
  });

  await app.ready();
  return {
    app,
    projects: projectStore,
    repositories: repositoryStore,
    analyses: analysisStore,
    graph: graphStore,
  };
}

function body<T>(response: { body: string }): ApiResponse<T> {
  return JSON.parse(response.body) as ApiResponse<T>;
}

export { body, createHarness, sampleGraph, architecturalGraph, CONFIG, WORKSPACE_ROOT };
export type { Harness };
