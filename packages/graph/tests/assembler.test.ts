import { describe, expect, it } from 'vitest';
import {
  CodeGraphAssembler,
  SymbolIndex,
  draftRef,
  nodeRef,
  serializeGraph,
  type AnalysisContext,
  type AnalysisResult,
  type AnalysisStage,
  type CodeAnalyzer,
  type CodeGraph,
  type SourceFile,
  type SourceFileSet,
} from '@ckg/graph';

/**
 * The assembler's merge rules are what keep a multi-source graph trustworthy,
 * so they are tested against stub analyzers rather than through a real
 * analysis: the question here is "what happens when two sources disagree",
 * which no fixture can ask as directly.
 */

const IDENTITY = { projectId: 'project-1', repositoryId: 'repository-1' };

class StubSources implements SourceFileSet {
  readonly truncated = false;
  constructor(private readonly files: SourceFile[] = []) {}
  all(): readonly SourceFile[] {
    return this.files;
  }
  byPath(relativePath: string): SourceFile | undefined {
    return this.files.find((file) => file.relativePath === relativePath);
  }
  matching(...suffixes: string[]): readonly SourceFile[] {
    return this.files.filter((file) => suffixes.some((suffix) => file.relativePath.endsWith(suffix)));
  }
}

class StubAnalyzer implements CodeAnalyzer {
  constructor(
    readonly name: string,
    readonly stage: AnalysisStage,
    private readonly result: AnalysisResult | ((context: AnalysisContext) => AnalysisResult),
    private readonly supported = true,
  ) {}

  supports(): boolean {
    return this.supported;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    return typeof this.result === 'function' ? this.result(context) : this.result;
  }
}

/** A finished graph, as the SCIP stage produces one. */
function baseGraph(): CodeGraph {
  return {
    nodes: [
      { id: 'file-1', projectId: IDENTITY.projectId, type: 'file', name: 'user.service.ts', filePath: 'src/user.service.ts' },
      {
        id: 'class-1',
        projectId: IDENTITY.projectId,
        type: 'class',
        name: 'UserService',
        qualifiedName: 'UserService',
        filePath: 'src/user.service.ts',
        startLine: 10,
        endLine: 40,
      },
      {
        id: 'method-1',
        projectId: IDENTITY.projectId,
        type: 'method',
        name: 'create',
        qualifiedName: 'UserService.create',
        filePath: 'src/user.service.ts',
        startLine: 12,
        endLine: 20,
      },
    ],
    edges: [
      {
        id: 'edge-1',
        projectId: IDENTITY.projectId,
        sourceNodeId: 'file-1',
        targetNodeId: 'class-1',
        relationship: 'CONTAINS',
        metadata: { source: 'scip', confidence: 'high' },
      },
      {
        id: 'edge-2',
        projectId: IDENTITY.projectId,
        sourceNodeId: 'class-1',
        targetNodeId: 'method-1',
        relationship: 'CONTAINS',
        metadata: { source: 'scip', confidence: 'high' },
      },
    ],
  };
}

function assemble(analyzers: CodeAnalyzer[], files: SourceFile[] = []) {
  return new CodeGraphAssembler({
    identity: IDENTITY,
    repositoryName: 'sample',
    repositoryPath: '/tmp/sample',
    sources: new StubSources(files),
    analyzers,
  }).assemble();
}

const scipStage = (): CodeAnalyzer =>
  new StubAnalyzer('scip', 'code-intelligence', {
    graph: baseGraph(),
    stats: { documentCount: 1, symbolCount: 3, unresolvedReferenceCount: 7 },
  });

const tableDraft = {
  type: 'table' as const,
  name: 'users',
  symbolKey: 'table:users',
  qualifiedName: 'postgresql.users',
};

