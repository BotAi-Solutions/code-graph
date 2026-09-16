import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeEdge, CodeGraph, CodeNode, GraphPath } from '../src/types/index.js';
import { normalizeGraph } from '../src/features/code-graph/model/graph-transform.js';
import {
  ancestorPaths,
  isHighlighted,
  pathRows,
  pathSummary,
  searchSelectionAction,
  sourceTargetForNode,
} from '../src/features/code-graph/model/navigation.js';
import {
  fetchDefinition,
  fetchNodeSection,
  fetchTree,
  findPath,
  searchNodes,
} from '../src/api/graph.api.js';
import { fetchSource } from '../src/api/source.api.js';

/**
 * The explorer's navigation, at the two seams where it can be checked without a
 * browser: the decisions themselves, and the requests they turn into.
 *
 * The decisions are pure functions by design — a component that decided whether
 * a search result needs fetching would be a component with a graph question in
 * it. The requests matter because every one of them is a contract with the API,
 * and a wrong query parameter fails silently as "nothing found".
 */

// --- fixtures ---------------------------------------------------------------

const node = (id: string, type: CodeNode['type'], extra: Partial<CodeNode> = {}): CodeNode => ({
  id,
  projectId: 'p1',
  type,
  name: id,
  ...extra,
});

const edge = (
  id: string,
  source: string,
  target: string,
  relationship: CodeEdge['relationship'] = 'CALLS',
): CodeEdge => ({ id, projectId: 'p1', sourceNodeId: source, targetNodeId: target, relationship });

const GRAPH: CodeGraph = {
  nodes: [
    node('controller', 'class', { filePath: 'src/controllers/user.controller.ts' }),
    node('service', 'class', { filePath: 'src/services/user.service.ts' }),
  ],
  edges: [edge('e1', 'controller', 'service')],
};

const MODEL = normalizeGraph(GRAPH, { repository: null, commit: null });

// --- stubbing ---------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

/** Replies with the API's envelope, and records what was asked for. */
function stubApi(data: unknown, meta: Record<string, unknown> = {}): Captured[] {
  const calls: Captured[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });

      return new Response(JSON.stringify({ success: true, data, error: null, meta }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );

  return calls;
}

function stubFailure(status: number, code: string, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, data: null, error: { code, message }, meta: {} }),
          { status, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
}

// --- search result navigation ----------------------------------------------

describe('search result navigation', () => {
  it('moves the camera for a result already on the canvas', () => {
    expect(searchSelectionAction(MODEL, 'service')).toBe('focus');
  });

  it('re-roots for a result the current slice does not hold', () => {
    expect(searchSelectionAction(MODEL, 'repository')).toBe('reroot');
  });

  it('asks the server for matches, paged, rather than filtering the canvas', async () => {
    const calls = stubApi([node('service', 'class')], { total: 41 });

    const page = await searchNodes('p1', 'UserService', { limit: 15 });

    expect(calls[0]?.url).toBe(
      '/api/projects/p1/graph/search?q=UserService&limit=15&offset=0',
    );
    // The full count behind the page: a search that silently truncates is a
    // search that lies about what is in the graph.
    expect(page.total).toBe(41);
  });

  it('carries a node-type narrowing as CSV', async () => {
    const calls = stubApi([]);
    await searchNodes('p1', 'user', { nodeTypes: ['class', 'method'] });

    expect(calls[0]?.url).toContain('nodeTypes=class%2Cmethod');
  });
});

// --- definition and source navigation ---------------------------------------

