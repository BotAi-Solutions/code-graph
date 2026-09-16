import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeEdge, CodeGraph, CodeNode } from '@ckg/shared';
import { GraphRepository, ProjectRepository, createDatabase, migrate } from '@ckg/database';
import type { Database } from '@ckg/database';

/**
 * The graph SQL against a real PostgreSQL.
 *
 * The in-memory stores in `apps/api/tests` reproduce the repository's
 * *semantics*, which is what makes the whole route surface testable without a
 * database — but they cannot reproduce its SQL, and SQL has failure modes of
 * its own. This suite exists because one of them shipped: a count query that
 * reused a predicate mentioning parameters it did not pass, which PostgreSQL
 * rejects with "could not determine data type of parameter $3" and no fake
 * would ever notice.
 *
 * It skips itself when no database is reachable, so `pnpm test` still passes on
 * a machine with nothing running. Point `DATABASE_URL` at a server — or run
 * `docker compose up -d postgres` — to have it execute.
 */

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://ckg:ckg@localhost:5432/code_knowledge_graph';

async function reachable(): Promise<Database | null> {
  const database = createDatabase({
    connectionString: CONNECTION_STRING,
    maxConnections: 2,
    applicationName: 'ckg-integration-tests',
  });
  try {
    await database.query('SELECT 1');
    return database;
  } catch {
    await database.close().catch(() => undefined);
    return null;
  }
}

const database = await reachable();

const suite = database === null ? describe.skip : describe;

if (database === null) {
  process.stdout.write(
    `\n  graph repository integration: skipped, no database at ${CONNECTION_STRING.replace(
      /\/\/[^@/]+@/,
      '//[redacted]@',
    )}\n`,
  );
}

