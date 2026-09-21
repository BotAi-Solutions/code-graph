import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  AnalysisJob,
  ApiResponse,
  CodeEdge,
  CodeSearchMatch,
  CodeNode,
  GraphPath,
  NodeDetail,
  ProjectResolution,
  ProjectSummary,
  RelatedNode,
  SourceWindow,
} from '@ckg/shared';
import { createMcpServer } from '../../src/server.js';

/**
 * A real MCP client talking to the real server over a linked pair of in-memory
 * transports, with a real HTTP server standing in for the API.
 *
 * Both halves are genuine rather than mocked, which is the point: the things
 * most likely to break here are the two boundaries — whether the tool's schema
 * survives the protocol, and whether a path with a `#` in it survives the query
 * string — and a stubbed `fetch` or a hand-rolled transport would test neither.
 */

export interface StubbedRequest {
  path: string;
  query: Record<string, string>;
  /** Present only for a non-GET request, so GET assertions stay a two-field comparison. */
  method?: string;
  body?: unknown;
}

export interface McpHarness {
  client: Client;
  /** Every request the API stub received, in order. */
  requests: StubbedRequest[];
  /** Replaces what the API answers with next. */
  reply(handler: ApiStubHandler): void;
  /** Stops the stub API while leaving the MCP session up: what an agent meets when the API is not running. */
  stopApi(): Promise<void>;
  close(): Promise<void>;
}

export type ApiStubHandler = (request: StubbedRequest) => {
  status?: number;
  body: ApiResponse<unknown> | string;
};

/** The dashboard row shape, with only the fields the tool reads spelled out. */
export function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: '892f0987-c76c-44df-8646-3c0abf3cfbc4',
    name: 'sample',
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    repository: { sourceType: 'local', sourcePath: '/srv/app', commitHash: null },
    latestAnalysis: {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'COMPLETED',
      language: 'typescript',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      error: null,
      progress: null,
    },
    nodeCount: 79,
    edgeCount: 247,
    nodeTypeCounts: { class: 6, method: 31 },
    ...overrides,
  };
}

export function resolution(overrides: Partial<ProjectResolution> = {}): ProjectResolution {
  return {
    path: '/srv/app/src/services',
    matches: [
      {
        project: projectSummary(),
        repositoryRoot: '/srv/app',
        relativePath: 'src/services',
        exact: false,
      },
    ],
    ...overrides,
  };
}

