import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import {
  CodeGraphAssembler,
  ScipAnalyzer,
  serializeGraph,
  type AssembledGraph,
  type CodeEdge,
  type CodeNode,
  type CodeRelationship,
} from '@ckg/graph';
import { createDefaultAnalyzers, loadSourceFiles } from '@ckg/analysis';

/**
 * The analyzers against a real repository, end to end.
 *
 * `test-repositories/express-postgres-sample` is a layered Express service with
 * SQL, a queue, an event bus and two third-party integrations, and this is the
 * test that says the graph it produces is the one its README draws. The SCIP
 * index is the checked-in fixture — the indexer subprocess is the one genuinely
 * external step — and everything after it is the real parser, refiner, builder
 * and analyzers.
 */

const FIXTURE = fileURLToPath(
  new URL('../../scip/tests/fixtures/express-postgres-sample.scip', import.meta.url),
);
const SAMPLE = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/express-postgres-sample', import.meta.url)),
);

const IDENTITY = {
  projectId: '11111111-1111-4111-8111-111111111111',
  repositoryId: '22222222-2222-4222-8222-222222222222',
};

async function assemble(): Promise<AssembledGraph> {
  const index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), {
    repositoryPath: SAMPLE,
  });

  return new CodeGraphAssembler({
    identity: IDENTITY,
    repositoryName: 'express-postgres-sample',
    repositoryPath: SAMPLE,
    language: 'typescript',
    sources: await loadSourceFiles(SAMPLE),
    analyzers: [new ScipAnalyzer({ index }), ...createDefaultAnalyzers()],
  }).assemble();
}

