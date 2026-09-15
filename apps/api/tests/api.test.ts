import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResponse, CodeGraph, Project, ProjectSummary } from '@ckg/shared';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config/index.js';
import { AnalysisService } from '../src/modules/analysis/index.js';
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
  ) => ({
    id: `${source}-${relationship}-${target}`,
    projectId,
    sourceNodeId: source,
    targetNodeId: target,
    relationship,
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
      ]),
    );
  });
});
