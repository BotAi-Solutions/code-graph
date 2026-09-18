import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  CodeGraph,
  CodeNode,
  NodeDetail,
  Project,
  SourceTree,
  SourceWindow,
} from '@ckg/shared';
import { body, createHarness, type Harness } from './helpers/harness.js';

/**
 * The API over a repository graph that is more than code.
 *
 * The fixture is `test-repositories/repository-knowledge-sample` — its real
 * paths, so the source routes read files that exist — with the graph written by
 * hand, because what is under test here is the read model rather than the
 * analyzers. The analyzers are tested against the same repository in
 * `@ckg/analysis`, and the benchmark scores the two together.
 */

const SAMPLE_REPOSITORY = 'test-repositories/repository-knowledge-sample';

function knowledgeGraph(projectId: string): CodeGraph {
  const node = (
    id: string,
    type: CodeNode['type'],
    name: string,
    extra: Partial<CodeNode> = {},
  ): CodeNode => ({ id, projectId, type, name, ...extra });

  const edge = (
    source: string,
    relationship: CodeGraph['edges'][number]['relationship'],
    target: string,
    metadata: Record<string, unknown> = { source: 'scip', confidence: 'high', method: 'scip' },
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
      node('repo', 'repository', 'repository-knowledge-sample'),

      node('dir-src', 'directory', 'src', { qualifiedName: 'src', filePath: 'src' }),
      node('dir-docs', 'directory', 'docs', { qualifiedName: 'docs', filePath: 'docs' }),
      node('dir-database', 'directory', 'database', {
        qualifiedName: 'database',
        filePath: 'database',
      }),
      node('dir-migrations', 'directory', 'migrations', {
        qualifiedName: 'database/migrations',
        filePath: 'database/migrations',
      }),

      node('doc-readme', 'document', 'README.md', {
        filePath: 'README.md',
        metadata: { category: 'document', role: 'readme', title: 'Knowledge Sample' },
      }),
      node('doc-architecture', 'document', 'architecture.md', {
        qualifiedName: 'docs/architecture.md',
        filePath: 'docs/architecture.md',
        metadata: { category: 'document', role: 'documentation' },
      }),
      node('section-auth', 'document_section', 'Authentication', {
        qualifiedName: 'README.md#authentication',
        filePath: 'README.md',
        startLine: 12,
        endLine: 17,
        metadata: { level: 2, slug: 'authentication' },
      }),

      node('spec', 'api_spec', 'openapi.yaml', {
        filePath: 'openapi.yaml',
        metadata: { category: 'schema', role: 'api-spec', flavour: 'openapi-3' },
      }),
      node('endpoint-create', 'api_endpoint', 'POST /users', {
        filePath: 'openapi.yaml',
        startLine: 15,
        metadata: { httpMethod: 'POST', path: '/users', operationId: 'createUser' },
      }),

      node('config-compose', 'config', 'docker-compose.yml', {
        filePath: 'docker-compose.yml',
        metadata: { category: 'configuration', role: 'compose', configKind: 'container' },
      }),
      node('property-script', 'config_property', 'scripts.build', {
        qualifiedName: 'package.json#scripts.build',
        filePath: 'package.json',
        startLine: 9,
        metadata: { key: 'scripts.build', value: 'tsc -b' },
      }),
      node('container-postgres', 'container', 'postgres', {
        metadata: { service: 'postgres', image: 'postgres:16-alpine' },
      }),

      node('migration', 'file', '0001_create_users.sql', {
        qualifiedName: 'database/migrations/0001_create_users.sql',
        filePath: 'database/migrations/0001_create_users.sql',
        metadata: { category: 'database', role: 'migration' },
      }),
      node('table-users', 'table', 'users', { qualifiedName: 'postgresql.users' }),
      node('column-email', 'column', 'email', {
        qualifiedName: 'postgresql.users.email',
        metadata: { table: 'users', column: 'email', dataType: 'TEXT' },
      }),

      node('class-controller', 'class', 'UserController', {
        filePath: 'src/controllers/user.controller.ts',
        startLine: 5,
        endLine: 25,
      }),
      node('class-auth', 'class', 'AuthService', {
        filePath: 'src/services/auth.service.ts',
        startLine: 8,
        endLine: 24,
      }),
    ],

    edges: [
      edge('repo', 'CONTAINS', 'dir-src'),
      edge('repo', 'CONTAINS', 'dir-docs'),
      edge('repo', 'CONTAINS', 'doc-readme'),
      edge('repo', 'CONTAINS', 'spec'),
      edge('repo', 'CONTAINS', 'config-compose'),
      edge('dir-docs', 'CONTAINS', 'doc-architecture'),
      edge('dir-database', 'CONTAINS', 'dir-migrations'),
      edge('dir-migrations', 'CONTAINS', 'migration'),
      edge('doc-readme', 'CONTAINS', 'section-auth'),
      edge('table-users', 'CONTAINS', 'column-email'),

      edge('section-auth', 'DOCUMENTS', 'class-auth', {
        source: 'document-analyzer',
        confidence: 'medium',
        method: 'markdown',
        file: 'README.md',
        line: 14,
        matched: 'AuthService',
      }),
      edge('doc-readme', 'LINKS_TO', 'doc-architecture', {
        source: 'document-analyzer',
        confidence: 'high',
        method: 'markdown',
        file: 'README.md',
        line: 8,
      }),
      edge('spec', 'DEFINES', 'endpoint-create', {
        source: 'openapi-analyzer',
        confidence: 'high',
        method: 'openapi',
        file: 'openapi.yaml',
        line: 15,
      }),
      edge('endpoint-create', 'IMPLEMENTED_BY', 'class-controller', {
        source: 'openapi-analyzer',
        confidence: 'medium',
        method: 'openapi',
        file: 'openapi.yaml',
        line: 15,
        matched: 'POST /users',
      }),
      edge('config-compose', 'DEFINES', 'container-postgres', {
        source: 'configuration-analyzer',
        confidence: 'high',
        method: 'yaml',
        file: 'docker-compose.yml',
        line: 13,
      }),
      edge('migration', 'DEFINES', 'table-users', {
        source: 'sql-analyzer',
        confidence: 'high',
        method: 'sql',
        file: 'database/migrations/0001_create_users.sql',
        line: 6,
      }),
    ],
  };
}