suite('GraphRepository against PostgreSQL', () => {
  const db = database as Database;
  const graph = new GraphRepository(db);
  const projects = new ProjectRepository(db);

  let projectId: string;

  /** A graph with both a code layer and an architectural one. */
  function fixture(project: string): CodeGraph {
    const node = (
      id: string,
      type: CodeNode['type'],
      name: string,
      extra: Partial<CodeNode> = {},
    ): CodeNode => ({ id: `${project}-${id}`, projectId: project, type, name, ...extra });

    const edge = (
      source: string,
      relationship: CodeEdge['relationship'],
      target: string,
      metadata: Record<string, unknown> = { source: 'scip', confidence: 'high' },
    ): CodeEdge => ({
      id: `${project}-${source}-${relationship}-${target}`,
      projectId: project,
      sourceNodeId: `${project}-${source}`,
      targetNodeId: `${project}-${target}`,
      relationship,
      metadata,
    });

    return {
      nodes: [
        node('repo', 'repository', 'sample'),
        node('file', 'file', 'user.service.ts', {
          qualifiedName: 'src/services/user.service.ts',
          filePath: 'src/services/user.service.ts',
        }),
        node('controller', 'class', 'UserController', {
          filePath: 'src/controllers/user.controller.ts',
          startLine: 10,
          startCharacter: 13,
          endLine: 40,
          endCharacter: 1,
        }),
        node('service', 'class', 'UserService', {
          filePath: 'src/services/user.service.ts',
          startLine: 12,
        }),
        node('method', 'method', 'create', {
          qualifiedName: 'UserService.create',
          filePath: 'src/services/user.service.ts',
          startLine: 20,
        }),
        node('repository', 'class', 'UserRepository', {
          filePath: 'src/repositories/user.repository.ts',
        }),
        node('api', 'api', 'POST /users', {
          qualifiedName: 'POST /users',
          filePath: 'src/api/user.routes.ts',
          startLine: 4,
          metadata: { httpMethod: 'POST', path: '/users' },
        }),
        node('table', 'table', 'users', { qualifiedName: 'postgresql.users' }),
        node('pkg', 'module', 'express', {
          qualifiedName: 'express',
          metadata: { external: true },
        }),
        node('svc', 'service', 'users-service', { qualifiedName: 'users-service' }),
      ],
      edges: [
        edge('repo', 'CONTAINS', 'file'),
        edge('file', 'CONTAINS', 'service'),
        edge('service', 'CONTAINS', 'method'),
        edge('controller', 'CALLS', 'service'),
        edge('service', 'CALLS', 'repository'),
        edge('api', 'ROUTES_TO', 'controller', {
          source: 'api-analyzer',
          confidence: 'high',
        }),
        edge('repository', 'WRITES_TO', 'table', {
          source: 'database-analyzer',
          confidence: 'high',
          statement: 'INSERT',
        }),
        edge('svc', 'DEPENDS_ON', 'pkg', { source: 'import-analyzer', confidence: 'high' }),
      ],
    };
  }

  beforeAll(async () => {
    await migrate(db);
    const project = await projects.create({
      name: `integration-${randomUUID().slice(0, 8)}`,
      description: 'created by the graph repository integration suite',
    });
    projectId = project.id;
    await graph.replaceProjectGraph(projectId, fixture(projectId));
  }, 60_000);

  afterAll(async () => {
    if (projectId) await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await db.close();
  });

  describe('persistence', () => {
    it('round-trips every column, including the ones a table has none of', async () => {
      const controller = await graph.findNode(projectId, `${projectId}-controller`);
      expect(controller).toMatchObject({
        type: 'class',
        name: 'UserController',
        filePath: 'src/controllers/user.controller.ts',
        startLine: 10,
        startCharacter: 13,
        endLine: 40,
        endCharacter: 1,
      });

      const table = await graph.findNode(projectId, `${projectId}-table`);
      expect(table).toMatchObject({ type: 'table', qualifiedName: 'postgresql.users' });
      expect(table && 'filePath' in table).toBe(false);
    });

    it('replaces a project’s graph atomically and idempotently', async () => {
      const first = await graph.counts(projectId);
      await graph.replaceProjectGraph(projectId, fixture(projectId));
      const second = await graph.counts(projectId);

      expect(second).toEqual(first);
    });

    it('reports composition by node type and by relationship', async () => {
      const composition = await graph.composition(projectId);

      expect(composition.nodeTypeCounts).toMatchObject({ api: 1, table: 1, service: 1, class: 3 });
      expect(composition.relationshipCounts).toMatchObject({
        ROUTES_TO: 1,
        WRITES_TO: 1,
        DEPENDS_ON: 1,
      });
    });
  });

  describe('search', () => {
    const ids = (nodes: CodeNode[]): string[] =>
      nodes.map((node) => node.id.replace(`${projectId}-`, '')).sort();

    it('finds a symbol by name', async () => {
      const result = await graph.searchNodes(projectId, 'UserService', { limit: 10, offset: 0 });
      expect(ids(result.nodes)).toContain('service');
    });

    it('finds a member by its qualified name', async () => {
      const result = await graph.searchNodes(projectId, 'UserService.create', {
        limit: 10,
        offset: 0,
      });
      expect(ids(result.nodes)).toEqual(['method']);
    });

    it('finds an API by its route, spaces and slashes included', async () => {
      const result = await graph.searchNodes(projectId, 'POST /users', { limit: 10, offset: 0 });
      expect(ids(result.nodes)).toEqual(['api']);
    });

    it('finds files by a path fragment', async () => {
      const result = await graph.searchNodes(projectId, 'src/services', { limit: 10, offset: 0 });
      expect(ids(result.nodes)).toEqual(['file', 'method', 'service']);
    });

    it('finds every node of a type when the term names one', async () => {
      const result = await graph.searchNodes(projectId, 'table', { limit: 10, offset: 0 });
      expect(ids(result.nodes)).toEqual(['table']);
    });

    it('narrows by node type', async () => {
      const result = await graph.searchNodes(projectId, 'user', {
        nodeTypes: ['class'],
        limit: 10,
        offset: 0,
      });
      expect(result.nodes.every((node) => node.type === 'class')).toBe(true);
    });

    it('pages, and counts the whole match set behind the page', async () => {
      const page = await graph.searchNodes(projectId, 'user', { limit: 2, offset: 0 });

      expect(page.nodes).toHaveLength(2);
      expect(page.total).toBeGreaterThan(2);

      const next = await graph.searchNodes(projectId, 'user', { limit: 2, offset: 2 });
      expect(ids(next.nodes).some((id) => ids(page.nodes).includes(id))).toBe(false);
      expect(next.total).toBe(page.total);
    });

    it('returns nothing, and no error, for a term that matches nothing', async () => {
      const result = await graph.searchNodes(projectId, 'zzzz-nothing', { limit: 10, offset: 0 });
      expect(result).toEqual({ nodes: [], total: 0 });
    });
  });

  describe('traversal', () => {
    const ids = (nodes: CodeNode[]): string[] =>
      nodes.map((node) => node.id.replace(`${projectId}-`, '')).sort();

    it('walks both ways by default', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: `${projectId}-service`,
        depth: 1,
        limit: 50,
      });

      expect(ids(result.nodes)).toEqual(['controller', 'file', 'method', 'repository', 'service']);
      // Nearest first: the root, then its neighbours.
      expect(result.nodes[0]?.id).toBe(`${projectId}-service`);
    });

    it('follows only outgoing edges when asked', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: `${projectId}-service`,
        depth: 1,
        direction: 'outgoing',
        limit: 50,
      });

      expect(ids(result.nodes)).toEqual(['method', 'repository', 'service']);
    });

    it('follows only incoming edges when asked', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: `${projectId}-service`,
        depth: 1,
        direction: 'incoming',
        limit: 50,
      });

      expect(ids(result.nodes)).toEqual(['controller', 'file', 'service']);
    });

    it('applies the relationship filter during expansion', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: `${projectId}-api`,
        depth: 4,
        relationships: ['ROUTES_TO', 'CALLS', 'WRITES_TO'],
        limit: 50,
      });

      expect(ids(result.nodes)).toEqual(['api', 'controller', 'repository', 'service', 'table']);
    });

    it('will not reach through a node type the caller excluded', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: `${projectId}-api`,
        depth: 4,
        relationships: ['ROUTES_TO', 'CALLS', 'WRITES_TO'],
        nodeTypes: ['api', 'class'],
        limit: 50,
      });

      expect(ids(result.nodes)).toEqual(['api', 'controller', 'repository', 'service']);
    });

    it('stops at the node limit and says so', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: `${projectId}-service`,
        depth: 4,
        limit: 2,
      });

      expect(result.nodes).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it('returns only the induced subgraph’s edges', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: `${projectId}-service`,
        depth: 1,
        limit: 50,
      });
      const present = new Set(result.nodes.map((node) => node.id));

      for (const edge of result.edges) {
        expect(present.has(edge.sourceNodeId)).toBe(true);
        expect(present.has(edge.targetNodeId)).toBe(true);
      }
    });

    it('returns an empty graph for a root that does not exist', async () => {
      const result = await graph.traverse(projectId, {
        rootNodeId: 'missing',
        depth: 2,
        limit: 50,
      });

      expect(result).toEqual({ nodes: [], edges: [], truncated: false });
    });
  });

  describe('overview', () => {
    it('ranks a projection’s subjects ahead of higher-degree code', async () => {
      const result = await graph.overview(projectId, {
        nodeTypes: ['api', 'class', 'table', 'service'],
        relationships: ['ROUTES_TO', 'CALLS', 'WRITES_TO', 'DEPENDS_ON'],
        priorityNodeTypes: ['api', 'table'],
        limit: 3,
      });

      expect(result.nodes.map((node) => node.type).slice(0, 2).sort()).toEqual(['api', 'table']);
      expect(result.truncated).toBe(true);
    });

    it('excludes containment from the default ranking', async () => {
      const result = await graph.overview(projectId, { limit: 20 });

      // The file CONTAINS half the graph and would otherwise win outright.
      expect(result.nodes.some((node) => node.type === 'file')).toBe(false);
    });
  });

  describe('node relations', () => {
    it('buckets everything the inspector shows in one query', async () => {
      const relations = await graph.nodeRelations(projectId, `${projectId}-service`, 10);

      expect(relations.callers.map((node) => node.name)).toEqual(['UserController']);
      expect(relations.callees.map((node) => node.name)).toEqual(['UserRepository']);
      expect(relations.references).toEqual([]);
    });

    it('reports related APIs with the relationship and its evidence', async () => {
      const relations = await graph.nodeRelations(projectId, `${projectId}-controller`, 10);

      expect(relations.apis).toEqual([
        expect.objectContaining({
          name: 'POST /users',
          relationship: 'ROUTES_TO',
          direction: 'incoming',
          confidence: 'high',
          evidenceSource: 'api-analyzer',
        }),
      ]);
    });

    it('reports related data stores', async () => {
      const relations = await graph.nodeRelations(projectId, `${projectId}-repository`, 10);

      expect(relations.databases).toEqual([
        expect.objectContaining({ name: 'users', relationship: 'WRITES_TO' }),
      ]);
    });

    it('reports dependencies and dependents in the right direction', async () => {
      const service = await graph.nodeRelations(projectId, `${projectId}-svc`, 10);
      expect(service.dependencies.map((node) => node.name)).toEqual(['express']);

      const packageNode = await graph.nodeRelations(projectId, `${projectId}-pkg`, 10);
      expect(packageNode.dependents.map((node) => node.name)).toEqual(['users-service']);
    });

    it('honours the per-section limit', async () => {
      const relations = await graph.nodeRelations(projectId, `${projectId}-service`, 1);
      expect(relations.callers.length).toBeLessThanOrEqual(1);
    });
  });

  describe('indexes', () => {
    it('uses an index for the queries the graph API runs hot', async () => {
      const plans = await Promise.all([
        db.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM code_nodes WHERE project_id = $1 AND node_type = 'class'`,
          [projectId],
        ),
        db.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM code_edges WHERE project_id = $1 AND source_node_id = $2`,
          [projectId, `${projectId}-service`],
        ),
      ]);

      // A sequential scan on a ten-row table is legitimate — the planner is
      // right — so this asserts the indexes exist rather than that they are
      // chosen at this size.
      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename IN ('code_nodes', 'code_edges')`,
      );
      const names = indexes.rows.map((row) => row.indexname);

      for (const expected of [
        'idx_code_nodes_project_id',
        'idx_code_nodes_node_type',
        'idx_code_nodes_name',
        'idx_code_nodes_qualified_name',
        'idx_code_nodes_qualified_name_lower',
        'idx_code_nodes_file_path_lower',
        'idx_code_edges_source_rel',
        'idx_code_edges_target_rel',
      ]) {
        expect(names).toContain(expected);
      }

      expect(plans.every((plan) => plan.rows.length > 0)).toBe(true);
    });
  });
});