describe('source analyzers over the sample service', () => {
  let graph: AssembledGraph;
  let nodesById: Map<string, CodeNode>;

  beforeAll(async () => {
    graph = await assemble();
    nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  }, 60_000);

  const find = (type: CodeNode['type'], name: string): CodeNode | undefined =>
    graph.nodes.find(
      (node) => node.type === type && (node.name === name || node.qualifiedName === name),
    );

  const edgesOf = (relationship: CodeRelationship): CodeEdge[] =>
    graph.edges.filter((edge) => edge.relationship === relationship);

  const linked = (
    from: { type: CodeNode['type']; name: string },
    relationship: CodeRelationship,
    to: { type: CodeNode['type']; name: string },
  ): CodeEdge | undefined => {
    const source = find(from.type, from.name);
    const target = find(to.type, to.name);
    if (!source || !target) return undefined;

    return graph.edges.find(
      (edge) =>
        edge.sourceNodeId === source.id &&
        edge.targetNodeId === target.id &&
        edge.relationship === relationship,
    );
  };

  describe('the SCIP layer is untouched', () => {
    it('still produces the symbol graph, with the analyzers adding to it', () => {
      expect(find('class', 'UserService')).toBeDefined();
      expect(find('method', 'UserService.create')).toBeDefined();
      expect(find('interface', 'User')).toBeDefined();
      expect(graph.stats.documentCount).toBeGreaterThan(0);
      expect(graph.stats.symbolCount).toBeGreaterThan(0);
    });

    it('names symbols by their dotted qualified name, not by their file path', () => {
      const method = find('method', 'UserRepository.create');

      expect(method?.qualifiedName).toBe('UserRepository.create');
      expect(method?.filePath).toBe('src/repositories/user.repository.ts');
      expect(method?.startLine).toBeGreaterThan(0);
      expect(method?.startCharacter).toBeGreaterThanOrEqual(0);
    });

    it('runs every analyzer, in stage order', () => {
      expect(graph.analyzersRun[0]).toBe('scip');
      expect(graph.analyzersRun).toEqual(
        expect.arrayContaining([
          'file-analyzer',
          'import-analyzer',
          'structure-analyzer',
          'api-analyzer',
          'database-analyzer',
          'external-service-analyzer',
          'messaging-analyzer',
          'framework-analyzer',
        ]),
      );
      // Classification runs last, over the finished graph.
      expect(graph.analyzersRun.at(-1)).toBe('framework-analyzer');
    });
  });

  describe('APIs', () => {
    it('finds every route the sample declares, at its mounted path', () => {
      const routes = graph.nodes
        .filter((node) => node.type === 'api')
        .map((node) => node.name)
        .sort();

      expect(routes).toEqual([
        'DELETE /users/:id',
        'GET /health',
        'GET /users',
        'GET /users/:id',
        'PATCH /users/:id/verify',
        'POST /users',
      ]);
    });

    it('records the method, path, framework and handler as metadata', () => {
      expect(find('api', 'POST /users')?.metadata).toMatchObject({
        httpMethod: 'POST',
        path: '/users',
        framework: 'express',
        mountedAt: '/users',
        handler: 'UserController.create',
      });
    });

    it('locates the route in the file that declares it', () => {
      const route = find('api', 'POST /users');
      expect(route?.filePath).toBe('src/api/user.routes.ts');
      expect(route?.startLine).toBeGreaterThan(0);
    });

    it('routes each API to the handler method, through the inline wrapper', () => {
      const edge = linked(
        { type: 'api', name: 'POST /users' },
        'ROUTES_TO',
        { type: 'method', name: 'UserController.create' },
      );

      expect(edge?.metadata).toMatchObject({ source: 'api-analyzer', confidence: 'high', via: 'inline' });
    });

    it('also routes to the controller class, so an architecture view connects', () => {
      const edge = linked(
        { type: 'api', name: 'GET /users/:id' },
        'ROUTES_TO',
        { type: 'class', name: 'UserController' },
      );

      expect(edge?.metadata).toMatchObject({ derived: true, confidence: 'medium' });
    });

    it('leaves a route whose handler resolves to nothing without a ROUTES_TO edge', () => {
      // `/health` answers inline and calls nothing, so there is no handler node
      // to point at — and none is invented.
      const health = find('api', 'GET /health');
      expect(health).toBeDefined();

      const routed = edgesOf('ROUTES_TO').filter((edge) => edge.sourceNodeId === health?.id);
      expect(routed).toEqual([]);
    });

    it('contains each route in the file it was declared in', () => {
      const file = graph.nodes.find((node) => node.filePath === 'src/api/user.routes.ts' && node.type === 'file');
      const route = find('api', 'POST /users');

      expect(
        graph.edges.some(
          (edge) =>
            edge.sourceNodeId === file?.id &&
            edge.targetNodeId === route?.id &&
            edge.relationship === 'CONTAINS',
        ),
      ).toBe(true);
    });
  });

  describe('the database', () => {
    it('finds the provider and the tables the SQL names', () => {
      expect(find('database', 'postgresql')?.metadata).toMatchObject({
        provider: 'postgresql',
        detectedFrom: 'package.json:pg',
      });
      expect(find('table', 'postgresql.users')).toBeDefined();
      // `orders` appears only in a LEFT JOIN.
      expect(find('table', 'postgresql.orders')).toBeDefined();
    });

    it('holds its tables', () => {
      expect(linked({ type: 'database', name: 'postgresql' }, 'CONTAINS', {
        type: 'table',
        name: 'postgresql.users',
      })).toBeDefined();
    });

    it('distinguishes a write from a read', () => {
      expect(
        linked({ type: 'method', name: 'UserRepository.create' }, 'WRITES_TO', {
          type: 'table',
          name: 'postgresql.users',
        })?.metadata,
      ).toMatchObject({ statement: 'INSERT', confidence: 'high' });

      expect(
        linked({ type: 'method', name: 'UserRepository.findById' }, 'READS_FROM', {
          type: 'table',
          name: 'postgresql.users',
        })?.metadata,
      ).toMatchObject({ statement: 'SELECT', confidence: 'high' });

      expect(
        linked({ type: 'method', name: 'UserRepository.markVerified' }, 'WRITES_TO', {
          type: 'table',
          name: 'postgresql.users',
        })?.metadata,
      ).toMatchObject({ statement: 'UPDATE' });
    });

    it('does not read a table it only deletes from', () => {
      expect(
        linked({ type: 'method', name: 'UserRepository.remove' }, 'WRITES_TO', {
          type: 'table',
          name: 'postgresql.users',
        }),
      ).toBeDefined();
      expect(
        linked({ type: 'method', name: 'UserRepository.remove' }, 'READS_FROM', {
          type: 'table',
          name: 'postgresql.users',
        }),
      ).toBeUndefined();
    });

    it('lifts a method’s access to the class that owns it', () => {
      const edge = linked({ type: 'class', name: 'UserRepository' }, 'WRITES_TO', {
        type: 'table',
        name: 'postgresql.users',
      });

      expect(edge?.metadata).toMatchObject({ derived: true, confidence: 'medium' });
    });

    it('attributes only the methods that touch a table', () => {
      const writers = edgesOf('WRITES_TO')
        .map((edge) => nodesById.get(edge.sourceNodeId))
        .filter((node) => node?.type === 'method')
        .map((node) => node?.qualifiedName)
        .sort();

      expect(writers).toEqual([
        'UserRepository.create',
        'UserRepository.markVerified',
        'UserRepository.remove',
      ]);
    });
  });

  describe('external services', () => {
    it('finds a vendor from its SDK import', () => {
      expect(find('external_service', 'stripe')?.metadata).toMatchObject({
        vendor: 'Stripe',
        category: 'payments',
        package: 'stripe',
      });
    });

    it('finds a vendor from an absolute URL in the source', () => {
      expect(find('external_service', 'sendgrid')?.metadata).toMatchObject({
        vendor: 'SendGrid',
        host: 'api.sendgrid.com',
      });
    });

    it('says which class calls out of the process', () => {
      expect(
        linked({ type: 'class', name: 'PaymentService' }, 'CALLS', {
          type: 'external_service',
          name: 'Stripe',
        })?.metadata,
      ).toMatchObject({ via: 'sdk', package: 'stripe' });

      expect(
        linked({ type: 'class', name: 'EmailService' }, 'CALLS', {
          type: 'external_service',
          name: 'SendGrid',
        }),
      ).toBeDefined();
    });

    it('records them as dependencies of the service as a whole', () => {
      const dependencies = edgesOf('DEPENDS_ON_SERVICE')
        .map((edge) => nodesById.get(edge.targetNodeId)?.name)
        .sort();

      expect(dependencies).toEqual(['SendGrid', 'Stripe']);
    });

    it('invents nothing for a host that names no dependency', () => {
      const hosts = graph.nodes
        .filter((node) => node.type === 'external_service')
        .map((node) => node.name);

      expect(hosts).not.toContain('localhost');
      expect(hosts).not.toContain('example.com');
    });
  });

  describe('queues and events', () => {
    it('finds the queue, with a publisher and a consumer', () => {
      expect(find('queue', 'welcome-emails')).toBeDefined();

      expect(
        linked({ type: 'class', name: 'UserService' }, 'PUBLISHES', {
          type: 'queue',
          name: 'welcome-emails',
        }),
      ).toBeDefined();

      expect(
        linked({ type: 'function', name: 'startWelcomeEmailWorker' }, 'SUBSCRIBES', {
          type: 'queue',
          name: 'welcome-emails',
        })?.metadata,
      ).toMatchObject({ via: 'bullmq' });
    });

    it('finds the domain event, named through the constant it is declared as', () => {
      // The source publishes `USER_CREATED`, declared as 'user.created' in
      // another file.
      expect(find('event', 'user.created')).toBeDefined();

      expect(
        linked({ type: 'method', name: 'UserService.create' }, 'PUBLISHES', {
          type: 'event',
          name: 'user.created',
        }),
      ).toBeDefined();

      expect(
        linked({ type: 'function', name: 'registerUserCreatedListener' }, 'SUBSCRIBES', {
          type: 'event',
          name: 'user.created',
        }),
      ).toBeDefined();
    });
  });

  describe('the service and its dependencies', () => {
    it('names the service from the manifest', () => {
      expect(find('service', 'users-service')?.metadata).toMatchObject({
        packageName: 'users-service',
        version: '1.2.0',
      });
    });

    it('depends on every declared package', () => {
      const dependencies = edgesOf('DEPENDS_ON')
        .filter((edge) => nodesById.get(edge.sourceNodeId)?.type === 'service')
        .map((edge) => nodesById.get(edge.targetNodeId)?.name)
        .sort();

      expect(dependencies).toEqual(['bullmq', 'express', 'pg', 'stripe']);
    });

    it('does not count Node\u2019s standard library as a dependency', () => {
      const packages = graph.nodes
        .filter((node) => node.type === 'module' && node.metadata?.external === true)
        .map((node) => node.name);

      expect(packages).not.toContain('node:events');
      expect(packages).not.toContain('events');
    });

    it('is configured by the files that configure it, and not by ordinary code', () => {
      const configured = edgesOf('CONFIGURED_BY')
        .map((edge) => nodesById.get(edge.targetNodeId)?.name)
        .sort();

      expect(configured).toEqual(['.env.example', 'package.json', 'tsconfig.json']);
    });

    it('records the frameworks in use on the repository and the service', () => {
      expect(find('service', 'users-service')?.metadata?.frameworks).toEqual(['bullmq', 'express']);
      expect(graph.nodes.find((node) => node.type === 'repository')?.metadata?.frameworks).toEqual([
        'bullmq',
        'express',
      ]);
    });

    it('exports what each file exports', () => {
      const exported = edgesOf('EXPORTS')
        .map((edge) => nodesById.get(edge.targetNodeId)?.name)
        .filter((name): name is string => name !== undefined);

      expect(exported).toEqual(expect.arrayContaining(['UserService', 'UserRepository', 'toUser']));
    });
  });

  describe('signatures and construction', () => {
    it('says what a method accepts and returns', () => {
      expect(
        linked({ type: 'method', name: 'UserRepository.create' }, 'ACCEPTS', {
          type: 'interface',
          name: 'CreateUserInput',
        }),
      ).toBeDefined();

      // `Promise<User>` mentions both; only `User` is a node.
      expect(
        linked({ type: 'method', name: 'UserRepository.create' }, 'RETURNS', {
          type: 'interface',
          name: 'User',
        }),
      ).toBeDefined();
    });

    it('says what constructs what', () => {
      expect(
        linked({ type: 'function', name: 'createApp' }, 'INSTANTIATES', {
          type: 'class',
          name: 'UserService',
        }),
      ).toBeDefined();
    });
  });

  describe('roles', () => {
    it('classifies each class from evidence in the graph, not from its name', () => {
      const roles = Object.fromEntries(
        graph.nodes
          .filter((node) => node.metadata?.role !== undefined)
          .map((node) => [node.name, node.metadata?.role]),
      );

      expect(roles).toMatchObject({
        UserController: 'controller',
        UserService: 'service',
        UserRepository: 'repository',
        EmailService: 'client',
        PaymentService: 'client',
      });
    });

    it('records why, so the label can be checked', () => {
      expect(find('class', 'UserRepository')?.metadata?.roleEvidence).toMatch(/database table/);
      expect(find('class', 'UserController')?.metadata?.roleEvidence).toMatch(/API route/);
    });

    it('does not label a class it has no evidence about', () => {
      expect(find('class', 'UserNotFoundError')?.metadata?.role).toBeUndefined();
    });
  });

  describe('data quality', () => {
    it('gives every edge a source and a confidence', () => {
      for (const edge of graph.edges) {
        expect(typeof edge.metadata?.source).toBe('string');
        expect(['high', 'medium', 'low']).toContain(edge.metadata?.confidence);
      }
    });

    it('marks SCIP-derived relationships as high confidence', () => {
      const scip = graph.edges.filter((edge) => edge.metadata?.source === 'scip');

      expect(scip.length).toBeGreaterThan(0);
      expect(scip.every((edge) => edge.metadata?.confidence === 'high')).toBe(true);
    });

    it('marks every derived aggregate as such, and never as high confidence', () => {
      const derived = graph.edges.filter((edge) => edge.metadata?.derived === true);

      expect(derived.length).toBeGreaterThan(0);
      expect(derived.every((edge) => edge.metadata?.confidence === 'medium')).toBe(true);
    });

    it('never emits an edge whose endpoints are not both nodes', () => {
      for (const edge of graph.edges) {
        expect(nodesById.has(edge.sourceNodeId)).toBe(true);
        expect(nodesById.has(edge.targetNodeId)).toBe(true);
      }
    });

    it('drops nothing it could not resolve into the graph', () => {
      expect(graph.stats.droppedEdgeCount).toBe(0);
    });

    it('does not claim this repository declares another package\u2019s types', () => {
      // `src/types/vendor.d.ts` contains `declare module 'pg' { class Pool }`.
      // `Pool`, `Stripe` and `Router` describe packages this service depends
      // on; the dependency is a node, the class is not.
      const names = graph.nodes.map((node) => node.qualifiedName ?? node.name);

      expect(names.some((name) => name.startsWith("'"))).toBe(false);
      expect(names).not.toContain('Pool');
      expect(names).not.toContain('Stripe');
      // The dependency itself is still recorded.
      expect(
        graph.nodes.some((node) => node.type === 'module' && node.name === 'pg'),
      ).toBe(true);
    });

    it('creates one node per architectural thing, however many files mention it', () => {
      for (const type of ['service', 'database', 'queue', 'event'] as const) {
        const names = graph.nodes.filter((node) => node.type === type).map((node) => node.name);
        expect(new Set(names).size).toBe(names.length);
      }
    });
  });

  describe('determinism', () => {
    it('produces a byte-identical graph on a second run', async () => {
      const second = await assemble();
      expect(serializeGraph(second)).toBe(serializeGraph(graph));
    }, 60_000);

    it('derives architectural ids from content, so they survive re-analysis', async () => {
      const second = await assemble();

      const architectural = (assembled: AssembledGraph): string[] =>
        assembled.nodes
          .filter((node) => ['api', 'service', 'table', 'queue', 'event'].includes(node.type))
          .map((node) => `${node.type}:${node.name}:${node.id}`)
          .sort();

      expect(architectural(second)).toEqual(architectural(graph));
    }, 60_000);
  });
});
