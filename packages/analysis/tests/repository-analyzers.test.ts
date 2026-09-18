import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import {
  CodeGraphAssembler,
  ScipAnalyzer,
  type AssembledGraph,
  type CodeEdge,
  type CodeNode,
  type CodeNodeType,
  type CodeRelationship,
} from '@ckg/graph';
import { edgeEvidence } from '@ckg/shared';
import { createDefaultAnalyzers, loadSourceFiles } from '@ckg/analysis';

/**
 * The repository analyzers against a repository that is deliberately more than
 * its code.
 *
 * `test-repositories/repository-knowledge-sample` holds TypeScript, Markdown,
 * JSON, YAML, an OpenAPI contract and two SQL migrations, arranged so that each
 * of them says something the others do not. This is the test that says the
 * graph joins them — and, just as importantly, that it declines to join the
 * things it cannot join honestly.
 *
 * The SCIP index is the checked-in fixture; everything after it is the real
 * parsers, analyzers and assembler.
 */

const FIXTURE = fileURLToPath(
  new URL('../../scip/tests/fixtures/repository-knowledge-sample.scip', import.meta.url),
);
const SAMPLE = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/repository-knowledge-sample', import.meta.url)),
);

const IDENTITY = {
  projectId: '33333333-3333-4333-8333-333333333333',
  repositoryId: '44444444-4444-4444-8444-444444444444',
};

async function assemble(): Promise<AssembledGraph> {
  const index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), {
    repositoryPath: SAMPLE,
  });

  return new CodeGraphAssembler({
    identity: IDENTITY,
    repositoryName: 'repository-knowledge-sample',
    repositoryPath: SAMPLE,
    language: 'typescript',
    sources: await loadSourceFiles(SAMPLE),
    analyzers: [new ScipAnalyzer({ index }), ...createDefaultAnalyzers()],
  }).assemble();
}

