import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResponse, CodeGraph, Project, ProjectSummary } from '@ckg/shared';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config/index.js';
import { AnalysisService } from '../src/modules/analysis/index.js';
import { FilesystemService } from '../src/modules/filesystem/index.js';
import { GraphService } from '../src/modules/graph/index.js';
import { HealthService } from '../src/modules/health/index.js';
import { ProjectService } from '../src/modules/projects/index.js';
import { RepositoryService } from '../src/modules/repositories/index.js';
import {
  InMemoryAnalysisJobStore,
  InMemoryGraphStore,
  InMemoryProjectStore,
  InMemoryRepositoryStore,
  StubHealthProbe,
} from './helpers/in-memory-stores.js';

const CONFIG: ApiConfig = {
  runtime: { NODE_ENV: 'test', LOG_LEVEL: 'error' },
  database: { DATABASE_URL: 'postgresql://unused', DATABASE_POOL_MAX: 1 },
  http: { PORT: 0, HOST: '127.0.0.1', CORS_ORIGIN: '*', corsOrigins: ['*'] },
  filesystem: { LOCAL_FILESYSTEM_ENABLED: true, DIRECTORY_PICKER_TIMEOUT_MS: 1000 },
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
  analyses: InMemoryAnalysisJobStore;
  graph: InMemoryGraphStore;
}

async function createHarness(options: { healthy?: boolean } = {}): Promise<Harness> {
  const projectStore = new InMemoryProjectStore();
  const repositoryStore = new InMemoryRepositoryStore();
  const analysisStore = new InMemoryAnalysisJobStore();
  const graphStore = new InMemoryGraphStore();

  // The listing joins across all four, the way the SQL does.
  projectStore.repositories = repositoryStore;
  projectStore.analyses = analysisStore;
  projectStore.graph = graphStore;

  const projects = new ProjectService(projectStore);
  const repositories = new RepositoryService(repositoryStore, projects);

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
      graph: new GraphService(graphStore, projects),
      health: new HealthService(new StubHealthProbe(options.healthy ?? true)),
    },
  });

  await app.ready();
  return { app, projects: projectStore, analyses: analysisStore, graph: graphStore };
}

function body<T>(response: { body: string }): ApiResponse<T> {
  return JSON.parse(response.body) as ApiResponse<T>;
}

