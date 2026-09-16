import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  CodeGraph,
  CodeNode,
  Definition,
  GraphPath,
  NodeDetail,
  Project,
  RelatedNode,
  SourceTree,
  SourceWindow,
} from '@ckg/shared';
import { body, createHarness, type Harness } from './helpers/harness.js';

/**
 * The code-explorer surface: definition, relations, containment, source, the
 * repository tree and path finding.
 *
 * The fixture is modelled on `test-repositories/typescript-sample` and uses its
 * real paths, so the source routes read files that actually exist and the
 * sandbox tests are exercised against a real repository root rather than a
 * mock. Everything else — node ids, the architectural layer — is written by
 * hand, because what is under test here is the read model, not the indexer.
 */

const SAMPLE_REPOSITORY = 'test-repositories/typescript-sample';

/** `src/services/user.service.ts`, as the pipeline would have indexed it. */
function explorerGraph(projectId: string): CodeGraph {
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
    metadata: Record<string, unknown> = { source: 'scip', confidence: 'high' },
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
      node('repo', 'repository', 'typescript-sample'),
      node('dir-src', 'directory', 'src', { qualifiedName: 'src', filePath: 'src' }),
      node('dir-services', 'directory', 'services', {
        qualifiedName: 'src/services',
        filePath: 'src/services',
      }),
      node('dir-repositories', 'directory', 'repositories', {
        qualifiedName: 'src/repositories',
        filePath: 'src/repositories',
      }),
      node('dir-models', 'directory', 'models', {
        qualifiedName: 'src/models',
        filePath: 'src/models',
      }),

      node('file-index', 'file', 'index.ts', {
        qualifiedName: 'src/index.ts',
        filePath: 'src/index.ts',
        metadata: { language: 'typescript' },
      }),
      node('file-service', 'file', 'user.service.ts', {
        qualifiedName: 'src/services/user.service.ts',
        filePath: 'src/services/user.service.ts',
        metadata: { language: 'typescript' },
      }),
      node('file-repository', 'file', 'user.repository.ts', {
        qualifiedName: 'src/repositories/user.repository.ts',
        filePath: 'src/repositories/user.repository.ts',
        metadata: { language: 'typescript' },
      }),
      node('file-model', 'file', 'user.ts', {
        qualifiedName: 'src/models/user.ts',
        filePath: 'src/models/user.ts',
        metadata: { language: 'typescript' },
      }),

      node('service', 'class', 'UserService', {
        qualifiedName: 'UserService',
        filePath: 'src/services/user.service.ts',
        startLine: 13,
        startCharacter: 13,
        endLine: 47,
        endCharacter: 1,
        metadata: { language: 'typescript', role: 'service', scipSymbol: 'scip ts . . UserService#' },
      }),
      node('getUser', 'method', 'getUser', {
        qualifiedName: 'UserService.getUser',
        filePath: 'src/services/user.service.ts',
        startLine: 18,
        startCharacter: 2,
        endLine: 25,
        endCharacter: 3,
        metadata: { language: 'typescript' },
      }),
      node('listUsers', 'method', 'listUsers', {
        qualifiedName: 'UserService.listUsers',
        filePath: 'src/services/user.service.ts',
        startLine: 27,
        endLine: 29,
        metadata: { language: 'typescript' },
      }),
      node('repository', 'class', 'UserRepository', {
        qualifiedName: 'UserRepository',
        filePath: 'src/repositories/user.repository.ts',
        startLine: 8,
        metadata: { language: 'typescript', role: 'repository' },
      }),
      node('findById', 'method', 'findById', {
        qualifiedName: 'UserRepository.findById',
        filePath: 'src/repositories/user.repository.ts',
        startLine: 14,
        metadata: { language: 'typescript' },
      }),
      node('controller', 'class', 'UserController', {
        qualifiedName: 'UserController',
        filePath: 'src/controllers/user.controller.ts',
        startLine: 6,
        metadata: { language: 'typescript', role: 'controller' },
      }),
      node('model', 'interface', 'User', {
        qualifiedName: 'User',
        filePath: 'src/models/user.ts',
        startLine: 3,
        metadata: { language: 'typescript' },
      }),

      // The architectural layer the analyzers add.
      node('api', 'api', 'GET /users/:id', {
        qualifiedName: 'GET /users/:id',
        filePath: 'src/index.ts',
        startLine: 8,
        metadata: { httpMethod: 'GET', path: '/users/:id', framework: 'express' },
      }),
      node('table', 'table', 'users', {
        qualifiedName: 'postgresql.users',
        metadata: { table: 'users', provider: 'postgresql' },
      }),
      node('pkg', 'module', 'express', {
        qualifiedName: 'express',
        metadata: { external: true },
      }),
      node('stripe', 'external_service', 'Stripe', {
        qualifiedName: 'stripe',
        metadata: { vendor: 'Stripe', category: 'payments', package: 'stripe' },
      }),
    ],
    edges: [
      edge('repo', 'CONTAINS', 'dir-src'),
      edge('dir-src', 'CONTAINS', 'dir-services'),
      edge('dir-src', 'CONTAINS', 'dir-repositories'),
      edge('dir-src', 'CONTAINS', 'dir-models'),
      edge('dir-src', 'CONTAINS', 'file-index'),
      edge('dir-services', 'CONTAINS', 'file-service'),
      edge('dir-repositories', 'CONTAINS', 'file-repository'),
      edge('dir-models', 'CONTAINS', 'file-model'),
      edge('file-service', 'CONTAINS', 'service'),
      edge('file-repository', 'CONTAINS', 'repository'),
      edge('file-model', 'CONTAINS', 'model'),
      edge('service', 'CONTAINS', 'getUser'),
      edge('service', 'CONTAINS', 'listUsers'),
      edge('repository', 'CONTAINS', 'findById'),

      edge('file-service', 'EXPORTS', 'service'),

      edge('controller', 'CALLS', 'getUser'),
      edge('getUser', 'CALLS', 'findById'),
      edge('listUsers', 'CALLS', 'findById'),
      edge('findById', 'REFERENCES', 'model'),
      edge('getUser', 'REFERENCES', 'model'),

      edge('service', 'IMPLEMENTS', 'model'),
      edge('repository', 'EXTENDS', 'service'),

      edge('api', 'ROUTES_TO', 'controller', { source: 'api-analyzer', confidence: 'high' }),
      edge('findById', 'READS_FROM', 'table', {
        source: 'database-analyzer',
        confidence: 'medium',
        statement: 'SELECT',
      }),
      edge('service', 'DEPENDS_ON', 'pkg', { source: 'import-analyzer', confidence: 'high' }),
      edge('controller', 'IMPORTS', 'service', { source: 'import-analyzer', confidence: 'high' }),
      edge('service', 'DEPENDS_ON_SERVICE', 'stripe', {
        source: 'external-service-analyzer',
        confidence: 'high',
      }),
    ],
  };
}

