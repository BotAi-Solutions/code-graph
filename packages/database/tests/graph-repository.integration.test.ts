import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeEdge, CodeGraph, CodeNode } from '@ckg/shared';
import { GraphRepository, ProjectRepository, migrate } from '@ckg/database';
import type { Database } from '@ckg/database';
import { connectTestDatabase } from './helpers/test-database.js';

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
 * It runs only against `TEST_DATABASE_URL` (see `helpers/test-database.ts`)
 * and skips when that is unset, so `pnpm test` needs no database. It never
 * falls back to a default connection or to `DATABASE_URL`.
 */

const database = await connectTestDatabase('graph repository integration');

const suite = database === null ? describe.skip : describe;

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

      // Nothing reached, and that count is exact rather than a lower bound.
      expect(result).toEqual({
        nodes: [],
        edges: [],
        truncated: false,
        reachableAtLeast: 0,
        reachableExact: true,
        cutDepth: null,
      });
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

  /**
   * Architectural edges, read from the architectural end.
   *
   * Its own project rather than extra nodes on the shared fixture: the cases
   * above assert exact traversal results and composition counts, and a fixture
   * that grows under them stops testing what it says it tests.
   *
   * The bug this pins dropped a row that the query had already read. Sectioning
   * tested the node type of the *other* endpoint, so an edge whose neighbour was
   * a class — which is every architectural edge, seen from the API, queue, event
   * or table — matched no section and was discarded.
   */
  describe('architectural relations from either end', () => {
    let architectural: string;

    function architecturalFixture(project: string): CodeGraph {
      const node = (id: string, type: CodeNode['type'], name: string): CodeNode => ({
        id: `${project}-${id}`,
        projectId: project,
        type,
        name,
        qualifiedName: name,
      });

      const edge = (
        source: string,
        relationship: CodeEdge['relationship'],
        target: string,
      ): CodeEdge => ({
        id: `${project}-${source}-${relationship}-${target}`,
        projectId: project,
        sourceNodeId: `${project}-${source}`,
        targetNodeId: `${project}-${target}`,
        relationship,
        metadata: { source: 'api-analyzer', confidence: 'high' },
      });

      return {
        nodes: [
          node('route', 'api', 'POST /users'),
          node('controller', 'class', 'UserController'),
          node('service', 'class', 'UserService'),
          node('repository', 'class', 'UserRepository'),
          node('other-repository', 'class', 'OrderRepository'),
          node('worker', 'function', 'startWelcomeEmailWorker'),
          node('queue', 'queue', 'welcome-emails'),
          node('event', 'event', 'user.created'),
          node('table', 'table', 'postgresql.users'),
          node('other-table', 'table', 'postgresql.orders'),
        ],
        edges: [
          edge('route', 'ROUTES_TO', 'controller'),
          edge('service', 'PUBLISHES', 'queue'),
          edge('worker', 'SUBSCRIBES', 'queue'),
          edge('service', 'PUBLISHES', 'event'),
          edge('repository', 'READS_FROM', 'table'),
          edge('other-repository', 'READS_FROM', 'other-table'),
        ],
      };
    }

    beforeAll(async () => {
      const project = await projects.create({
        name: `architectural-${randomUUID().slice(0, 8)}`,
        description: 'created by the architectural relations suite',
      });
      architectural = project.id;
      await graph.replaceProjectGraph(architectural, architecturalFixture(architectural));
    }, 60_000);

    afterAll(async () => {
      if (architectural) {
        await db.query('DELETE FROM projects WHERE id = $1', [architectural]);
      }
    });

    /** `NAME RELATIONSHIP` oriented the way the edge actually runs. */
    const edgesOf = (
      entries: readonly { name: string; relationship: string; direction: string }[],
      subject: string,
    ): string[] =>
      entries
        .map((entry) =>
          entry.direction === 'outgoing'
            ? `${subject} ${entry.relationship} ${entry.name}`
            : `${entry.name} ${entry.relationship} ${subject}`,
        )
        .sort();

    it('reports the controller an API routes to, from the API', async () => {
      const relations = await graph.nodeRelations(architectural, `${architectural}-route`, 10);

      expect(edgesOf(relations.apis, 'POST /users')).toEqual([
        'POST /users ROUTES_TO UserController',
      ]);
    });

    it('reports what feeds a queue, from the queue', async () => {
      const relations = await graph.nodeRelations(architectural, `${architectural}-queue`, 10);

      expect(edgesOf(relations.databases, 'welcome-emails')).toEqual([
        'UserService PUBLISHES welcome-emails',
        'startWelcomeEmailWorker SUBSCRIBES welcome-emails',
      ]);
    });

    it('reports what publishes an event, from the event', async () => {
      const relations = await graph.nodeRelations(architectural, `${architectural}-event`, 10);

      expect(edgesOf(relations.databases, 'user.created')).toEqual([
        'UserService PUBLISHES user.created',
      ]);
    });

    it('reports what reads a table, from the table', async () => {
      const relations = await graph.nodeRelations(architectural, `${architectural}-table`, 10);

      expect(edgesOf(relations.databases, 'postgresql.users')).toEqual([
        'UserRepository READS_FROM postgresql.users',
      ]);
    });

    it('keeps the code-side direction working', async () => {
      const [controller, service, repository] = await Promise.all([
        graph.nodeRelations(architectural, `${architectural}-controller`, 10),
        graph.nodeRelations(architectural, `${architectural}-service`, 10),
        graph.nodeRelations(architectural, `${architectural}-repository`, 10),
      ]);

      expect(edgesOf(controller.apis, 'UserController')).toEqual([
        'POST /users ROUTES_TO UserController',
      ]);
      expect(edgesOf(service.databases, 'UserService')).toEqual([
        'UserService PUBLISHES user.created',
        'UserService PUBLISHES welcome-emails',
      ]);
      expect(edgesOf(repository.databases, 'UserRepository')).toEqual([
        'UserRepository READS_FROM postgresql.users',
      ]);
    });

    it('does not surface a relationship between another pair of endpoints', async () => {
      const relations = await graph.nodeRelations(architectural, `${architectural}-table`, 10);

      expect(relations.databases.every((entry) => entry.name !== 'OrderRepository')).toBe(true);
    });

    it('carries the evidence when read from the architectural end', async () => {
      const relations = await graph.nodeRelations(architectural, `${architectural}-table`, 10);

      expect(relations.databases).toEqual([
        expect.objectContaining({
          name: 'UserRepository',
          relationship: 'READS_FROM',
          direction: 'incoming',
          confidence: 'high',
          evidenceSource: 'api-analyzer',
        }),
      ]);
    });

    it('never reaches into another project for a relationship', async () => {
      // The other fixture holds its own `api ROUTES_TO controller` and
      // `repository WRITES_TO table`, so a query that leaked across projects
      // would find something plausible rather than nothing.
      const relations = await graph.nodeRelations(projectId, `${projectId}-table`, 10);

      expect(relations.databases.map((entry) => entry.projectId)).toEqual([projectId]);
      expect(edgesOf(relations.databases, 'users')).toEqual([
        'UserRepository WRITES_TO users',
      ]);
    });

    it('leaves graph traversal from an architectural node unchanged', async () => {
      const result = await graph.traverse(architectural, {
        rootNodeId: `${architectural}-table`,
        depth: 1,
        limit: 50,
      });

      expect(result.edges.map((item) => item.relationship)).toEqual(['READS_FROM']);
      expect(result.nodes.map((item) => item.name).sort()).toEqual([
        'UserRepository',
        'postgresql.users',
      ]);
    });
  });

  describe('relations', () => {
    it('reports dependencies and dependents with their evidence', async () => {
      const dependencies = await graph.dependencies(projectId, `${projectId}-svc`, 10);
      const dependents = await graph.dependents(projectId, `${projectId}-pkg`, 10);

      expect(dependencies.map((node) => node.name)).toEqual(['express']);
      expect(dependencies[0]).toMatchObject({
        relationship: 'DEPENDS_ON',
        direction: 'outgoing',
        confidence: 'high',
        evidenceSource: 'import-analyzer',
      });
      expect(dependents.map((node) => node.name)).toEqual(['users-service']);
      expect(dependents[0]?.direction).toBe('incoming');
    });

    it('reads both directions of the inheritance relation in one query', async () => {
      const result = await graph.implementations(projectId, `${projectId}-service`, 10);
      // The fixture has no IMPLEMENTS or EXTENDS edge, so the honest answer is
      // an empty list rather than the containment edges that do exist.
      expect(result).toEqual([]);
    });

    it('reports the node that contains one, and the nodes it contains', async () => {
      const parent = await graph.parent(projectId, `${projectId}-method`);
      const children = await graph.children(projectId, `${projectId}-file`, 10);

      expect(parent?.id).toBe(`${projectId}-service`);
      expect(children.map((node) => node.name)).toEqual(['UserService']);
    });

    it('has no parent for the repository root', async () => {
      expect(await graph.parent(projectId, `${projectId}-repo`)).toBeNull();
    });

    it('finds the file node behind a path', async () => {
      const file = await graph.findFileNode(projectId, 'src/services/user.service.ts');
      expect(file?.id).toBe(`${projectId}-file`);
      expect(await graph.findFileNode(projectId, 'src/nope.ts')).toBeNull();
    });
  });

  describe('tree', () => {
    it('lists one level, directories before files', async () => {
      const root = await graph.treeLevel(projectId, '', 100);

      expect(root.path).toBe('');
      expect(root.parentPath).toBeNull();
      // The fixture has no `directory` nodes, so the root level is whatever
      // path node sits at depth one — here, nothing, since every file is nested.
      expect(root.entries.every((entry) => !entry.path.includes('/'))).toBe(true);
    });

    it('does not reach past the level it was asked for', async () => {
      const level = await graph.treeLevel(projectId, 'src/services', 100);

      expect(level.parentPath).toBe('src');
      expect(level.entries.map((entry) => entry.path)).toEqual([
        'src/services/user.service.ts',
      ]);
    });

    it('is empty for a directory with nothing under it', async () => {
      const level = await graph.treeLevel(projectId, 'does/not/exist', 100);
      expect(level.entries).toEqual([]);
    });

    it('treats a path containing a LIKE wildcard as a literal', async () => {
      const level = await graph.treeLevel(projectId, 'src/%', 100);
      expect(level.entries).toEqual([]);
    });
  });

  describe('level-by-level traversal', () => {
    /**
     * Each case gets a small graph of its own. Ids are `<project>-<name>`, so
     * names sort the way the ids do and the expected (depth, id) order can be
     * written by hand.
     */
    async function withGraph(
      nodeNames: string[],
      edgeList: Array<[string, string, CodeEdge['relationship']?]>,
      body: (scope: { id: (name: string) => string; projectId: string }) => Promise<void>,
      types: Record<string, CodeNode['type']> = {},
    ): Promise<void> {
      const scratch = await projects.create({
        name: `integration-traverse-${randomUUID().slice(0, 8)}`,
        description: 'created by the graph repository integration suite',
      });
      const id = (name: string): string => `${scratch.id}-${name}`;
      try {
        await graph.replaceProjectGraph(scratch.id, {
          nodes: nodeNames.map((name) => ({
            id: id(name),
            projectId: scratch.id,
            type: types[name] ?? ('function' as const),
            name,
          })),
          edges: edgeList.map(([from, to, relationship]) => ({
            id: id(`${from}>${to}`),
            projectId: scratch.id,
            sourceNodeId: id(from),
            targetNodeId: id(to),
            relationship: relationship ?? ('CALLS' as const),
            metadata: { source: 'scip', confidence: 'high' },
          })),
        });
        await body({ id, projectId: scratch.id });
      } finally {
        await db.query('DELETE FROM projects WHERE id = $1', [scratch.id]);
      }
    }

    const names = (nodes: CodeNode[], projectIdOf: string): string[] =>
      nodes.map((node) => node.id.replace(`${projectIdOf}-`, ''));
    const edgeNames = (edges: CodeEdge[], projectIdOf: string): string[] =>
      edges.map((edge) => edge.id.replace(`${projectIdOf}-`, '')).sort();

    it('returns nothing for a root that does not exist, and says so exactly', async () => {
      await withGraph(['a'], [], async ({ id, projectId: scope }) => {
        const result = await graph.traverse(scope, { rootNodeId: id('missing'), depth: 3, limit: 10 });
        expect(result).toEqual({ nodes: [], edges: [], truncated: false, reachableAtLeast: 0, reachableExact: true, cutDepth: null });
      });
    });

    it('returns only the root of a disconnected node', async () => {
      await withGraph(['a', 'b', 'c'], [['b', 'c']], async ({ id, projectId: scope }) => {
        const result = await graph.traverse(scope, { rootNodeId: id('a'), depth: 5, limit: 10 });
        expect(names(result.nodes, scope)).toEqual(['a']);
        expect(result).toMatchObject({ edges: [], truncated: false, reachableAtLeast: 1, reachableExact: true, cutDepth: null });
      });
    });

    it('visits each node of a cycle once and returns every edge of it', async () => {
      await withGraph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']], async ({ id, projectId: scope }) => {
        for (const direction of ['outgoing', 'incoming', 'both'] as const) {
          const result = await graph.traverse(scope, { rootNodeId: id('a'), depth: 5, direction, limit: 10 });
          expect(new Set(names(result.nodes, scope))).toEqual(new Set(['a', 'b', 'c']));
          expect(result.nodes).toHaveLength(3);
          expect(edgeNames(result.edges, scope)).toEqual(['a>b', 'b>c', 'c>a']);
          expect(result.reachableAtLeast).toBe(3);
        }
      });
    });

    it('reaches a node by two paths once, at its shortest depth', async () => {
      // a → b → d and a → c → d; e is reachable only through d.
      await withGraph(['a', 'b', 'c', 'd', 'e'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'e']], async ({ id, projectId: scope }) => {
        const result = await graph.traverse(scope, { rootNodeId: id('a'), depth: 2, direction: 'outgoing', limit: 10 });
        expect(names(result.nodes, scope)).toEqual(['a', 'b', 'c', 'd']);
        expect(edgeNames(result.edges, scope)).toEqual(['a>b', 'a>c', 'b>d', 'c>d']);
      });
    });

    it('stops at the depth boundary, and keeps an edge whose two ends were both selected', async () => {
      // a → b → c → d, plus c → a, which points back at the root.
      await withGraph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['c', 'a']], async ({ id, projectId: scope }) => {
        const twoHops = await graph.traverse(scope, { rootNodeId: id('a'), depth: 2, direction: 'outgoing', limit: 10 });
        expect(names(twoHops.nodes, scope)).toEqual(['a', 'b', 'c']);
        // c → a is not followed outgoing from a, but both of its ends are in
        // the result, so it is part of the subgraph; c → d is not.
        expect(edgeNames(twoHops.edges, scope)).toEqual(['a>b', 'b>c', 'c>a']);

        const zero = await graph.traverse(scope, { rootNodeId: id('a'), depth: 0, limit: 10 });
        expect(names(zero.nodes, scope)).toEqual(['a']);
        expect(zero).toMatchObject({ truncated: false, reachableExact: true, cutDepth: null });
      });
    });

    it('cuts a high-degree node at the limit, keeps the lowest ids, and reports a lower bound', async () => {
      const spokes = Array.from({ length: 30 }, (_, index) => `s${String(index).padStart(2, '0')}`);
      await withGraph(['hub', ...spokes, 'far'], [...spokes.map((spoke): [string, string] => ['hub', spoke]), ['s29', 'far']], async ({ id, projectId: scope }) => {
        const result = await graph.traverse(scope, { rootNodeId: id('hub'), depth: 3, limit: 10 });

        expect(names(result.nodes, scope)).toEqual(['hub', ...spokes.slice(0, 9)]);
        expect(result).toMatchObject({ truncated: true, reachableExact: false, cutDepth: 1 });
        // Exactly the 31 nodes up to depth 1; `far`, at depth 2, was never explored.
        expect(result.reachableAtLeast).toBe(31);
      });
    });

    it('tells an exact fit from a cut', async () => {
      await withGraph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']], async ({ id, projectId: scope }) => {
        const fits = await graph.traverse(scope, { rootNodeId: id('a'), depth: 3, limit: 4 });
        expect(fits).toMatchObject({ truncated: false, reachableAtLeast: 4, reachableExact: true, cutDepth: null });

        const cut = await graph.traverse(scope, { rootNodeId: id('a'), depth: 3, limit: 3 });
        expect(names(cut.nodes, scope)).toEqual(['a', 'b', 'c']);
        expect(cut).toMatchObject({ truncated: true, reachableAtLeast: 4, reachableExact: false, cutDepth: 3 });
      });
    });

    it('does not walk through a node the type filter excludes', async () => {
      await withGraph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']], async ({ id, projectId: scope }) => {
        const result = await graph.traverse(scope, { rootNodeId: id('a'), depth: 5, nodeTypes: ['function'], limit: 10 });
        expect(names(result.nodes, scope)).toEqual(['a']);
      }, { b: 'class' });
    });

    /**
     * The recursive query the level-by-level walk replaced, kept here as the
     * reference: on any graph, for any root, depth, direction, filter and
     * limit, the two must select the same nodes in the same order.
     */
    async function recursiveReference(scope: string, options: {
      rootNodeId: string; depth: number; limit: number;
      direction?: 'both' | 'outgoing' | 'incoming'; relationships?: string[]; nodeTypes?: string[];
    }): Promise<{ ids: string[]; truncated: boolean }> {
      const rows = await db.query<{ id: string }>(
        `WITH RECURSIVE walk(id, depth) AS (
           SELECT n.id, 0 FROM code_nodes n WHERE n.project_id = $1 AND n.id = $2
           UNION
           SELECT nxt.id, w.depth + 1
             FROM walk w
             JOIN code_edges e
               ON e.project_id = $1
              AND (($7 <> 'incoming' AND e.source_node_id = w.id) OR ($7 <> 'outgoing' AND e.target_node_id = w.id))
              AND ($4::text[] IS NULL OR e.relationship = ANY($4::text[]))
             JOIN code_nodes nxt
               ON nxt.project_id = $1
              AND nxt.id = CASE WHEN e.source_node_id = w.id THEN e.target_node_id ELSE e.source_node_id END
              AND ($5::text[] IS NULL OR nxt.node_type = ANY($5::text[]))
            WHERE w.depth < $3
         )
         SELECT id FROM walk GROUP BY id ORDER BY min(depth), id LIMIT $6`,
        [scope, options.rootNodeId, options.depth, options.relationships ?? null, options.nodeTypes ?? null, options.limit + 1, options.direction ?? 'both'],
      );
      return { ids: rows.rows.slice(0, options.limit).map((row) => row.id), truncated: rows.rows.length > options.limit };
    }

    it('selects exactly what the recursive query selected, on a seeded random graph', async () => {
      // A deterministic pseudo-random graph: 120 nodes of two types, 360 edges
      // of two relationships, with hubs, cycles, self-loops and duplicate paths.
      let seed = 20261012;
      const next = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const nodeNames = Array.from({ length: 120 }, (_, index) => `n${String(index).padStart(3, '0')}`);
      const edgeSet = new Map<string, [string, string, CodeEdge['relationship']]>();
      while (edgeSet.size < 360) {
        const from = nodeNames[Math.floor(next() ** 2 * 120)] as string; // skewed: hubs
        const to = nodeNames[Math.floor(next() * 120)] as string;
        if (from === to && next() > 0.05) continue; // a few self-loops
        edgeSet.set(`${from}>${to}`, [from, to, next() < 0.6 ? 'CALLS' : 'REFERENCES']);
      }
      const types = Object.fromEntries(nodeNames.map((name, index) => [name, index % 4 === 0 ? 'class' : 'function'])) as Record<string, CodeNode['type']>;

      await withGraph(nodeNames, [...edgeSet.values()], async ({ id, projectId: scope }) => {
        let compared = 0;
        for (const root of ['n000', 'n001', 'n007', 'n050', 'n119']) {
          for (const depth of [0, 1, 2, 3, 5]) {
            for (const direction of ['both', 'outgoing', 'incoming'] as const) {
              for (const variant of [
                { limit: 500 },
                { limit: 7 },
                { limit: 40, relationships: ['CALLS'] as CodeEdge['relationship'][] },
                { limit: 40, nodeTypes: ['function'] as CodeNode['type'][] },
              ]) {
                const options = { rootNodeId: id(root), depth, direction, ...variant };
                const expected = await recursiveReference(scope, options);
                const actual = await graph.traverse(scope, options);
                expect({ ids: actual.nodes.map((node) => node.id), truncated: actual.truncated }, JSON.stringify({ root, depth, direction, ...variant })).toEqual(expected);
                compared += 1;
              }
            }
          }
        }
        expect(compared).toBe(300);
      }, types);
    }, 60_000);
  });

  describe('path', () => {
    const strip = (ids: readonly string[]): string[] =>
      ids.map((id) => id.replace(`${projectId}-`, ''));

    it('traces a route from the API to the table, following the arrows', async () => {
      const result = await graph.findPath(
        projectId,
        `${projectId}-api`,
        `${projectId}-table`,
        { maxDepth: 6, directed: true },
      );

      expect(result.found).toBe(true);
      expect(strip(result.nodeIds)).toEqual(['api', 'controller', 'service', 'repository', 'table']);
      expect(result.hops.map((hop) => hop.relationship)).toEqual([
        'ROUTES_TO',
        'CALLS',
        'CALLS',
        'WRITES_TO',
      ]);
      expect(result.hops.every((hop) => !hop.reversed)).toBe(true);
    });

    it('carries the edge metadata each hop was recorded with', async () => {
      const result = await graph.findPath(
        projectId,
        `${projectId}-api`,
        `${projectId}-table`,
        { maxDepth: 6, directed: true },
      );

      expect(result.hops.at(-1)?.metadata).toMatchObject({
        source: 'database-analyzer',
        confidence: 'high',
        statement: 'INSERT',
      });
    });

    it('finds nothing against the arrows, and everything with them ignored', async () => {
      const directed = await graph.findPath(
        projectId,
        `${projectId}-table`,
        `${projectId}-api`,
        { maxDepth: 6, directed: true },
      );
      expect(directed.found).toBe(false);

      const undirected = await graph.findPath(
        projectId,
        `${projectId}-table`,
        `${projectId}-api`,
        { maxDepth: 6, directed: false },
      );
      expect(undirected.found).toBe(true);
      expect(undirected.hops.every((hop) => hop.reversed)).toBe(true);
    });

    it('reports a node reaching itself as a route of no hops', async () => {
      const result = await graph.findPath(
        projectId,
        `${projectId}-service`,
        `${projectId}-service`,
        { maxDepth: 6, directed: true },
      );

      expect(result).toEqual({
        found: true,
        nodeIds: [`${projectId}-service`],
        hops: [],
        truncated: false,
      });
    });

    it('will not walk further than maxDepth', async () => {
      const result = await graph.findPath(
        projectId,
        `${projectId}-api`,
        `${projectId}-table`,
        { maxDepth: 2, directed: true },
      );
      expect(result.found).toBe(false);
    });

    it('honours the relationship filter', async () => {
      const result = await graph.findPath(
        projectId,
        `${projectId}-api`,
        `${projectId}-table`,
        { maxDepth: 6, directed: true, relationships: ['CALLS'] },
      );
      expect(result.found).toBe(false);
    });

    it('will not route through an excluded node type', async () => {
      const result = await graph.findPath(
        projectId,
        `${projectId}-api`,
        `${projectId}-table`,
        { maxDepth: 6, directed: true, nodeTypes: ['api', 'table'] },
      );
      expect(result.found).toBe(false);
    });

    it('gives up, and says so, once the node budget is spent', async () => {
      const result = await graph.findPath(
        projectId,
        `${projectId}-api`,
        `${projectId}-table`,
        { maxDepth: 6, directed: true, nodeBudget: 1 },
      );

      expect(result.found).toBe(false);
      expect(result.truncated).toBe(true);
    });

    it('returns the same route every time', async () => {
      const once = await graph.findPath(projectId, `${projectId}-api`, `${projectId}-table`, {
        maxDepth: 6,
        directed: true,
      });
      const twice = await graph.findPath(projectId, `${projectId}-api`, `${projectId}-table`, {
        maxDepth: 6,
        directed: true,
      });
      expect(once).toEqual(twice);
    });

    it('loads the route\u2019s nodes and edges in the order it walked them', async () => {
      const result = await graph.findPath(projectId, `${projectId}-api`, `${projectId}-table`, {
        maxDepth: 6,
        directed: true,
      });
      const loaded = await graph.loadPathGraph(
        projectId,
        result.nodeIds,
        result.hops.map((hop) => hop.edgeId),
      );

      expect(loaded.nodes.map((node) => node.id)).toEqual(result.nodeIds);
      expect(loaded.edges.map((edge) => edge.id)).toEqual(result.hops.map((hop) => hop.edgeId));
    });
  });

  describe('search ranking', () => {
    const ids = (nodes: CodeNode[]): string[] =>
      nodes.map((node) => node.id.replace(`${projectId}-`, ''));

    it('puts an exact name first', async () => {
      const result = await graph.searchNodes(projectId, 'UserService', { limit: 10, offset: 0 });
      expect(ids(result.nodes)[0]).toBe('service');
    });

    it('puts an exact qualified name first', async () => {
      const result = await graph.searchNodes(projectId, 'postgresql.users', {
        limit: 10,
        offset: 0,
      });
      expect(ids(result.nodes)[0]).toBe('table');
    });

    it('finds a file by its name alone', async () => {
      const result = await graph.searchNodes(projectId, 'user.service.ts', {
        limit: 10,
        offset: 0,
      });
      expect(ids(result.nodes)[0]).toBe('file');
    });

    it('finds a member by its last dotted segment', async () => {
      const result = await graph.searchNodes(projectId, 'create', { limit: 10, offset: 0 });
      expect(ids(result.nodes)).toContain('method');
    });

    it('returns the same page for the same term', async () => {
      const once = await graph.searchNodes(projectId, 'user', { limit: 10, offset: 0 });
      const twice = await graph.searchNodes(projectId, 'user', { limit: 10, offset: 0 });
      expect(ids(once.nodes)).toEqual(ids(twice.nodes));
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

    // The lookups the two ON DELETE CASCADE foreign keys run for every deleted
    // node, with no project in them. Before 0006 every code_edges index led
    // with project_id, so each one walked a whole index; re-analysing a
    // 9,395-node project spent 5.7 s in them. Sequential scans are switched off
    // so the test asks which index *can* serve the lookup, which a ten-row
    // table would otherwise not reveal.
    it('lets the cascade lookups seek by endpoint instead of walking a whole index', async () => {
      const plans = await db.transaction(async (tx) => {
        await tx.query('SET LOCAL enable_seqscan = off');
        const plan = async (column: string): Promise<string> =>
          (
            await tx.query<{ 'QUERY PLAN': string }>(
              `EXPLAIN DELETE FROM ONLY code_edges WHERE ${column} = $1`,
              [`${projectId}-service`],
            )
          ).rows
            .map((row) => row['QUERY PLAN'])
            .join('\n');
        return { source: await plan('source_node_id'), target: await plan('target_node_id') };
      });

      expect(plans.source).toContain('idx_code_edges_source_node_id');
      expect(plans.target).toContain('idx_code_edges_target_node_id');
    });

    it('still cascades: deleting a node deletes the edges at either end of it', async () => {
      const scratch = await projects.create({
        name: `integration-cascade-${randomUUID().slice(0, 8)}`,
        description: 'created by the graph repository integration suite',
      });
      try {
        const id = (name: string): string => `${scratch.id}-${name}`;
        await graph.replaceProjectGraph(scratch.id, {
          nodes: ['a', 'b', 'c'].map((name) => ({
            id: id(name),
            projectId: scratch.id,
            type: 'function' as const,
            name,
          })),
          edges: [
            { id: id('ab'), projectId: scratch.id, sourceNodeId: id('a'), targetNodeId: id('b'), relationship: 'CALLS' as const, metadata: { source: 'scip', confidence: 'high' } },
            { id: id('cb'), projectId: scratch.id, sourceNodeId: id('c'), targetNodeId: id('b'), relationship: 'CALLS' as const, metadata: { source: 'scip', confidence: 'high' } },
            { id: id('ac'), projectId: scratch.id, sourceNodeId: id('a'), targetNodeId: id('c'), relationship: 'CALLS' as const, metadata: { source: 'scip', confidence: 'high' } },
          ],
        });

        await db.query('DELETE FROM code_nodes WHERE id = $1', [id('b')]);

        const left = await db.query<{ id: string }>(
          'SELECT id FROM code_edges WHERE project_id = $1 ORDER BY id',
          [scratch.id],
        );
        expect(left.rows.map((row) => row.id)).toEqual([id('ac')]);
      } finally {
        await db.query('DELETE FROM projects WHERE id = $1', [scratch.id]);
      }
    });
  });

  describe('complete relationship sections', () => {
    let hubProject: string;
    const id = (name: string): string => `${hubProject}-${name}`;

    /**
     * A hub with 40 callers and 3 references. Under the old single cap across
     * all sections (limit × relationship types), a page of 2 filled with
     * CALLS rows before REFERENCES was reached and returned no references at
     * all. Each section must now keep its own page.
     */
    beforeAll(async () => {
      const project = await projects.create({ name: `paging-${randomUUID().slice(0, 8)}`, description: null });
      hubProject = project.id;
      const node = (name: string, type: CodeNode['type'], filePath: string): CodeNode => ({
        id: id(name),
        projectId: hubProject,
        type,
        name,
        filePath,
        startLine: 1,
      });
      const edge = (source: string, relationship: CodeEdge['relationship'], target: string): CodeEdge => ({
        id: `${hubProject}-${source}-${relationship}-${target}`,
        projectId: hubProject,
        sourceNodeId: id(source),
        targetNodeId: id(target),
        relationship,
      });
      const callers = Array.from({ length: 40 }, (_, index) => `caller${String(index).padStart(2, '0')}`);
      const refs = ['ref0', 'ref1', 'ref2'];
      const subs = ['sub0', 'sub1', 'sub2'];

      await graph.replaceProjectGraph(hubProject, {
        nodes: [
          node('hub', 'class', 'src/hub.ts'),
          node('contract', 'interface', 'src/contract.ts'),
          ...callers.map((name) => node(name, 'method', `src/callers/${name}.ts`)),
          ...refs.map((name) => node(name, 'function', 'src/refs.ts')),
          ...subs.map((name) => node(name, 'class', 'src/subs.ts')),
        ],
        edges: [
          ...callers.map((name) => edge(name, 'CALLS', 'hub')),
          ...refs.map((name) => edge(name, 'REFERENCES', 'hub')),
          ...subs.map((name) => edge(name, 'EXTENDS', 'hub')),
          edge('hub', 'IMPLEMENTS', 'contract'),
          edge('hub', 'REFERENCES', 'ref0'),
        ],
      });
    }, 60_000);

    afterAll(async () => {
      if (hubProject) await db.query('DELETE FROM projects WHERE id = $1', [hubProject]);
    });

    it('caps each section on its own, so a crowded one cannot starve the rest', async () => {
      const relations = await graph.nodeRelations(hubProject, id('hub'), 2);
      expect(relations.callers).toHaveLength(2);
      expect(relations.references.map((node) => node.name)).toEqual(['ref0', 'ref1']);
    });

    it('returns the same first page as before when nothing is starved', async () => {
      const relations = await graph.nodeRelations(hubProject, id('hub'), 100);
      expect(relations.callers).toHaveLength(40);
      expect(relations.callers.map((node) => node.name)).toEqual(
        [...relations.callers.map((node) => node.name)].sort(),
      );
    });

    it('reports exact totals per section, ignoring edges no section shows', async () => {
      expect(await graph.relationshipTotals(hubProject, id('hub'))).toMatchObject({
        callers: 40,
        callees: 0,
        references: 3,
        implementations: 4,
        children: 0,
      });
    });

    it('pages callers with an offset, and the pages rebuild the section exactly', async () => {
      const pages: string[] = [];
      for (let offset = 0; offset < 40; offset += 15) {
        pages.push(...(await graph.callers(hubProject, id('hub'), 15, offset)).map((node) => node.name));
      }
      const whole = (await graph.callers(hubProject, id('hub'), 100)).map((node) => node.name);
      expect(pages).toEqual(whole);
      expect(new Set(pages).size).toBe(40);
      expect(await graph.countSection(hubProject, id('hub'), 'callers')).toBe(40);
    });

    it('counts and pages implementations by direction', async () => {
      expect(await graph.countSection(hubProject, id('hub'), 'implementations', 'incoming')).toBe(3);
      expect(await graph.countSection(hubProject, id('hub'), 'implementations', 'outgoing')).toBe(1);
      const second = await graph.implementations(hubProject, id('hub'), 2, 2, 'incoming');
      expect(second.map((node) => node.name)).toEqual(['sub2']);
    });

    it('applies a search path prefix before paging, and counts only what it keeps', async () => {
      const result = await graph.searchNodes(hubProject, 'caller', {
        filePrefix: 'src/callers/caller39',
        limit: 5,
        offset: 0,
      });
      expect(result.nodes.map((node) => node.name)).toEqual(['caller39']);
      expect(result.total).toBe(1);

      const wildcard = await graph.searchNodes(hubProject, 'caller', { filePrefix: 'src/%', limit: 5, offset: 0 });
      expect(wildcard.total).toBe(0);
    });
  });
});