describe('API', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.app.close();
  });

  describe('response envelope', () => {
    it('wraps success in { success, data, error, meta }', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'envelope' },
      });

      expect(response.statusCode).toBe(201);
      const payload = body<Project>(response);
      expect(payload.success).toBe(true);
      expect(payload.error).toBeNull();
      expect(payload.meta).toEqual({});
      expect(payload.data).toMatchObject({ name: 'envelope' });
    });

    it('wraps failures in the same envelope with a stable code', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/projects/00000000-0000-4000-8000-000000000000',
      });

      expect(response.statusCode).toBe(404);
      const payload = body(response);
      expect(payload.success).toBe(false);
      expect(payload.data).toBeNull();
      expect(payload.error).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    });

    it('reports validation failures per field', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: '' },
      });

      expect(response.statusCode).toBe(400);
      const payload = body(response);
      expect(payload.success).toBe(false);
      expect(payload.error?.code).toBe('VALIDATION_ERROR');
      expect(payload.error?.details?.[0]?.path).toBe('name');
    });

    it('rejects a malformed project id before reaching the service', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/projects/not-a-uuid' });

      expect(response.statusCode).toBe(400);
      expect(body(response).error?.code).toBe('VALIDATION_ERROR');
    });

    it('answers an unknown route with the same envelope', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/nope' });

      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('NOT_FOUND');
    });
  });

  describe('health', () => {
    it('reports ok when the database answers', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(body<{ status: string }>(response).data).toMatchObject({
        status: 'ok',
        checks: { database: 'ok' },
      });
    });

    it('reports degraded with 503 when the database is unreachable', async () => {
      const unhealthy = await createHarness({ healthy: false });
      const response = await unhealthy.app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);
      expect(body<{ status: string }>(response).data).toMatchObject({ status: 'degraded' });
      await unhealthy.app.close();
    });
  });

  describe('create project', () => {
    it('creates and then lists the project', async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'listed', description: 'a project' },
      });
      const project = body<Project>(created).data as Project;

      const fetched = await harness.app.inject({ method: 'GET', url: `/api/projects/${project.id}` });
      expect(body<Project>(fetched).data).toMatchObject({ id: project.id, name: 'listed' });

      const listed = await harness.app.inject({ method: 'GET', url: '/api/projects' });
      const payload = body<ProjectSummary[]>(listed);
      expect(payload.data?.some((item) => item.id === project.id)).toBe(true);
      expect(payload.meta).toMatchObject({ limit: 50, offset: 0 });
    });
  });

  describe('delete project', () => {
    /** A project with a repository, a finished run and a graph behind it. */
    async function seedProject(name: string): Promise<string> {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name },
      });
      const projectId = (body<Project>(created).data as Project).id;

      await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/repository`,
        payload: { sourceType: 'local', sourcePath: `/tmp/${name}` },
      });
      await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/analysis`,
        payload: {},
      });
      harness.graph.setGraph(sampleGraph(projectId));

      return projectId;
    }

    it('removes the project and everything that belonged to it', async () => {
      const projectId = await seedProject('to-delete');

      const deleted = await harness.app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}`,
      });

      expect(deleted.statusCode).toBe(200);
      // The envelope, like every other response: the web client parses it
      // unconditionally and a bodiless 204 would be the one it could not read.
      expect(body(deleted)).toMatchObject({ success: true, data: null, error: null });

      const fetched = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}`,
      });
      expect(fetched.statusCode).toBe(404);

      // The repository record and the run went with it, rather than being
      // orphaned rows pointing at a project that no longer exists.
      const repository = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/repository`,
      });
      expect(repository.statusCode).toBe(404);

      const analyses = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/analysis`,
      });
      expect(analyses.statusCode).toBe(404);
    });

    it('drops the project from the dashboard listing', async () => {
      const projectId = await seedProject('vanishes');

      await harness.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` });

      const listed = await harness.app.inject({ method: 'GET', url: '/api/projects' });
      const rows = body<ProjectSummary[]>(listed).data ?? [];
      expect(rows.some((row) => row.id === projectId)).toBe(false);
    });

    it('deletes a project whose analysis never finished', async () => {
      // A worker that died mid-run leaves a job stuck in a non-terminal state.
      // Refusing to delete until it finishes would strand exactly the project
      // most likely to need deleting.
      const projectId = await seedProject('stuck');

      const deleted = await harness.app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}`,
      });

      expect(deleted.statusCode).toBe(200);
    });

    it('reports an unknown project as missing, and says so again on a repeat', async () => {
      const projectId = await seedProject('gone-twice');

      expect(
        (await harness.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` }))
          .statusCode,
      ).toBe(200);

      const again = await harness.app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}`,
      });
      expect(again.statusCode).toBe(404);
      const payload = body(again);
      if (!payload.success) expect(payload.error.code).toBe('PROJECT_NOT_FOUND');
    });

    it('rejects an id that is not a uuid', async () => {
      const response = await harness.app.inject({
        method: 'DELETE',
        url: '/api/projects/not-a-uuid',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('dashboard listing', () => {
    it('carries repository, last run and graph size on every row', async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'dashboard-row' },
      });
      const projectId = (body<Project>(created).data as Project).id;

      await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/repository`,
        payload: { sourceType: 'local', sourcePath: 'test-repositories/typescript-sample' },
      });
      await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/analysis`,
        payload: {},
      });
      harness.graph.setGraph(sampleGraph(projectId));

      const listed = await harness.app.inject({ method: 'GET', url: '/api/projects' });
      const row = body<ProjectSummary[]>(listed).data?.find((item) => item.id === projectId);

      expect(row?.repository).toMatchObject({
        sourceType: 'local',
        sourcePath: 'test-repositories/typescript-sample',
      });
      expect(row?.latestAnalysis).toMatchObject({ status: 'QUEUED' });
      expect(row?.nodeCount).toBe(5);
      expect(row?.edgeCount).toBe(4);
      expect(row?.nodeTypeCounts).toMatchObject({ class: 3, interface: 1, repository: 1 });

      harness.graph.setGraph({ nodes: [], edges: [] });
      harness.analyses.complete((row?.latestAnalysis?.id ?? '') as string);
    });

    it('reports an un-analysed project as empty rather than omitting it', async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'never-analysed' },
      });
      const projectId = (body<Project>(created).data as Project).id;

      const listed = await harness.app.inject({ method: 'GET', url: '/api/projects' });
      const row = body<ProjectSummary[]>(listed).data?.find((item) => item.id === projectId);

      expect(row).toBeDefined();
      expect(row?.repository).toBeNull();
      expect(row?.latestAnalysis).toBeNull();
      expect(row?.nodeCount).toBe(0);
      expect(row?.nodeTypeCounts).toEqual({});
    });
  });

  describe('start analysis', () => {
    async function projectWithRepository(name: string): Promise<string> {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name },
      });
      const projectId = (body<Project>(created).data as Project).id;

      await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/repository`,
        payload: { sourceType: 'local', sourcePath: 'test-repositories/typescript-sample' },
      });

      return projectId;
    }

    it('queues a job and returns 202 rather than running it inline', async () => {
      const projectId = await projectWithRepository('analysis-queued');

      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/analysis`,
        payload: {},
      });

      expect(response.statusCode).toBe(202);
      expect(body<{ status: string }>(response).data).toMatchObject({ status: 'QUEUED', projectId });
    });

    it('refuses to start a second run while one is in flight', async () => {
      const projectId = await projectWithRepository('analysis-conflict');

      await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/analysis`,
        payload: {},
      });
      const second = await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/analysis`,
        payload: {},
      });

      expect(second.statusCode).toBe(409);
      expect(body(second).error?.code).toBe('ANALYSIS_ALREADY_RUNNING');
    });

    it('refuses to start without a repository', async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'no-repository' },
      });
      const projectId = (body<Project>(created).data as Project).id;

      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/analysis`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('REPOSITORY_NOT_FOUND');
    });

    it('retrieves a queued analysis and hides one belonging to another project', async () => {
      const projectId = await projectWithRepository('analysis-scoped');
      const queued = await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/analysis`,
        payload: {},
      });
      const analysisId = (body<{ id: string }>(queued).data as { id: string }).id;

      const found = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/analysis/${analysisId}`,
      });
      expect(found.statusCode).toBe(200);

      const otherProjectId = await projectWithRepository('analysis-other');
      const leaked = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${otherProjectId}/analysis/${analysisId}`,
      });
      expect(leaked.statusCode).toBe(404);
      expect(body(leaked).error?.code).toBe('ANALYSIS_NOT_FOUND');
    });
  });

  describe('retrieve graph', () => {
    let projectId: string;

    beforeAll(async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'graph-project' },
      });
      projectId = (body<Project>(created).data as Project).id;
      harness.graph.setGraph(sampleGraph(projectId));
    });

    it('returns an overview when no root node is given', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph`,
      });

      expect(response.statusCode).toBe(200);
      const payload = body<CodeGraph>(response);
      expect(payload.meta).toMatchObject({ mode: 'overview', rootNodeId: null });
      expect(payload.data?.nodes.length).toBeGreaterThan(0);
    });

    it('traverses outward from a root node to the requested depth', async () => {
      const depth1 = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=controller&depth=1`,
      });

      const payload = body<CodeGraph>(depth1);
      expect(payload.meta).toMatchObject({ mode: 'traversal', rootNodeId: 'controller', depth: 1 });
      expect(payload.data?.nodes.map((node) => node.id).sort()).toEqual([
        'controller',
        'repo',
        'service',
      ]);
    });

    it('reaches the whole call chain at a larger depth', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=controller&depth=3&relationships=CALLS,REFERENCES`,
      });

      expect(body<CodeGraph>(response).data?.nodes.map((node) => node.id).sort()).toEqual([
        'controller',
        'model',
        'repository',
        'service',
      ]);
    });

    it('accepts filters as repeated parameters as well as CSV', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=controller&depth=3&relationships=CALLS&relationships=REFERENCES`,
      });

      expect(response.statusCode).toBe(200);
      expect(body<CodeGraph>(response).data?.nodes).toHaveLength(4);
    });

    it('rejects a depth beyond the maximum instead of walking the whole repository', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=controller&depth=99`,
      });

      expect(response.statusCode).toBe(400);
      expect(body(response).error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown root node', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=missing`,
      });

      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('NODE_NOT_FOUND');
    });

    it('reports totals and the repository root through the summary', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/summary`,
      });

      expect(body<{ nodeCount: number }>(response).data).toMatchObject({
        nodeCount: 5,
        edgeCount: 4,
        rootNodeId: 'repo',
        nodeTypeCounts: { repository: 1, class: 3, interface: 1 },
      });
    });

    it('searches nodes by name', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/search?q=userservice`,
      });

      expect(body<Array<{ id: string }>>(response).data?.[0]?.id).toBe('service');
    });

    it('narrows the walk to one direction when asked', async () => {
      const outgoing = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=service&depth=1&direction=outgoing`,
      });

      expect(body<CodeGraph>(outgoing).meta).toMatchObject({ direction: 'outgoing' });
      expect(body<CodeGraph>(outgoing).data?.nodes.map((node) => node.id).sort()).toEqual([
        'repository',
        'service',
      ]);

      const incoming = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=service&depth=1&direction=incoming`,
      });

      expect(body<CodeGraph>(incoming).data?.nodes.map((node) => node.id).sort()).toEqual([
        'controller',
        'service',
      ]);
    });

    it('rejects a direction that is not one of the three', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?rootNodeId=service&direction=sideways`,
      });

      expect(response.statusCode).toBe(400);
      expect(body(response).error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('projections', () => {
    let projectId: string;

    beforeAll(async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'projection-project' },
      });
      projectId = (body<Project>(created).data as Project).id;
      harness.graph.setGraph(architecturalGraph(projectId));
    });

    it('applies a projection\u2019s filters when the caller sends none', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?projection=calls&rootNodeId=controller&depth=3`,
      });

      expect(body<CodeGraph>(response).meta).toMatchObject({
        projection: 'calls',
        relationships: ['CALLS'],
      });
      // CONTAINS and REFERENCES are outside the projection, so the repository
      // root and the model are unreachable.
      expect(body<CodeGraph>(response).data?.nodes.map((node) => node.id).sort()).toEqual([
        'controller',
        'repository',
        'service',
      ]);
    });

    it('lets an explicit filter override the projection', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?projection=calls&rootNodeId=repository&depth=1&relationships=WRITES_TO`,
      });

      // The relationship filter is the caller's; the projection's node-type
      // filter still applies, and `calls` does not include tables — so the
      // WRITES_TO edge is followed to a node the caller excluded, and stops.
      expect(body<CodeGraph>(response).meta).toMatchObject({
        projection: 'calls',
        relationships: ['WRITES_TO'],
        nodeTypes: ['class', 'interface', 'function', 'method'],
      });
      expect(body<CodeGraph>(response).data?.nodes.map((node) => node.id)).toEqual(['repository']);
    });

    it('lets both filters be overridden together', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?projection=calls&rootNodeId=repository&depth=1&relationships=WRITES_TO&nodeTypes=class,table`,
      });

      expect(body<CodeGraph>(response).data?.nodes.map((node) => node.id).sort()).toEqual([
        'repository',
        'table',
      ]);
    });

    it('reaches request to store with the architecture projection', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?projection=architecture&rootNodeId=api&depth=4`,
      });

      // POST /users -> UserController -> UserService -> UserRepository -> users
      const ids = (body<CodeGraph>(response).data?.nodes.map((node) => node.id) ?? []).sort();
      expect(ids).toEqual(['api', 'controller', 'repository', 'service', 'table']);
      // REFERENCES is outside the projection, so the model is not dragged in.
      expect(ids).not.toContain('model');
    });

    it('ranks the architecture projection\u2019s subjects first in an overview', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?projection=architecture&limit=3`,
      });

      const types = body<CodeGraph>(response).data?.nodes.map((node) => node.type) ?? [];
      expect(types[0]).toBe('api');
      expect(types).toContain('table');
    });

    it('leaves the graph unfiltered under the everything projection', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?projection=everything&rootNodeId=repo&depth=2`,
      });

      expect(body<CodeGraph>(response).meta).toMatchObject({
        projection: 'everything',
        nodeTypes: null,
        relationships: null,
      });
    });

    it('rejects a projection that does not exist', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph?projection=made-up`,
      });

      expect(response.statusCode).toBe(400);
      expect(body(response).error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('search', () => {
    let projectId: string;

    beforeAll(async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'search-project' },
      });
      projectId = (body<Project>(created).data as Project).id;
      harness.graph.setGraph(architecturalGraph(projectId));
    });

    const search = async (query: string) =>
      harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/search?${query}`,
      });

    it('finds an API by its path', async () => {
      const response = await search('q=POST%20%2Fusers');
      expect(body<Array<{ id: string }>>(response).data?.map((node) => node.id)).toEqual(['api']);
    });

    it('finds a node by its qualified name', async () => {
      const response = await search('q=postgresql.users');
      expect(body<Array<{ id: string }>>(response).data?.map((node) => node.id)).toEqual(['table']);
    });

    it('finds files by path fragment', async () => {
      const response = await search('q=src%2Fapi');
      expect(body<Array<{ id: string }>>(response).data?.map((node) => node.id)).toEqual(['api']);
    });

    it('finds every node of a type when the term names one', async () => {
      const response = await search('q=table');
      expect(body<Array<{ id: string }>>(response).data?.map((node) => node.id)).toEqual(['table']);
    });

    it('narrows results by node type', async () => {
      const response = await search('q=user&nodeTypes=table');
      expect(body<Array<{ type: string }>>(response).data?.every((node) => node.type === 'table')).toBe(
        true,
      );
    });

    it('pages, and reports the full total', async () => {
      const first = await search('q=user&limit=2&offset=0');
      const payload = body<Array<{ id: string }>>(first);

      expect(payload.data).toHaveLength(2);
      expect(payload.meta).toMatchObject({ limit: 2, offset: 0 });
      expect(Number(payload.meta.total)).toBeGreaterThan(2);

      const second = await search('q=user&limit=2&offset=2');
      const secondIds = body<Array<{ id: string }>>(second).data?.map((node) => node.id) ?? [];
      const firstIds = payload.data?.map((node) => node.id) ?? [];

      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    });

    it('rejects an empty term rather than returning the whole graph', async () => {
      const response = await search('q=');
      expect(response.statusCode).toBe(400);
    });
  });

  describe('retrieve node', () => {
    let projectId: string;

    beforeAll(async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'node-project' },
      });
      projectId = (body<Project>(created).data as Project).id;
      harness.graph.setGraph(sampleGraph(projectId));
    });

    it('returns the node with its callers, callees and references', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/nodes/service`,
      });

      expect(response.statusCode).toBe(200);
      const detail = body<{
        node: { name: string; filePath: string; startLine: number };
        callers: Array<{ id: string }>;
        callees: Array<{ id: string }>;
        references: Array<{ id: string }>;
      }>(response).data;

      expect(detail?.node).toMatchObject({ name: 'UserService', startLine: 1 });
      expect(detail?.callers.map((item) => item.id)).toEqual(['controller']);
      expect(detail?.callees.map((item) => item.id)).toEqual(['repository']);
      expect(detail?.references).toEqual([]);
    });

    it('serves callers and callees on their own routes', async () => {
      const callers = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/nodes/service/callers`,
      });
      expect(body<Array<{ id: string }>>(callers).data?.map((item) => item.id)).toEqual([
        'controller',
      ]);

      const callees = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/nodes/service/callees`,
      });
      expect(body<Array<{ id: string }>>(callees).data?.map((item) => item.id)).toEqual([
        'repository',
      ]);
    });

    it('reports references for a model node', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/nodes/model`,
      });

      expect(
        body<{ references: Array<{ id: string }> }>(response).data?.references.map(
          (item) => item.id,
        ),
      ).toEqual(['repository']);
    });

    it('404s for a node that does not exist', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/nodes/nope`,
      });

      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('NODE_NOT_FOUND');
    });

    it('serves references on their own route too', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/nodes/model/references`,
      });

      expect(body<Array<{ id: string }>>(response).data?.map((item) => item.id)).toEqual([
        'repository',
      ]);
    });
  });

  describe('node detail over an architectural graph', () => {
    let projectId: string;

    beforeAll(async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'detail-project' },
      });
      projectId = (body<Project>(created).data as Project).id;
      harness.graph.setGraph(architecturalGraph(projectId));
    });

    const detail = async (nodeId: string) =>
      body<{
        node: { name: string };
        callers: Array<{ id: string }>;
        callees: Array<{ id: string }>;
        references: Array<{ id: string }>;
        dependencies: Array<{ id: string; relationship: string }>;
        dependents: Array<{ id: string; relationship: string }>;
        apis: Array<{ id: string; relationship: string }>;
        databases: Array<{ id: string; relationship: string; confidence?: string }>;
      }>(
        await harness.app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/graph/nodes/${nodeId}`,
        }),
      ).data;

    it('keeps the original three sections exactly as they were', async () => {
      const service = await detail('service');

      expect(service?.callers.map((item) => item.id)).toEqual(['controller']);
      expect(service?.callees.map((item) => item.id)).toEqual(['repository']);
      expect(service?.references).toEqual([]);
      // The original sections carry no relationship field, as before.
      expect(service?.callers[0]).not.toHaveProperty('relationship');
    });

    it('reports the APIs that reach a controller', async () => {
      const controller = await detail('controller');

      expect(controller?.apis).toEqual([
        expect.objectContaining({ id: 'api', relationship: 'ROUTES_TO' }),
      ]);
    });

    it('reports the data stores a repository touches, with the evidence', async () => {
      const repository = await detail('repository');

      expect(repository?.databases).toEqual([
        expect.objectContaining({
          id: 'table',
          relationship: 'WRITES_TO',
          confidence: 'high',
          evidenceSource: 'database-analyzer',
        }),
      ]);
    });

    it('reports dependencies and dependents in the right direction', async () => {
      const service = await detail('svc');
      expect(service?.dependencies).toEqual([
        expect.objectContaining({ id: 'pkg', relationship: 'DEPENDS_ON' }),
      ]);

      const packageNode = await detail('pkg');
      expect(packageNode?.dependents).toEqual([
        expect.objectContaining({ id: 'svc', relationship: 'DEPENDS_ON' }),
      ]);
    });

    it('leaves a section empty rather than inventing entries', async () => {
      const model = await detail('model');

      expect(model?.apis).toEqual([]);
      expect(model?.databases).toEqual([]);
      expect(model?.dependencies).toEqual([]);
    });

    it('reports relationship composition through the summary', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/summary`,
      });

      expect(body<{ relationshipCounts: Record<string, number> }>(response).data).toMatchObject({
        nodeTypeCounts: { api: 1, table: 1, service: 1 },
        relationshipCounts: { ROUTES_TO: 1, WRITES_TO: 1, DEPENDS_ON: 1 },
      });
    });
  });

  it('publishes an OpenAPI document covering every module', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/docs/json' });
    const document = JSON.parse(response.body) as { paths: Record<string, unknown> };

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/api/projects',
        '/api/projects/{projectId}',
        '/api/projects/{projectId}/repository',
        '/api/projects/{projectId}/analysis',
        '/api/projects/{projectId}/analysis/{analysisId}',
        '/api/projects/{projectId}/graph',
        '/api/projects/{projectId}/graph/nodes/{nodeId}',
        '/api/projects/{projectId}/graph/nodes/{nodeId}/callers',
        '/api/projects/{projectId}/graph/nodes/{nodeId}/callees',
        '/api/projects/{projectId}/graph/nodes/{nodeId}/references',
      ]),
    );
  });
});