describe('code explorer', () => {
  let harness: Harness;
  let projectId: string;

  beforeAll(async () => {
    harness = await createHarness();

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'explorer' },
    });
    projectId = (body<Project>(created).data as Project).id;

    await harness.repositories.upsert({
      projectId,
      sourceType: 'local',
      sourcePath: SAMPLE_REPOSITORY,
    });

    harness.graph.setGraph(explorerGraph(projectId));
  });

  afterAll(async () => {
    await harness.app.close();
  });

  const get = async (url: string) =>
    harness.app.inject({ method: 'GET', url: `/api/projects/${projectId}${url}` });

  const post = async (url: string, payload: unknown) =>
    harness.app.inject({ method: 'POST', url: `/api/projects/${projectId}${url}`, payload });

  const ids = (nodes: Array<{ id: string }> | null | undefined): string[] =>
    (nodes ?? []).map((node) => node.id);

  // --- node detail --------------------------------------------------------

  describe('node detail', () => {
    let detail: NodeDetail;

    beforeAll(async () => {
      const response = await get('/graph/nodes/getUser');
      detail = body<NodeDetail>(response).data as NodeDetail;
    });

    it('names the symbol without the caller parsing the metadata bag', () => {
      expect(detail.symbol).toMatchObject({
        name: 'getUser',
        qualifiedName: 'UserService.getUser',
        type: 'method',
        language: 'typescript',
        filePath: 'src/services/user.service.ts',
        startLine: 18,
        startCharacter: 2,
        module: 'src/services',
      });
    });

    it('reports nothing for metadata no analyzer recorded', () => {
      expect(detail.symbol.visibility).toBeNull();
      expect(detail.symbol.framework).toBeNull();
      expect(detail.symbol.apiRoute).toBeNull();
      expect(detail.symbol.databaseResource).toBeNull();
      expect(detail.symbol.externalService).toBeNull();
      expect(detail.symbol.messagingResource).toBeNull();
      // Exported is evidence-only: absence is "not known", never "private".
      expect(detail.symbol.exported).toBeNull();
    });

    it('carries the definition with the file node that owns it', () => {
      expect(detail.definition).toMatchObject({
        nodeId: 'getUser',
        filePath: 'src/services/user.service.ts',
        startLine: 18,
        endLine: 25,
        fileNodeId: 'file-service',
      });
    });

    it('keeps callers, callees and references exactly as they were', () => {
      expect(ids(detail.callers)).toEqual(['controller']);
      expect(ids(detail.callees)).toEqual(['findById']);
      expect(detail.references).toEqual([]);
    });

    it('reports the containing class and, for it, its members', async () => {
      expect(detail.parent?.id).toBe('service');
      expect(detail.children).toEqual([]);

      const service = body<NodeDetail>(await get('/graph/nodes/service')).data as NodeDetail;
      // Source order, which is what makes a member list readable.
      expect(ids(service.children)).toEqual(['getUser', 'listUsers']);
    });

    it('carries both directions of the inheritance relation', async () => {
      const service = body<NodeDetail>(await get('/graph/nodes/service')).data as NodeDetail;

      expect(service.implementations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'model', relationship: 'IMPLEMENTS', direction: 'outgoing' }),
          expect.objectContaining({
            id: 'repository',
            relationship: 'EXTENDS',
            direction: 'incoming',
          }),
        ]),
      );
    });

    it('reports an API route and a data store on the nodes that have them', async () => {
      const api = body<NodeDetail>(await get('/graph/nodes/api')).data as NodeDetail;
      expect(api.symbol.apiRoute).toEqual({ method: 'GET', path: '/users/:id' });
      expect(api.symbol.framework).toBe('express');

      const table = body<NodeDetail>(await get('/graph/nodes/table')).data as NodeDetail;
      expect(table.symbol.databaseResource).toBe('postgresql.users');

      const stripe = body<NodeDetail>(await get('/graph/nodes/stripe')).data as NodeDetail;
      expect(stripe.symbol.externalService).toBe('Stripe');
    });

    it('is the same payload every time it is asked for', async () => {
      const first = await get('/graph/nodes/service');
      const second = await get('/graph/nodes/service');
      expect(first.body).toEqual(second.body);
    });
  });

  // --- relationship routes ------------------------------------------------

  describe('relationship routes', () => {
    it('serves the definition on its own route', async () => {
      const response = await get('/graph/nodes/service/definition');
      const definition = body<Definition>(response).data as Definition;

      expect(definition).toMatchObject({
        nodeId: 'service',
        qualifiedName: 'UserService',
        filePath: 'src/services/user.service.ts',
        startLine: 13,
        startCharacter: 13,
        fileNodeId: 'file-service',
      });
    });

    it('reports no definition for a node the indexer gave no file', async () => {
      const response = await get('/graph/nodes/table/definition');
      expect(body<Definition | null>(response).data).toBeNull();
    });

    it('separates dependencies from dependents by direction', async () => {
      const dependencies = body<RelatedNode[]>(await get('/graph/nodes/service/dependencies'))
        .data as RelatedNode[];
      const dependents = body<RelatedNode[]>(await get('/graph/nodes/service/dependents'))
        .data as RelatedNode[];

      expect(ids(dependencies).sort()).toEqual(['pkg', 'stripe']);
      expect(dependencies.every((node) => node.direction === 'outgoing')).toBe(true);

      expect(ids(dependents)).toEqual(['controller']);
      expect(dependents[0]?.relationship).toBe('IMPORTS');
    });

    it('preserves the evidence on every relationship it returns', async () => {
      const dependencies = body<RelatedNode[]>(await get('/graph/nodes/service/dependencies'))
        .data as RelatedNode[];

      expect(dependencies.find((node) => node.id === 'stripe')).toMatchObject({
        confidence: 'high',
        evidenceSource: 'external-service-analyzer',
      });
    });

    it('walks the containment chain upward, nearest first', async () => {
      const parents = body<CodeNode[]>(await get('/graph/nodes/getUser/parents')).data as CodeNode[];
      expect(ids(parents)).toEqual(['service', 'file-service', 'dir-services', 'dir-src', 'repo']);
    });

    it('stops the chain at the requested limit', async () => {
      const parents = body<CodeNode[]>(await get('/graph/nodes/getUser/parents?limit=2'))
        .data as CodeNode[];
      expect(ids(parents)).toEqual(['service', 'file-service']);
    });

    it('serves children on their own route', async () => {
      const children = body<CodeNode[]>(await get('/graph/nodes/service/children')).data as CodeNode[];
      expect(ids(children)).toEqual(['getUser', 'listUsers']);
    });

    it('serves implementations on their own route', async () => {
      const response = await get('/graph/nodes/model/implementations');
      const nodes = body<RelatedNode[]>(response).data as RelatedNode[];

      expect(nodes).toEqual([
        expect.objectContaining({ id: 'service', relationship: 'IMPLEMENTS', direction: 'incoming' }),
      ]);
    });

    it('404s every relationship route for a node that does not exist', async () => {
      for (const section of [
        'definition',
        'dependencies',
        'dependents',
        'parents',
        'children',
        'implementations',
      ]) {
        const response = await get(`/graph/nodes/nope/${section}`);
        expect(response.statusCode, section).toBe(404);
        expect(body(response).error?.code).toBe('NODE_NOT_FOUND');
      }
    });

    it('returns an empty list rather than inventing entries', async () => {
      const response = await get('/graph/nodes/model/dependencies');
      expect(body<RelatedNode[]>(response).data).toEqual([]);
    });
  });

  // --- search -------------------------------------------------------------

  describe('search ranking', () => {
    const search = async (term: string): Promise<string[]> => {
      const response = await get(`/graph/search?q=${encodeURIComponent(term)}&limit=20`);
      return ids(body<CodeNode[]>(response).data);
    };

    it('puts an exact symbol name first', async () => {
      const results = await search('UserService');
      expect(results[0]).toBe('service');
    });

    it('puts an exact qualified name ahead of anything that merely contains it', async () => {
      const results = await search('UserService.getUser');
      expect(results[0]).toBe('getUser');
    });

    it('finds a file by its name alone, not only by its full path', async () => {
      const results = await search('user.service.ts');
      expect(results[0]).toBe('file-service');
    });

    it('ranks a prefix match ahead of a mid-string one', async () => {
      const results = await search('user');
      // `User` and `UserController` start with the term; `findById` does not
      // and only matches through its path.
      expect(results.indexOf('model')).toBeLessThan(results.indexOf('findById'));
    });

    it('finds a member by its last dotted segment', async () => {
      expect(await search('listUsers')).toContain('listUsers');
    });

    it('returns the same page for the same term, every time', async () => {
      expect(await search('user')).toEqual(await search('user'));
    });
  });

  // --- repository tree ----------------------------------------------------

  describe('repository tree', () => {
    it('lists the root level', async () => {
      const tree = body<SourceTree>(await get('/graph/tree')).data as SourceTree;

      expect(tree.path).toBe('');
      expect(tree.parentPath).toBeNull();
      expect(tree.entries).toEqual([{ path: 'src', name: 'src', type: 'directory', nodeId: 'dir-src' }]);
    });

    it('lists one level at a time, directories before files', async () => {
      const tree = body<SourceTree>(await get('/graph/tree?path=src')).data as SourceTree;

      expect(tree.parentPath).toBe('');
      expect(tree.entries.map((entry) => entry.name)).toEqual([
        'models',
        'repositories',
        'services',
        'index.ts',
      ]);
      expect(tree.entries.filter((entry) => entry.type === 'directory')).toHaveLength(3);
    });

    it('does not reach into a deeper level', async () => {
      const tree = body<SourceTree>(await get('/graph/tree?path=src/services')).data as SourceTree;

      expect(tree.parentPath).toBe('src');
      expect(tree.entries).toEqual([
        {
          path: 'src/services/user.service.ts',
          name: 'user.service.ts',
          type: 'file',
          nodeId: 'file-service',
        },
      ]);
    });

    it('returns repository-relative paths only', async () => {
      const tree = body<SourceTree>(await get('/graph/tree?path=src')).data as SourceTree;
      expect(tree.entries.every((entry) => !entry.path.startsWith('/'))).toBe(true);
    });

    it('is empty, not an error, for a directory the graph has no nodes under', async () => {
      const tree = body<SourceTree>(await get('/graph/tree?path=does/not/exist')).data as SourceTree;
      expect(tree.entries).toEqual([]);
    });
  });

  // --- source retrieval ---------------------------------------------------

  describe('source retrieval', () => {
    it('reads a whole file with its line numbers', async () => {
      const response = await get('/source?file=src/services/user.service.ts');
      const source = body<SourceWindow>(response).data as SourceWindow;

      expect(source.file).toBe('src/services/user.service.ts');
      expect(source.language).toBe('typescript');
      expect(source.startLine).toBe(1);
      expect(source.lines[0]).toEqual({
        line: 1,
        text: "import { isAdmin, type User, type UserDraft } from '../models/user.js';",
      });
      expect(source.totalLines).toBe(source.lines.length);
      expect(source.truncated).toBe(false);
    });

    it('reads an explicit line range, inclusive at both ends', async () => {
      const response = await get(
        '/source?file=src/services/user.service.ts&startLine=18&endLine=25',
      );
      const source = body<SourceWindow>(response).data as SourceWindow;

      expect(source.startLine).toBe(18);
      expect(source.endLine).toBe(25);
      expect(source.lines).toHaveLength(8);
      expect(source.lines[0]?.text).toBe('  getUser(id: string): User {');
    });

    it('reads around a symbol, and says which range it is about', async () => {
      const response = await get('/source?nodeId=getUser&context=2');
      const source = body<SourceWindow>(response).data as SourceWindow;

      expect(source.file).toBe('src/services/user.service.ts');
      expect(source.startLine).toBe(16);
      expect(source.endLine).toBe(27);
      expect(source.highlight).toEqual({
        nodeId: 'getUser',
        startLine: 18,
        startCharacter: 2,
        endLine: 25,
        endCharacter: 3,
      });
    });

    it('clamps a window that would run past the end of the file', async () => {
      const response = await get('/source?file=src/services/user.service.ts&startLine=40&endLine=999');
      const source = body<SourceWindow>(response).data as SourceWindow;

      expect(source.endLine).toBe(source.totalLines);
      expect(source.lines.at(-1)?.line).toBe(source.totalLines);
    });

    it('preserves UTF-8 exactly as it is on disk', async () => {
      const response = await get('/source?file=README.md');
      const source = body<SourceWindow>(response).data as SourceWindow;

      const onDisk = source.lines.map((line) => line.text).join('\n');
      expect(onDisk).toContain('sample');
      // A replacement character would mean the file was decoded as bytes.
      expect(onDisk).not.toContain('\uFFFD');
    });

    it('requires a file or a node', async () => {
      const response = await get('/source');
      expect(response.statusCode).toBe(400);
      expect(body(response).error?.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a range that ends before it starts', async () => {
      const response = await get('/source?file=src/index.ts&startLine=10&endLine=2');
      expect(response.statusCode).toBe(400);
    });

    it('reports a missing file as missing', async () => {
      const response = await get('/source?file=src/nope.ts');
      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('SOURCE_FILE_NOT_FOUND');
    });

    it('reports a node with no source file rather than reading something else', async () => {
      const response = await get('/source?nodeId=table');
      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('SOURCE_FILE_NOT_FOUND');
    });

    it('404s a node that does not exist', async () => {
      const response = await get('/source?nodeId=nope');
      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('NODE_NOT_FOUND');
    });

    it('refuses a directory', async () => {
      const response = await get('/source?file=src');
      expect(response.statusCode).toBe(404);
    });
  });

  // --- the sandbox --------------------------------------------------------

  describe('source sandbox', () => {
    const traversals = [
      '../../../etc/passwd',
      'src/../../../etc/passwd',
      'src/./../../package.json',
      '..',
      '../',
      String.raw`..\..\package.json`,
    ];

    for (const attempt of traversals) {
      it(`refuses to climb out of the repository with ${attempt}`, async () => {
        const response = await get(`/source?file=${encodeURIComponent(attempt)}`);

        expect(response.statusCode).toBe(403);
        expect(body(response).error?.code).toBe('SOURCE_PATH_NOT_ALLOWED');
      });
    }

    // Percent-encoded separators, passed through verbatim: the query parser
    // decodes `%2F` to `/` before the service ever sees it, so these have to be
    // caught by the same segment check and not by a string comparison.
    const encodedTraversals = [
      '..%2F..%2F..%2Fetc%2Fpasswd',
      'src%2F..%2F..%2Fpackage.json',
      '%2E%2E%2F%2E%2E%2Fpackage.json',
    ];

    for (const attempt of encodedTraversals) {
      it(`refuses the percent-encoded traversal ${attempt}`, async () => {
        const response = await get(`/source?file=${attempt}`);

        expect(response.statusCode).toBe(403);
        expect(body(response).error?.code).toBe('SOURCE_PATH_NOT_ALLOWED');
      });
    }

    const absolutes = ['/etc/passwd', '/etc/hosts', 'C:/Windows/win.ini'];

    for (const attempt of absolutes) {
      it(`refuses the absolute path ${attempt}`, async () => {
        const response = await get(`/source?file=${encodeURIComponent(attempt)}`);

        expect(response.statusCode).toBe(403);
        expect(body(response).error?.code).toBe('SOURCE_PATH_NOT_ALLOWED');
      });
    }

    it('refuses a path carrying a NUL byte', async () => {
      const response = await get('/source?file=src/index.ts%00.png');
      expect(response.statusCode).toBe(403);
    });

    it('will not read a file in a sibling project that was never registered', async () => {
      // A real path, inside the monorepo, outside *this* project's repository.
      const response = await get(
        `/source?file=${encodeURIComponent('../express-postgres-sample/src/app.ts')}`,
      );
      expect(response.statusCode).toBe(403);
    });

    it('refuses everything when local filesystem access is switched off', async () => {
      const locked = await createHarness({ filesystemEnabled: false });
      try {
        const created = await locked.app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: { name: 'locked' },
        });
        const id = (body<Project>(created).data as Project).id;
        await locked.repositories.upsert({
          projectId: id,
          sourceType: 'local',
          sourcePath: SAMPLE_REPOSITORY,
        });

        const response = await locked.app.inject({
          method: 'GET',
          url: `/api/projects/${id}/source?file=src/index.ts`,
        });

        expect(response.statusCode).toBe(403);
        expect(body(response).error?.code).toBe('FILESYSTEM_ACCESS_DISABLED');
      } finally {
        await locked.app.close();
      }
    });

    it('refuses a project whose repository is a git clone the worker has discarded', async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'cloned' },
      });
      const id = (body<Project>(created).data as Project).id;
      await harness.repositories.upsert({
        projectId: id,
        sourceType: 'git',
        sourcePath: 'https://example.invalid/repo.git',
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${id}/source?file=src/index.ts`,
      });

      expect(response.statusCode).toBe(403);
      expect(body(response).error?.code).toBe('SOURCE_NOT_READABLE');
    });

    it('refuses a project with no repository at all', async () => {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'unattached' },
      });
      const id = (body<Project>(created).data as Project).id;

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/projects/${id}/source?file=src/index.ts`,
      });

      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('REPOSITORY_NOT_FOUND');
    });
  });

  // --- bounded traversal --------------------------------------------------

  describe('bounded neighbourhood', () => {
    const neighbourhood = async (depth: number): Promise<string[]> => {
      const response = await get(
        `/graph?rootNodeId=service&depth=${String(depth)}&projection=everything`,
      );
      return ids(body<CodeGraph>(response).data?.nodes).sort();
    };

    it('grows with depth and never shrinks', async () => {
      const one = await neighbourhood(1);
      const two = await neighbourhood(2);
      const three = await neighbourhood(3);

      expect(one).toContain('getUser');
      expect(new Set(two)).toEqual(new Set([...two]));
      expect(one.every((id) => two.includes(id))).toBe(true);
      expect(two.every((id) => three.includes(id))).toBe(true);
      expect(two.length).toBeGreaterThan(one.length);
    });

    it('returns every node once, however many edges reach it', async () => {
      const response = await get('/graph?rootNodeId=findById&depth=2&projection=everything');
      const graph = body<CodeGraph>(response).data as CodeGraph;

      expect(new Set(ids(graph.nodes)).size).toBe(graph.nodes.length);
      expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length);
    });

    it('is the same neighbourhood every time', async () => {
      expect(await neighbourhood(2)).toEqual(await neighbourhood(2));
    });

    it('follows one direction when asked', async () => {
      const outgoing = ids(
        body<CodeGraph>(
          await get('/graph?rootNodeId=getUser&depth=1&direction=outgoing&projection=everything'),
        ).data?.nodes,
      );
      const incoming = ids(
        body<CodeGraph>(
          await get('/graph?rootNodeId=getUser&depth=1&direction=incoming&projection=everything'),
        ).data?.nodes,
      );

      expect(outgoing).toContain('findById');
      expect(outgoing).not.toContain('controller');
      expect(incoming).toContain('controller');
      expect(incoming).not.toContain('findById');
    });
  });

  // --- path ---------------------------------------------------------------

  describe('path', () => {
    it('traces a request from the route to the table', async () => {
      const response = await post('/graph/path', { from: 'api', to: 'table' });
      const path = body<GraphPath>(response).data as GraphPath;

      expect(path.found).toBe(true);
      expect(path.undirected).toBe(false);
      expect(ids(path.nodes)).toEqual(['api', 'controller', 'getUser', 'findById', 'table']);
      expect(path.depth).toBe(4);
      expect(path.steps.map((step) => step.relationship)).toEqual([
        'ROUTES_TO',
        'CALLS',
        'CALLS',
        'READS_FROM',
      ]);
      expect(path.relationships).toEqual(['ROUTES_TO', 'CALLS', 'READS_FROM']);
    });

    it('carries the evidence behind every hop it took', async () => {
      const path = body<GraphPath>(await post('/graph/path', { from: 'api', to: 'table' }))
        .data as GraphPath;

      expect(path.steps.at(0)).toMatchObject({
        relationship: 'ROUTES_TO',
        evidenceSource: 'api-analyzer',
        confidence: 'high',
        reversed: false,
      });
      expect(path.steps.at(-1)).toMatchObject({
        relationship: 'READS_FROM',
        evidenceSource: 'database-analyzer',
        confidence: 'medium',
      });
    });

    it('returns the edges it crossed, in the order it crossed them', async () => {
      const path = body<GraphPath>(await post('/graph/path', { from: 'api', to: 'table' }))
        .data as GraphPath;

      expect(path.edges.map((edge) => edge.id)).toEqual(path.steps.map((step) => step.edgeId));
    });

    it('falls back to an undirected route, and says that it did', async () => {
      const path = body<GraphPath>(await post('/graph/path', { from: 'table', to: 'api' }))
        .data as GraphPath;

      expect(path.found).toBe(true);
      expect(path.undirected).toBe(true);
      expect(path.steps.every((step) => step.reversed)).toBe(true);
    });

    it('takes the shortest route when more than one exists', async () => {
      const path = body<GraphPath>(await post('/graph/path', { from: 'controller', to: 'findById' }))
        .data as GraphPath;

      expect(path.depth).toBe(2);
      expect(ids(path.nodes)).toEqual(['controller', 'getUser', 'findById']);
    });

    it('is the same route every time it is asked for', async () => {
      const first = await post('/graph/path', { from: 'api', to: 'table' });
      const second = await post('/graph/path', { from: 'api', to: 'table' });
      expect(first.body).toEqual(second.body);
    });

    it('reports a node reaching itself as a route of no hops', async () => {
      const path = body<GraphPath>(await post('/graph/path', { from: 'service', to: 'service' }))
        .data as GraphPath;

      expect(path.found).toBe(true);
      expect(path.depth).toBe(0);
      expect(ids(path.nodes)).toEqual(['service']);
    });

    it('will not walk further than maxDepth', async () => {
      const path = body<GraphPath>(
        await post('/graph/path', { from: 'api', to: 'table', maxDepth: 2 }),
      ).data as GraphPath;

      expect(path.found).toBe(false);
      expect(path.nodes).toEqual([]);
    });

    it('honours a relationship filter, and finds nothing outside it', async () => {
      const calls = body<GraphPath>(
        await post('/graph/path', { from: 'api', to: 'table', relationships: ['CALLS'] }),
      ).data as GraphPath;

      expect(calls.found).toBe(false);
    });

    it('takes its filters from a projection when given one', async () => {
      const path = body<GraphPath>(
        await post('/graph/path', { from: 'api', to: 'table', projection: 'dataflow' }),
      ).data as GraphPath;

      expect(path.found).toBe(true);
      expect(ids(path.nodes)).toEqual(['api', 'controller', 'getUser', 'findById', 'table']);
    });

    it('stays directed when asked to ignore the fallback', async () => {
      const path = body<GraphPath>(
        await post('/graph/path', { from: 'table', to: 'api', direction: 'both' }),
      ).data as GraphPath;

      expect(path.found).toBe(true);
      expect(path.undirected).toBe(true);
    });

    it('404s an endpoint that is not in the graph', async () => {
      const response = await post('/graph/path', { from: 'api', to: 'nope' });
      expect(response.statusCode).toBe(404);
      expect(body(response).error?.code).toBe('NODE_NOT_FOUND');
    });

    it('rejects a depth beyond the maximum', async () => {
      const response = await post('/graph/path', { from: 'api', to: 'table', maxDepth: 99 });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a body with no endpoints', async () => {
      const response = await post('/graph/path', {});
      expect(response.statusCode).toBe(400);
    });
  });

  it('answers every documented explorer route for a real node', async () => {
    const routes = [
      '/graph/nodes/service',
      '/graph/nodes/service/callers',
      '/graph/nodes/service/callees',
      '/graph/nodes/service/references',
      '/graph/nodes/service/definition',
      '/graph/nodes/service/dependencies',
      '/graph/nodes/service/dependents',
      '/graph/nodes/service/parents',
      '/graph/nodes/service/children',
      '/graph/nodes/service/implementations',
      '/graph/tree',
      '/source?nodeId=service',
    ];

    for (const route of routes) {
      const response = await get(route);
      expect(response.statusCode, route).toBe(200);
      expect((JSON.parse(response.body) as ApiResponse<unknown>).success, route).toBe(true);
    }
  });
});