describe('CodeGraphAssembler', () => {
  it('returns the code-intelligence graph unchanged when nothing else runs', async () => {
    const result = await assemble([scipStage()]);

    expect(result.nodes.map((node) => node.id).sort()).toEqual(['class-1', 'file-1', 'method-1']);
    expect(result.stats).toMatchObject({
      documentCount: 1,
      symbolCount: 3,
      nodeCount: 3,
      edgeCount: 2,
      unresolvedReferenceCount: 7,
      droppedEdgeCount: 0,
    });
    expect(result.analyzersRun).toEqual(['scip']);
  });

  it('adds an analyzer’s nodes and edges to the same graph', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('database-analyzer', 'source', {
        nodes: [tableDraft],
        edges: [
          {
            from: nodeRef('method-1'),
            to: draftRef(tableDraft),
            relationship: 'WRITES_TO',
            evidence: { source: 'database-analyzer', confidence: 'high' },
          },
        ],
      }),
    ]);

    const table = result.nodes.find((node) => node.type === 'table');
    expect(table).toMatchObject({ name: 'users', qualifiedName: 'postgresql.users' });

    const edge = result.edges.find((candidate) => candidate.relationship === 'WRITES_TO');
    expect(edge).toMatchObject({
      sourceNodeId: 'method-1',
      targetNodeId: table?.id,
      metadata: { source: 'database-analyzer', confidence: 'high', occurrences: 1 },
    });
  });

  it('requires every edge to carry evidence of where it came from', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('api-analyzer', 'source', {
        edges: [
          {
            from: nodeRef('class-1'),
            to: nodeRef('method-1'),
            relationship: 'CALLS',
            evidence: { source: 'api-analyzer', confidence: 'medium' },
          },
        ],
      }),
    ]);

    for (const edge of result.edges) {
      expect(typeof edge.metadata?.source).toBe('string');
      expect(typeof edge.metadata?.confidence).toBe('string');
    }
  });

  it('drops an edge whose endpoint does not exist, and counts it', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('api-analyzer', 'source', {
        edges: [
          {
            from: nodeRef('method-1'),
            to: nodeRef('never-created'),
            relationship: 'ROUTES_TO',
            evidence: { source: 'api-analyzer', confidence: 'high' },
          },
          {
            // A draft the analyzer forgot to declare is not conjured into being.
            from: nodeRef('method-1'),
            to: draftRef(tableDraft),
            relationship: 'WRITES_TO',
            evidence: { source: 'database-analyzer', confidence: 'high' },
          },
        ],
      }),
    ]);

    expect(result.stats.droppedEdgeCount).toBe(2);
    expect(result.edges.some((edge) => edge.relationship === 'ROUTES_TO')).toBe(false);
    expect(result.nodes.some((node) => node.type === 'table')).toBe(false);
  });

  it('never lets an analyzer replace a node the compiler already described', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('rogue', 'source', {
        // Same identity as the SCIP class node would have if it were a draft.
        nodes: [
          {
            type: 'class',
            name: 'SomethingElse',
            symbolKey: 'UserService',
            filePath: 'src/user.service.ts',
          },
        ],
      }),
    ]);

    expect(result.nodes.find((node) => node.id === 'class-1')?.name).toBe('UserService');
  });

  it('lets a later analyzer annotate a node without owning it', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('framework-analyzer', 'classification', {
        enrichments: [{ nodeId: 'class-1', metadata: { role: 'service', roleEvidence: 'structural' } }],
      }),
    ]);

    expect(result.nodes.find((node) => node.id === 'class-1')?.metadata).toEqual({
      role: 'service',
      roleEvidence: 'structural',
    });
  });

  it('keeps existing metadata when an enrichment would overwrite it', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('first', 'source', {
        enrichments: [{ nodeId: 'class-1', metadata: { role: 'repository' } }],
      }),
      new StubAnalyzer('second', 'classification', {
        enrichments: [{ nodeId: 'class-1', metadata: { role: 'controller', extra: 1 } }],
      }),
    ]);

    expect(result.nodes.find((node) => node.id === 'class-1')?.metadata).toEqual({
      role: 'repository',
      extra: 1,
    });
  });

  it('gives a source analyzer a symbol index over the code-intelligence graph', async () => {
    let seen: { size: number; method: string | undefined } | null = null;

    await assemble([
      scipStage(),
      new StubAnalyzer('probe', 'source', (context) => {
        seen = {
          size: context.symbols.size,
          method: context.symbols.member('src/user.service.ts', 'UserService', 'create')?.id,
        };
        return {};
      }),
    ]);

    expect(seen).toEqual({ size: 3, method: 'method-1' });
  });

  it('gives the classification stage a symbol index that includes the source stage', async () => {
    let tableSeen: number | null = null;

    await assemble([
      scipStage(),
      new StubAnalyzer('database-analyzer', 'source', {
        nodes: [tableDraft],
        edges: [
          {
            from: nodeRef('method-1'),
            to: draftRef(tableDraft),
            relationship: 'WRITES_TO',
            evidence: { source: 'database-analyzer', confidence: 'high' },
          },
        ],
      }),
      new StubAnalyzer('framework-analyzer', 'classification', (context) => {
        tableSeen = context.symbols.ofType('table').length;
        return {};
      }),
    ]);

    expect(tableSeen).toBe(1);
  });

  it('skips an analyzer that says it has nothing to say', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('absent', 'source', { nodes: [tableDraft] }, false),
    ]);

    expect(result.analyzersRun).toEqual(['scip']);
    expect(result.nodes).toHaveLength(3);
  });

  it('namespaces analyzer counters and prefixes diagnostics', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('api-analyzer', 'source', {
        stats: { routeCount: 4 },
        diagnostics: ['two handlers did not resolve'],
      }),
    ]);

    expect(result.stats.counters).toEqual({ 'api-analyzer.routeCount': 4 });
    expect(result.diagnostics).toEqual(['api-analyzer: two handlers did not resolve']);
  });

  it('collapses the same relationship seen twice into one edge, keeping the stronger evidence', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('weak', 'source', {
        edges: [
          {
            from: nodeRef('class-1'),
            to: nodeRef('method-1'),
            relationship: 'CALLS',
            evidence: { source: 'graph-builder', confidence: 'medium' },
          },
        ],
      }),
      new StubAnalyzer('strong', 'source', {
        edges: [
          {
            from: nodeRef('class-1'),
            to: nodeRef('method-1'),
            relationship: 'CALLS',
            evidence: { source: 'scip', confidence: 'high' },
          },
        ],
      }),
    ]);

    const calls = result.edges.filter((edge) => edge.relationship === 'CALLS');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata).toMatchObject({
      occurrences: 2,
      source: 'scip',
      confidence: 'high',
    });
  });

  it('is deterministic: the same analyzers twice produce byte-identical graphs', async () => {
    const analyzers = (): CodeAnalyzer[] => [
      scipStage(),
      new StubAnalyzer('database-analyzer', 'source', {
        nodes: [tableDraft],
        edges: [
          {
            from: nodeRef('method-1'),
            to: draftRef(tableDraft),
            relationship: 'WRITES_TO',
            evidence: { source: 'database-analyzer', confidence: 'high' },
          },
        ],
      }),
    ];

    const first = await assemble(analyzers());
    const second = await assemble(analyzers());

    expect(serializeGraph(first)).toBe(serializeGraph(second));
  });

  it('sorts nodes and edges by id, whatever order they were found in', async () => {
    const result = await assemble([
      scipStage(),
      new StubAnalyzer('database-analyzer', 'source', {
        nodes: [
          tableDraft,
          { type: 'table', name: 'orders', symbolKey: 'table:orders' },
          { type: 'database', name: 'postgresql', symbolKey: 'database:postgresql' },
        ],
      }),
    ]);

    const ids = result.nodes.map((node) => node.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

describe('SymbolIndex', () => {
  const index = new SymbolIndex({
    ...baseGraph(),
    edges: [
      ...baseGraph().edges,
      {
        id: 'edge-3',
        projectId: IDENTITY.projectId,
        sourceNodeId: 'method-1',
        targetNodeId: 'table-1',
        relationship: 'WRITES_TO',
        metadata: { source: 'database-analyzer', confidence: 'high' },
      },
    ],
    nodes: [
      ...baseGraph().nodes,
      { id: 'table-1', projectId: IDENTITY.projectId, type: 'table', name: 'users' },
    ],
  });

  it('finds a declaration by file and name', () => {
    expect(index.declaration('src/user.service.ts', 'UserService')?.id).toBe('class-1');
  });

  it('finds a member by its dotted name', () => {
    expect(index.member('src/user.service.ts', 'UserService', 'create')?.id).toBe('method-1');
  });

  it('does not find a declaration in a file that does not declare it', () => {
    expect(index.declaration('src/other.ts', 'UserService')).toBeUndefined();
  });

  it('narrows by node type when asked', () => {
    expect(index.declaration('src/user.service.ts', 'UserService', ['interface'])).toBeUndefined();
  });

  it('walks up CONTAINS to the owning class', () => {
    expect(index.enclosingContainer('method-1')?.id).toBe('class-1');
    // A class is not inside another container here, and a file is not one.
    expect(index.enclosingContainer('class-1')).toBeUndefined();
  });

  it('attributes a line to the innermost definition containing it', () => {
    expect(index.enclosingDefinition('src/user.service.ts', 15)?.id).toBe('method-1');
    expect(index.enclosingDefinition('src/user.service.ts', 35)?.id).toBe('class-1');
    expect(index.enclosingDefinition('src/user.service.ts', 99)).toBeUndefined();
  });

  it('answers relationship questions in both directions', () => {
    expect(index.related('method-1', 'WRITES_TO', 'outgoing').map((node) => node.id)).toEqual([
      'table-1',
    ]);
    expect(index.related('table-1', 'WRITES_TO', 'incoming').map((node) => node.id)).toEqual([
      'method-1',
    ]);
  });

  it('can include members when asking whether a class touches something', () => {
    expect(index.hasRelationship('class-1', 'WRITES_TO', 'outgoing')).toBe(false);
    expect(index.hasRelationship('class-1', 'WRITES_TO', 'outgoing', true)).toBe(true);
  });

  it('is empty, not broken, when constructed with no graph', () => {
    const empty = new SymbolIndex();
    expect(empty.size).toBe(0);
    expect(empty.repository()).toBeUndefined();
    expect(empty.inFile('anything')).toEqual([]);
  });
});