describe('source navigation', () => {
  it('addresses a node by id, so the server resolves file and range', () => {
    expect(sourceTargetForNode({ id: 'getUser', filePath: 'src/services/user.service.ts' })).toEqual({
      nodeId: 'getUser',
      label: 'src/services/user.service.ts',
    });
  });

  it('still addresses a node with no indexed file', () => {
    expect(sourceTargetForNode({ id: 'table' })).toEqual({ nodeId: 'table' });
  });

  it('requests a symbol window by node id and context', async () => {
    const calls = stubApi({ file: 'src/services/user.service.ts', lines: [] });

    await fetchSource('p1', { nodeId: 'getUser', context: 4 });

    expect(calls[0]?.url).toBe('/api/projects/p1/source?nodeId=getUser&context=4');
  });

  it('requests an explicit line range when given one', async () => {
    const calls = stubApi({ lines: [] });

    await fetchSource('p1', { file: 'src/index.ts', startLine: 18, endLine: 25 });

    expect(calls[0]?.url).toBe(
      '/api/projects/p1/source?file=src%2Findex.ts&startLine=18&endLine=25',
    );
  });

  it('never sends an absolute path of its own making', async () => {
    const calls = stubApi({ lines: [] });
    await fetchSource('p1', { file: 'src/index.ts' });

    expect(calls[0]?.url.includes('%2Fsrc')).toBe(false);
  });

  it('surfaces a refused path as the API reported it', async () => {
    stubFailure(403, 'SOURCE_PATH_NOT_ALLOWED', 'That path is outside the project repository');

    await expect(fetchSource('p1', { file: '../../etc/passwd' })).rejects.toThrow(
      'That path is outside the project repository',
    );
  });

  it('fetches a definition for go-to-definition', async () => {
    const calls = stubApi({ nodeId: 'getUser', filePath: 'src/services/user.service.ts' });

    const definition = await fetchDefinition('p1', 'getUser');

    expect(calls[0]?.url).toBe('/api/projects/p1/graph/nodes/getUser/definition');
    expect(definition?.nodeId).toBe('getUser');
  });

  it('escapes a node id that is not URL-safe', async () => {
    const calls = stubApi(null);
    await fetchDefinition('p1', 'scip ts . . UserService#');

    expect(calls[0]?.url).toBe(
      '/api/projects/p1/graph/nodes/scip%20ts%20.%20.%20UserService%23/definition',
    );
  });
});

// --- highlighting -----------------------------------------------------------

describe('source highlighting', () => {
  const highlight = {
    nodeId: 'getUser',
    startLine: 18,
    startCharacter: 2,
    endLine: 25,
    endCharacter: 3,
  };

  it('lights every line of the symbol range, inclusive at both ends', () => {
    expect(isHighlighted(highlight, 17)).toBe(false);
    expect(isHighlighted(highlight, 18)).toBe(true);
    expect(isHighlighted(highlight, 22)).toBe(true);
    expect(isHighlighted(highlight, 25)).toBe(true);
    expect(isHighlighted(highlight, 26)).toBe(false);
  });

  it('lights nothing when the window is not about a symbol', () => {
    expect(isHighlighted(null, 18)).toBe(false);
  });
});

// --- the file tree ----------------------------------------------------------

describe('file tree', () => {
  it('names every folder that has to open to reveal a file', () => {
    expect(ancestorPaths('src/services/user.service.ts')).toEqual(['src', 'src/services']);
  });

  it('needs nothing open for a file at the root', () => {
    expect(ancestorPaths('package.json')).toEqual([]);
  });

  it('fetches one level at a time', async () => {
    const calls = stubApi({ path: 'src', parentPath: '', entries: [], truncated: false });

    await fetchTree('p1', 'src');
    expect(calls[0]?.url).toBe('/api/projects/p1/graph/tree?path=src');
  });

  it('asks for the root with no path at all', async () => {
    const calls = stubApi({ path: '', parentPath: null, entries: [], truncated: false });

    await fetchTree('p1', '');
    expect(calls[0]?.url).toBe('/api/projects/p1/graph/tree');
  });
});

// --- callers, callees, dependencies -----------------------------------------