describe('the repository analyzers over a mixed-format repository', () => {
  let graph: AssembledGraph;
  let byId: Map<string, CodeNode>;

  beforeAll(async () => {
    graph = await assemble();
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  }, 60_000);

  const find = (type: CodeNodeType, name: string): CodeNode | undefined =>
    graph.nodes.find(
      (node) => node.type === type && (node.name === name || node.qualifiedName === name),
    );

  const of = (type: CodeNodeType): CodeNode[] => graph.nodes.filter((node) => node.type === type);

  /**
   * How a node is addressed. The accumulator stores no `qualifiedName` when it
   * would only repeat `name`, so `README.md` at the repository root has one
   * and `docs/architecture.md` has the other.
   */
  const addressOf = (node: CodeNode): string => node.qualifiedName ?? node.name;

  const linked = (
    from: { type: CodeNodeType; name: string },
    relationship: CodeRelationship,
    to: { type: CodeNodeType; name: string },
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

  const edgesOf = (relationship: CodeRelationship): CodeEdge[] =>
    graph.edges.filter((edge) => edge.relationship === relationship);

  it('runs every analyzer without one failing or dropping an edge', () => {
    expect(graph.stats.failedAnalyzerCount).toBe(0);
    // An edge naming an endpoint that does not exist is a bug in whichever
    // analyzer declared it, and would be invisible in the node counts.
    expect(graph.stats.droppedEdgeCount).toBe(0);
    expect(graph.analyzersRun).toEqual(
      expect.arrayContaining([
        'scip',
        'sql-analyzer',
        'configuration-analyzer',
        'openapi-analyzer',
        'document-analyzer',
      ]),
    );
  });

  it('leaves the SCIP layer exactly as it was', () => {
    expect(find('class', 'UserService')).toBeDefined();
    expect(find('method', 'UserService.create')).toBeDefined();
    expect(linked(
      { type: 'method', name: 'UserController.create' },
      'CALLS',
      { type: 'method', name: 'UserService.create' },
    )).toBeDefined();
  });

  describe('documents', () => {
    it('makes a node for each Markdown file, with its title', () => {
      expect(of('document').map(addressOf).sort()).toEqual([
        'README.md',
        'docs/architecture.md',
      ]);
      expect(find('document', 'README.md')?.metadata).toMatchObject({
        title: 'Knowledge Sample',
        category: 'document',
        role: 'readme',
      });
    });

    it('makes a node per heading, ranged and nested', () => {
      const section = find('document_section', 'README.md#authentication');

      expect(section).toMatchObject({ filePath: 'README.md', metadata: { level: 2 } });
      expect(section?.startLine).toBeLessThan(section?.endLine ?? 0);

      // A level-2 heading is contained by its level-1 heading, not by the file.
      expect(linked(
        { type: 'document_section', name: 'README.md#knowledge-sample' },
        'CONTAINS',
        { type: 'document_section', name: 'README.md#authentication' },
      )).toBeDefined();
    });

    it('puts the document in the repository tree', () => {
      const directories = of('directory').map(addressOf);
      expect(directories).toContain('docs');

      expect(linked(
        { type: 'directory', name: 'docs' },
        'CONTAINS',
        { type: 'document', name: 'docs/architecture.md' },
      )).toBeDefined();
    });

    it('resolves a distinctive name in prose to the one class that carries it', () => {
      const edge = linked(
        { type: 'document_section', name: 'README.md#authentication' },
        'DOCUMENTS',
        { type: 'class', name: 'AuthService' },
      );

      expect(edge).toBeDefined();
      expect(edgeEvidence(edge as CodeEdge)).toMatchObject({
        source: 'document-analyzer',
        method: 'markdown',
        confidence: 'medium',
        file: 'README.md',
        matched: 'AuthService',
      });
      expect(edgeEvidence(edge as CodeEdge)?.line).toBeGreaterThan(0);
    });

    it('never claims more than medium confidence for a name match', () => {
      for (const edge of edgesOf('DOCUMENTS')) {
        expect(edge.metadata?.confidence).toBe('medium');
      }
    });

    it('does not document a name it cannot resolve to exactly one node', () => {
      // `PostgreSQL` appears in the architecture notes and is not a node.
      const targets = edgesOf('DOCUMENTS').map((edge) => byId.get(edge.targetNodeId)?.name);
      expect(targets).not.toContain('PostgreSQL');
      expect(targets.every((name) => name !== undefined)).toBe(true);
    });

    it('follows a link to a file that exists, in either direction', () => {
      expect(linked(
        { type: 'document', name: 'README.md' },
        'LINKS_TO',
        { type: 'document', name: 'docs/architecture.md' },
      )).toBeDefined();
      expect(linked(
        { type: 'document', name: 'docs/architecture.md' },
        'LINKS_TO',
        { type: 'document', name: 'README.md' },
      )).toBeDefined();
    });

    it('links to a configuration file, not only to prose', () => {
      expect(linked(
        { type: 'document', name: 'README.md' },
        'LINKS_TO',
        { type: 'config', name: 'docker-compose.yml' },
      )).toBeDefined();
    });
  });

  describe('configuration', () => {
    it('describes every recognised configuration file exactly once', () => {
      expect(of('config').map(addressOf).sort()).toEqual([
        '.env.example',
        'Dockerfile',
        'config/app.config.json',
        'docker-compose.yml',
        'package.json',
        'tsconfig.json',
      ]);
    });

    it('reads a Dockerfile for its base images and ports', () => {
      expect(find('config', 'Dockerfile')?.metadata).toMatchObject({
        baseImages: ['node:20-alpine'],
        exposedPorts: [8080],
        buildStages: 2,
      });
    });

    it('promotes a manifest to its scripts and engines, not its dependencies', () => {
      const promoted = of('config_property')
        .filter((node) => node.filePath === 'package.json')
        .map((node) => node.name)
        .sort();

      expect(promoted).toEqual([
        'engines.node',
        'scripts.build',
        'scripts.migrate',
        'scripts.start',
      ]);
      // Dependencies are the import analyzer's, at a more useful altitude.
      expect(promoted.some((name) => name.startsWith('dependencies'))).toBe(false);
    });

    it('promotes the compiler options that change what the code means', () => {
      const promoted = of('config_property')
        .filter((node) => node.filePath === 'tsconfig.json')
        .map((node) => node.name);

      expect(promoted).toContain('compilerOptions.strict');
      expect(promoted).toContain('compilerOptions.target');
      // `skipLibCheck` is in the file and is not one of them.
      expect(promoted).not.toContain('compilerOptions.skipLibCheck');
    });

    it('promotes a plain config file two levels deep, and no further', () => {
      const promoted = of('config_property')
        .filter((node) => node.filePath === 'config/app.config.json')
        .map((node) => node.name)
        .sort();

      expect(promoted).toEqual([
        'database.host',
        'database.poolSize',
        'database.port',
        'port',
        'serviceName',
        'session.secret',
        'session.ttlSeconds',
      ]);
    });

    it('records a value, unless the key names a credential', () => {
      expect(find('config_property', 'config/app.config.json#database.host')?.metadata).toEqual({
        key: 'database.host',
        value: 'localhost',
      });
      expect(find('config_property', 'config/app.config.json#session.secret')?.metadata).toEqual({
        key: 'session.secret',
        redacted: true,
      });
    });

    it('reads an example environment file for names and nothing else', () => {
      const variables = of('config_property')
        .filter((node) => node.filePath === '.env.example')
        .map((node) => node.name)
        .sort();

      expect(variables).toEqual(['DATABASE_URL', 'PORT', 'SESSION_SECRET']);

      for (const node of of('config_property').filter((n) => n.filePath === '.env.example')) {
        expect(node.metadata).not.toHaveProperty('value');
      }
    });

    it('makes a container per compose service, and links what they declare', () => {
      expect(of('container').map((node) => node.name).sort()).toEqual(['api', 'postgres']);

      expect(find('container', 'postgres')?.metadata).toMatchObject({
        image: 'postgres:16-alpine',
        declaredIn: 'docker-compose.yml',
      });

      expect(linked(
        { type: 'config', name: 'docker-compose.yml' },
        'DEFINES',
        { type: 'container', name: 'api' },
      )).toBeDefined();
      expect(linked(
        { type: 'container', name: 'api' },
        'DEPENDS_ON',
        { type: 'container', name: 'postgres' },
      )).toBeDefined();
    });

    it('joins a container to the database its image names', () => {
      const edge = linked(
        { type: 'container', name: 'postgres' },
        'USES',
        { type: 'database', name: 'postgresql' },
      );

      expect(edge).toBeDefined();
      expect(edgeEvidence(edge as CodeEdge)).toMatchObject({
        source: 'configuration-analyzer',
        method: 'yaml',
        confidence: 'high',
        file: 'docker-compose.yml',
      });
    });

    it('records the environment variable names a service needs', () => {
      expect(find('container', 'api')?.metadata?.environment).toEqual(['DATABASE_URL', 'PORT']);
    });
  });

  describe('the data model', () => {
    it('declares the tables a migration creates, at the provider-qualified name', () => {
      expect(of('table').map(addressOf).sort()).toEqual([
        'postgresql.sessions',
        'postgresql.users',
      ]);
    });

    it('is one node for a table the schema declares and the code writes', () => {
      // The repository class writes to `users` and the migration creates it.
      // Two analyzers, one node — which is the whole point of the shared draft.
      expect(of('table').filter((node) => node.name === 'users')).toHaveLength(1);

      const users = find('table', 'postgresql.users') as CodeNode;
      expect(users.metadata).toMatchObject({ declaredIn: 'database/migrations/0001_create_users.sql' });

      expect(linked(
        { type: 'method', name: 'UserRepository.create' },
        'WRITES_TO',
        { type: 'table', name: 'postgresql.users' },
      )).toBeDefined();
    });

    it('declares every column, with its type and constraints', () => {
      const columns = of('column')
        .filter((node) => node.metadata?.table === 'users')
        .map((node) => node.name)
        .sort();

      expect(columns).toEqual([
        'created_at',
        'display_name',
        'email',
        'id',
        'last_seen_at',
        'role',
        'verified_at',
      ]);

      expect(find('column', 'postgresql.users.email')?.metadata).toMatchObject({
        dataType: 'TEXT',
        notNull: true,
        unique: true,
      });
    });

    it('keeps a column under the table that declared it', () => {
      expect(linked(
        { type: 'table', name: 'postgresql.users' },
        'CONTAINS',
        { type: 'column', name: 'postgresql.users.email' },
      )).toBeDefined();
      // Two tables with an `id` column are two columns, not one.
      expect(of('column').filter((node) => node.name === 'id')).toHaveLength(2);
    });

    it('records a foreign key as a relationship between the tables', () => {
      const edge = linked(
        { type: 'table', name: 'postgresql.sessions' },
        'REFERENCES',
        { type: 'table', name: 'postgresql.users' },
      );

      expect(edge?.metadata).toMatchObject({ foreignKey: true, fromColumn: 'user_id' });
    });

    it('credits the migration file with defining the table', () => {
      const edge = linked(
        { type: 'file', name: 'database/migrations/0001_create_users.sql' },
        'DEFINES',
        { type: 'table', name: 'postgresql.users' },
      );

      expect(edgeEvidence(edge as CodeEdge)).toMatchObject({
        source: 'sql-analyzer',
        method: 'sql',
        confidence: 'high',
        file: 'database/migrations/0001_create_users.sql',
      });
    });
  });

  describe('the API contract', () => {
    it('makes a spec node from the document, not from the file name', () => {
      expect(find('api_spec', 'openapi.yaml')?.metadata).toMatchObject({
        flavour: 'openapi-3',
        specVersion: '3.0.3',
        title: 'Knowledge Sample API',
        operationCount: 3,
      });
    });

    it('declares one endpoint per operation, keeping the spec spelling', () => {
      expect(of('api_endpoint').map((node) => node.name).sort()).toEqual([
        'GET /users/{id}',
        'POST /sessions',
        'POST /users',
      ]);
      expect(find('api_endpoint', 'POST /users')?.metadata).toMatchObject({
        operationId: 'createUser',
        requestSchemas: ['CreateUserInput'],
        responses: ['201', '400'],
      });
    });

    it('matches a declared operation to the route that serves it, across dialects', () => {
      // The specification writes `{id}` and the router writes `:id`.
      const edge = linked(
        { type: 'api_endpoint', name: 'GET /users/{id}' },
        'IMPLEMENTED_BY',
        { type: 'api', name: 'GET /users/:id' },
      );

      expect(edge?.metadata).toMatchObject({ via: 'route' });
      expect(edgeEvidence(edge as CodeEdge)).toMatchObject({
        confidence: 'high',
        method: 'openapi',
        file: 'openapi.yaml',
      });
    });

    it('reaches the handler as well as the route', () => {
      const handler = linked(
        { type: 'api_endpoint', name: 'POST /users' },
        'IMPLEMENTED_BY',
        { type: 'method', name: 'UserController.create' },
      );
      expect(handler?.metadata).toMatchObject({ via: 'handler' });
      expect(handler?.metadata?.confidence).toBe('high');
    });

    it('inherits the weaker confidence when the handler was reached by lifting', () => {
      const container = linked(
        { type: 'api_endpoint', name: 'POST /users' },
        'IMPLEMENTED_BY',
        { type: 'class', name: 'UserController' },
      );
      // The route reaches the class by lifting to the enclosing container, so
      // composing the two facts cannot be more certain than that step.
      expect(container?.metadata?.confidence).toBe('medium');
    });

    it('leaves an undelivered promise visible instead of inventing a handler', () => {
      const sessions = find('api_endpoint', 'POST /sessions') as CodeNode;

      expect(
        graph.edges.filter(
          (edge) => edge.sourceNodeId === sessions.id && edge.relationship === 'IMPLEMENTED_BY',
        ),
      ).toEqual([]);
      expect(graph.stats.counters['openapi-analyzer.unimplementedCount']).toBe(1);
    });

    it('links a named schema to the declaration that carries the name', () => {
      expect(linked(
        { type: 'api_endpoint', name: 'POST /users' },
        'REFERENCES',
        { type: 'interface', name: 'CreateUserInput' },
      )).toBeDefined();
    });
  });

  describe('what the whole graph guarantees', () => {
    it('gives every edge evidence naming an analyzer and a confidence', () => {
      for (const edge of graph.edges) {
        expect(edgeEvidence(edge)).not.toBeNull();
      }
    });

    it('gives every edge read out of a file a file and a line', () => {
      const fileBorne = graph.edges
        .map((edge) => edgeEvidence(edge))
        .filter((found) => found?.method !== undefined && found.method !== 'scip' && found.method !== 'graph');

      expect(fileBorne.length).toBeGreaterThan(0);
      for (const found of fileBorne) {
        expect(found?.file).toBeTruthy();
        expect(found?.line).toBeGreaterThan(0);
      }
    });

    it('is deterministic: two runs produce the same graph', async () => {
      const second = await assemble();

      expect(second.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
      expect(second.edges.map((edge) => edge.id)).toEqual(graph.edges.map((edge) => edge.id));
    }, 60_000);

    it('keeps the interiors of documents, configs and tables off the default view', () => {
      // Sections, properties and columns are real and are tier-2 detail. They
      // must exist, and they must not outnumber everything else put together.
      const detail = of('document_section').length + of('config_property').length + of('column').length;
      expect(detail).toBeGreaterThan(0);
      expect(detail).toBeLessThan(graph.nodes.length / 2);
    });
  });
});