describe('the API over a repository knowledge graph', () => {
  let harness: Harness;
  let projectId: string;

  beforeAll(async () => {
    harness = await createHarness();

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'knowledge-sample' },
    });
    projectId = (body<Project>(created).data as Project).id;

    await harness.repositories.upsert({
      projectId,
      sourceType: 'local',
      sourcePath: SAMPLE_REPOSITORY,
    });

    harness.graph.setGraph(knowledgeGraph(projectId));
  });

  afterAll(async () => {
    await harness.app.close();
  });

  const get = async <T>(url: string): Promise<ApiResponse<T>> =>
    body<T>(await harness.app.inject({ method: 'GET', url: `/api/projects/${projectId}${url}` }));

  describe('search', () => {
    it('finds a document section by its heading', async () => {
      const found = await get<CodeNode[]>(
        `/graph/search?q=Authentication`,
      );

      expect(found.success).toBe(true);
      expect(found.data?.map((node) => node.type)).toContain('document_section');
    });

    it('finds a configuration property by its dotted key', async () => {
      const found = await get<CodeNode[]>(
        `/graph/search?q=scripts.build`,
      );

      expect(found.data?.[0]).toMatchObject({
        type: 'config_property',
        qualifiedName: 'package.json#scripts.build',
      });
    });

    it('finds a column by its qualified name', async () => {
      const found = await get<CodeNode[]>(`/graph/search?q=users.email`);

      expect(found.data?.[0]).toMatchObject({ type: 'column', name: 'email' });
    });

    it('narrows to a category without the caller knowing the node types', async () => {
      const found = await get<CodeNode[]>(
        `/graph/search?q=users&categories=knowledge`,
      );

      expect(found.success).toBe(true);
      for (const node of found.data ?? []) {
        expect(['document', 'document_section', 'config', 'config_property']).toContain(node.type);
      }
      // And says which types that meant, so a caller can see the resolution.
      expect(found.meta.nodeTypes).toContain('document');
    });

    it('keeps the existing node-type filter working unchanged', async () => {
      const found = await get<CodeNode[]>(
        `/graph/search?q=user&nodeTypes=class`,
      );

      expect(found.data?.every((node) => node.type === 'class')).toBe(true);
    });

    it('intersects a category with an explicit type rather than widening', async () => {
      const found = await get<CodeNode[]>(
        `/graph/search?q=users&nodeTypes=class&categories=knowledge`,
      );

      // `class` is code and `knowledge` is not, so the intersection is empty
      // and the honest answer is nothing at all.
      expect(found.data).toEqual([]);
      expect(found.meta.total).toBe(0);
    });

    it('narrows to a path prefix', async () => {
      const all = await get<CodeNode[]>(`/graph/search?q=user`);
      const scoped = await get<CodeNode[]>(
        `/graph/search?q=user&file=src/services`,
      );

      expect((scoped.data ?? []).length).toBeLessThan((all.data ?? []).length);
      for (const node of scoped.data ?? []) {
        expect(node.filePath).toMatch(/^src\/services/);
      }
    });

    it('rejects a category that is not one', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/graph/search?q=x&categories=nonsense`,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('node detail', () => {
    it('reports the category and family of every node, derived from its type', async () => {
      const detail = await get<NodeDetail>(
        `/graph/nodes/doc-readme`,
      );

      expect(detail.data?.symbol).toMatchObject({
        type: 'document',
        category: 'knowledge',
        family: 'documentation',
        fileCategory: 'document',
      });
    });

    it('reports the file category the scanner recorded', async () => {
      const spec = await get<NodeDetail>(`/graph/nodes/spec`);
      expect(spec.data?.symbol.fileCategory).toBe('schema');

      const compose = await get<NodeDetail>(
        `/graph/nodes/config-compose`,
      );
      expect(compose.data?.symbol).toMatchObject({
        fileCategory: 'configuration',
        category: 'knowledge',
        family: 'configuration',
      });
    });

    it('reports null for a node that does not stand for a file', async () => {
      const column = await get<NodeDetail>(`/graph/nodes/column-email`);

      expect(column.data?.symbol).toMatchObject({
        category: 'architecture',
        family: 'resources',
        fileCategory: null,
      });
    });

    it('still reports code nodes the way it always did', async () => {
      const detail = await get<NodeDetail>(
        `/graph/nodes/class-controller`,
      );

      expect(detail.data?.symbol).toMatchObject({
        type: 'class',
        category: 'code',
        family: 'types',
        filePath: 'src/controllers/user.controller.ts',
      });
    });

    it('carries the whole evidence record on a related node', async () => {
      const detail = await get<NodeDetail>(`/graph/nodes/class-auth`);

      const documented = detail.data?.documentation.find(
        (related) => related.relationship === 'DOCUMENTS',
      );

      expect(documented).toMatchObject({
        type: 'document_section',
        direction: 'incoming',
        confidence: 'medium',
        evidenceSource: 'document-analyzer',
        evidence: {
          source: 'document-analyzer',
          confidence: 'medium',
          method: 'markdown',
          file: 'README.md',
          line: 14,
          matched: 'AuthService',
        },
      });
    });

    it('finds the parent of a section, which is its document', async () => {
      const detail = await get<NodeDetail>(`/graph/nodes/section-auth`);

      expect(detail.data?.parent).toMatchObject({ id: 'doc-readme', type: 'document' });
    });
  });

  describe('the source explorer', () => {
    it('lists documents, specifications and configuration beside the code', async () => {
      const tree = await get<SourceTree>(`/graph/tree`);
      const entries = (tree.data?.entries ?? []).map((entry) => entry.path);

      expect(entries).toEqual(
        expect.arrayContaining(['README.md', 'openapi.yaml', 'docker-compose.yml', 'src', 'docs']),
      );
    });

    it('descends into a directory that holds only documents', async () => {
      const tree = await get<SourceTree>(
        `/graph/tree?path=docs`,
      );

      expect(tree.data?.entries).toMatchObject([
        { path: 'docs/architecture.md', name: 'architecture.md', type: 'file' },
      ]);
    });

    it('descends into a migrations directory', async () => {
      const tree = await get<SourceTree>(
        `/graph/tree?path=database/migrations`,
      );

      expect(tree.data?.entries.map((entry) => entry.name)).toEqual(['0001_create_users.sql']);
    });

    it('opens a Markdown file at the section that was selected', async () => {
      const source = await get<SourceWindow>(
        `/source?nodeId=section-auth&context=2`,
      );

      expect(source.data).toMatchObject({ file: 'README.md', language: 'markdown' });
      expect(source.data?.highlight).toMatchObject({ startLine: 12, endLine: 17 });
      expect(source.data?.lines.some((line) => line.text.includes('## Authentication'))).toBe(true);
    });

    it('opens a YAML specification at the operation that was selected', async () => {
      const source = await get<SourceWindow>(
        `/source?nodeId=endpoint-create&context=1`,
      );

      expect(source.data).toMatchObject({ file: 'openapi.yaml', language: 'yaml' });
      expect(source.data?.lines.some((line) => line.text.includes('post:'))).toBe(true);
    });

    it('opens a SQL migration', async () => {
      const source = await get<SourceWindow>(
        `/source?file=${encodeURIComponent('database/migrations/0001_create_users.sql')}`,
      );

      expect(source.data).toMatchObject({ file: 'database/migrations/0001_create_users.sql', language: 'sql' });
      expect(source.data?.lines.some((line) => line.text.includes('CREATE TABLE'))).toBe(true);
    });

    it('still refuses a path outside the repository', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/source?file=${encodeURIComponent('../../etc/passwd')}`,
      });

      // Forbidden, not "not found": the sandbox refused it before looking.
      expect(response.statusCode).toBe(403);
      expect(body(response).error?.code).toBe('SOURCE_PATH_NOT_ALLOWED');
    });
  });

  describe('projections', () => {
    it('serves the documentation slice', async () => {
      const graph = await get<CodeGraph>(
        `/graph?projection=documentation`,
      );

      expect(graph.success).toBe(true);
      expect(graph.meta.projection).toBe('documentation');
      for (const node of graph.data?.nodes ?? []) {
        expect(graph.meta.nodeTypes).toContain(node.type);
      }
    });

    it('serves the cross-source slice, which filters edges and not nodes', async () => {
      const graph = await get<CodeGraph>(
        `/graph?projection=cross-source`,
      );

      expect(graph.meta.nodeTypes).toBeNull();
      expect(graph.meta.relationships).toContain('IMPLEMENTED_BY');
    });

    it('keeps every projection the toolbar had', async () => {
      for (const projection of [
        'everything',
        'architecture',
        'calls',
        'files',
        'dependencies',
        'dataflow',
      ]) {
        const graph = await get<CodeGraph>(
          `/graph?projection=${projection}`,
        );
        expect(graph.success).toBe(true);
      }
    });
  });
});