describe('relationship navigation', () => {
  const sections = [
    'callers',
    'callees',
    'references',
    'dependencies',
    'dependents',
    'parents',
    'children',
    'implementations',
  ] as const;

  for (const section of sections) {
    it(`fetches ${section} from its own route`, async () => {
      const calls = stubApi([]);
      await fetchNodeSection('p1', 'service', section, { limit: 50 });

      expect(calls[0]?.url).toBe(`/api/projects/p1/graph/nodes/service/${section}?limit=50`);
    });
  }

  it('leaves the limit to the server when none is given', async () => {
    const calls = stubApi([]);
    await fetchNodeSection('p1', 'service', 'callers');

    expect(calls[0]?.url).toBe('/api/projects/p1/graph/nodes/service/callers');
  });

  it('reports a node that has gone as the API reported it', async () => {
    stubFailure(404, 'NODE_NOT_FOUND', 'Graph node gone was not found');

    await expect(fetchNodeSection('p1', 'gone', 'callers')).rejects.toThrow(
      'Graph node gone was not found',
    );
  });
});

// --- path rendering ---------------------------------------------------------

describe('path rendering', () => {
  const PATH: GraphPath = {
    found: true,
    from: 'api',
    to: 'table',
    depth: 3,
    undirected: false,
    truncated: false,
    nodes: [
      node('api', 'api'),
      node('controller', 'class'),
      node('repository', 'class'),
      node('table', 'table'),
    ],
    edges: [
      edge('e1', 'api', 'controller', 'ROUTES_TO'),
      edge('e2', 'controller', 'repository', 'CALLS'),
      edge('e3', 'repository', 'table', 'WRITES_TO'),
    ],
    steps: [
      {
        edgeId: 'e1',
        sourceNodeId: 'api',
        targetNodeId: 'controller',
        relationship: 'ROUTES_TO',
        reversed: false,
        confidence: 'high',
        evidenceSource: 'api-analyzer',
      },
      {
        edgeId: 'e2',
        sourceNodeId: 'controller',
        targetNodeId: 'repository',
        relationship: 'CALLS',
        reversed: false,
        confidence: 'high',
        evidenceSource: 'scip',
      },
      {
        edgeId: 'e3',
        sourceNodeId: 'repository',
        targetNodeId: 'table',
        relationship: 'WRITES_TO',
        reversed: false,
        confidence: 'medium',
        evidenceSource: 'database-analyzer',
      },
    ],
    relationships: ['ROUTES_TO', 'CALLS', 'WRITES_TO'],
  };

  it('pairs each node with the hop that leaves it', () => {
    const rows = pathRows(PATH);

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.node.id)).toEqual(['api', 'controller', 'repository', 'table']);
    expect(rows.map((row) => row.step?.relationship ?? null)).toEqual([
      'ROUTES_TO',
      'CALLS',
      'WRITES_TO',
      null,
    ]);
  });

  it('keeps the evidence on every hop', () => {
    const rows = pathRows(PATH);
    expect(rows[2]?.step).toMatchObject({
      evidenceSource: 'database-analyzer',
      confidence: 'medium',
    });
  });

  it('renders nothing for a route that was not found', () => {
    expect(pathRows({ ...PATH, found: false, nodes: [], steps: [] })).toEqual([]);
    expect(pathRows(null)).toEqual([]);
  });

  it('summarises a route without repeating a relationship', () => {
    expect(pathSummary(PATH)).toBe('3 hops · ROUTES_TO → CALLS → WRITES_TO');
  });

  it('counts a single hop in the singular', () => {
    expect(pathSummary({ ...PATH, depth: 1, relationships: ['CALLS'] })).toBe('1 hop · CALLS');
  });

  it('asks the server for the route rather than searching the canvas', async () => {
    const calls = stubApi(PATH);

    await findPath('p1', { from: 'api', to: 'table' });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/projects/p1/graph/path');
    expect(calls[0]?.body).toEqual({ from: 'api', to: 'table' });
  });

  it('passes a depth bound through when one is set', async () => {
    const calls = stubApi(PATH);
    await findPath('p1', { from: 'api', to: 'table', maxDepth: 4, direction: 'both' });

    expect(calls[0]?.body).toEqual({
      from: 'api',
      to: 'table',
      maxDepth: 4,
      direction: 'both',
    });
  });
});