/** One analysis run, with only the fields a test cares about spelled out. */
export function analysisJob(overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: PROJECT_ID,
    repositoryId: '99999999-9999-4999-8999-999999999999',
    status: 'COMPLETED',
    language: 'typescript',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    error: null,
    stats: {
      documentCount: 6,
      symbolCount: 120,
      nodeCount: 79,
      edgeCount: 247,
      durationMs: 6000,
    },
    progress: null,
    errors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

export const PROJECT_ID = '892f0987-c76c-44df-8646-3c0abf3cfbc4';

/** A second indexed project, for the tests that prove one cannot see the other. */
export const OTHER_PROJECT_ID = '7c1f2b34-5d6e-4f80-9a1b-2c3d4e5f6071';

/**
 * One graph node as the graph routes return it.
 *
 * `qualifiedName` follows `name` unless a test sets it, so overriding the name
 * does not leave a node calling itself something else — the renderers prefer
 * the qualified name, and a fixture that disagreed with itself would make them
 * look wrong.
 */
export function codeNode(overrides: Partial<CodeNode> = {}): CodeNode {
  return {
    id: 'node-1',
    projectId: PROJECT_ID,
    type: 'class',
    name: 'AuthService',
    filePath: 'src/modules/auth/services/auth.service.ts',
    startLine: 12,
    endLine: 88,
    qualifiedName: overrides.name ?? 'AuthService',
    ...overrides,
  };
}

/** One neighbour carrying its relationship and the evidence behind it. */
export function relatedNode(overrides: Partial<RelatedNode> = {}): RelatedNode {
  return {
    ...codeNode({ id: 'related-1', type: 'table', name: 'users', qualifiedName: 'postgresql.users' }),
    relationship: 'WRITES_TO',
    direction: 'outgoing',
    confidence: 'high',
    evidenceSource: 'database-analyzer',
    evidence: {
      source: 'database-analyzer',
      confidence: 'high',
      method: 'ast',
      file: 'src/repositories/user.repository.ts',
      line: 42,
      column: 4,
      matched: 'users',
    },
    ...overrides,
  };
}

/**
 * A node-detail response with every section present and empty, so a test names
 * only the sections it is about.
 */
export function nodeDetail(overrides: Partial<NodeDetail> = {}): NodeDetail {
  const node = overrides.node ?? codeNode();

  return {
    node,
    symbol: {
      name: node.name,
      qualifiedName: node.qualifiedName ?? null,
      type: node.type,
      language: 'typescript',
      filePath: node.filePath ?? null,
      startLine: node.startLine ?? null,
      startCharacter: null,
      endLine: node.endLine ?? null,
      endCharacter: null,
      exported: true,
      visibility: null,
      module: null,
      framework: null,
      apiRoute: null,
      databaseResource: null,
      externalService: null,
      messagingResource: null,
      scipSymbol: null,
      role: 'service',
      category: 'code',
      family: 'code',
      fileCategory: null,
    },
    definition: null,
    callers: [],
    callees: [],
    references: [],
    dependencies: [],
    dependents: [],
    apis: [],
    databases: [],
    documentation: [],
    contracts: [],
    implementations: [],
    parent: null,
    children: [],
    ...overrides,
  };
}

/** A found route, as the path endpoint returns it. */
export function graphPath(overrides: Partial<GraphPath> = {}): GraphPath {
  const controller = codeNode({ id: 'a', name: 'AuthController', filePath: 'src/auth.controller.ts', startLine: 42 });
  const service = codeNode({ id: 'b', name: 'AuthService', filePath: 'src/auth.service.ts', startLine: 81 });
  const repository = codeNode({ id: 'c', name: 'UserRepository', filePath: 'src/user.repository.ts', startLine: 18 });

  const edge = (id: string, source: string, target: string): CodeEdge => ({
    id,
    projectId: PROJECT_ID,
    sourceNodeId: source,
    targetNodeId: target,
    relationship: 'CALLS',
  });

  return {
    found: true,
    from: 'a',
    to: 'c',
    depth: 2,
    undirected: false,
    truncated: false,
    nodes: [controller, service, repository],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    steps: [
      {
        edgeId: 'e1',
        sourceNodeId: 'a',
        targetNodeId: 'b',
        relationship: 'CALLS',
        reversed: false,
        confidence: 'high',
        evidenceSource: 'scip',
        evidence: { source: 'scip', confidence: 'high', file: 'src/auth.controller.ts', line: 42 },
      },
      {
        edgeId: 'e2',
        sourceNodeId: 'b',
        targetNodeId: 'c',
        relationship: 'CALLS',
        reversed: false,
        confidence: 'high',
        evidenceSource: 'scip',
        evidence: { source: 'scip', confidence: 'high', file: 'src/auth.service.ts', line: 81 },
      },
    ],
    relationships: ['CALLS'],
    ...overrides,
  };
}

/** No route, which the path endpoint reports as a successful answer. */
export function noPath(overrides: Partial<GraphPath> = {}): GraphPath {
  return graphPath({
    found: false,
    depth: 0,
    nodes: [],
    edges: [],
    steps: [],
    relationships: [],
    ...overrides,
  });
}

/** A window of source, as the `/source` route returns it. */
export function sourceWindow(overrides: Partial<SourceWindow> = {}): SourceWindow {
  const lines = overrides.lines ?? [
    { line: 38, text: 'export class UserRepository {' },
    { line: 39, text: '  constructor(private readonly pool: Pool) {}' },
    { line: 40, text: '}' },
  ];

  return {
    file: 'src/repositories/user.repository.ts',
    language: 'typescript',
    totalLines: 120,
    truncated: false,
    // Always null in the file-based flow: only a nodeId supplies a highlight.
    highlight: null,
    ...overrides,
    startLine: overrides.startLine ?? lines[0]?.line ?? 1,
    endLine: overrides.endLine ?? lines[lines.length - 1]?.line ?? 1,
    lines,
  };
}

/** One source occurrence, as the code-search route returns it. */
export function codeMatch(overrides: Partial<CodeSearchMatch> = {}): CodeSearchMatch {
  return {
    filePath: 'src/app.ts',
    line: 8,
    column: 9,
    match: 'UserRepository',
    lineText: "import { UserRepository } from './repositories/user.repository';",
    lineTruncated: false,
    ...overrides,
  };
}

/**
 * A code-search response, with the meta block the route actually sends.
 *
 * Built from the request so that `meta.query` echoes what was asked for, the
 * way the real route does. A fixture that pinned the query would make every
 * test searching for something else look like a post-condition violation.
 */
export function codeSearchBody(
  request: StubbedRequest,
  matches: CodeSearchMatch[],
  overrides: Record<string, unknown> = {},
): ApiResponse<CodeSearchMatch[]> {
  return okPaged(matches, {
    total: matches.length,
    limit: 20,
    truncated: false,
    query: request.query.q ?? '',
    filesSearched: 19,
    filesSkipped: 0,
    scanTruncated: false,
    ...overrides,
  });
}

/** An envelope with paging meta, as the search route sends it. */
export function okPaged<TData>(data: TData, meta: Record<string, unknown>): ApiResponse<TData> {
  return { success: true, data, error: null, meta };
}


export function ok<TData>(data: TData): ApiResponse<TData> {
  return { success: true, data, error: null, meta: {} };
}

export function apiFailure(code: string, message: string): ApiResponse<never> {
  return {
    success: false,
    data: null,
    // The envelope's `code` is typed as the API's own union; a test naming an
    // arbitrary one is exercising the client's pass-through, not the union.
    error: { code: code as never, message },
    meta: {},
  };
}

/**
 * Starts the stub API, builds the MCP server against it and connects a client.
 *
 * `baseUrl` is passed explicitly so the suite never depends on the developer's
 * `.env`; the config loader's own defaulting is tested separately.
 */
export async function createMcpHarness(
  initial: ApiStubHandler = () => ({ body: ok(resolution()) }),
): Promise<McpHarness> {
  const requests: StubbedRequest[] = [];
  let handler = initial;

  const http: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (raw += chunk));
    request.on('end', () => {
      const received: StubbedRequest = {
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        ...(request.method === undefined || request.method === 'GET'
          ? {}
          : { method: request.method, body: raw === '' ? null : (JSON.parse(raw) as unknown) }),
      };
      requests.push(received);

      const result = handler(received);
      const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
      response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
      response.end(body);
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  const server = createMcpServer({
    runtime: { NODE_ENV: 'test', LOG_LEVEL: 'error' },
    mcp: {
      MCP_API_BASE_URL: `http://127.0.0.1:${String(port)}`,
      MCP_REQUEST_TIMEOUT_MS: 2000,
      apiBaseUrl: `http://127.0.0.1:${String(port)}`,
    },
  });

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  let apiStopped = false;
  const stopApi = async (): Promise<void> => {
    if (apiStopped) return;
    apiStopped = true;
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  };

  return {
    client,
    requests,
    reply(next: ApiStubHandler) {
      handler = next;
    },
    stopApi,
    async close() {
      await client.close();
      await server.close();
      await stopApi();
    },
  };
}

/** One tool from the listing, by name, so a suite is not coupled to the list's order. */
export async function toolNamed(
  harness: McpHarness,
  name: string,
): Promise<{ name: string; description?: string; inputSchema: unknown; annotations?: unknown }> {
  const { tools } = await harness.client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool named ${name}; got ${tools.map((t) => t.name).join(', ')}`);
  return tool;
}

/** The text block a tool result carries, which is what a model actually reads. */
export function textOf(result: { content: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}
