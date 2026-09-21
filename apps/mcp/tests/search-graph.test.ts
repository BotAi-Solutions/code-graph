import { afterEach, describe, expect, it } from 'vitest';
import {
  apiFailure,
  codeNode,
  createMcpHarness,
  okPaged,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * Searching one project's graph.
 *
 * The property most of this suite exists for is the project boundary: the tool
 * takes a project id and must be incapable of answering about anything else.
 * That is checked from both directions — that the request is addressed to the
 * project it was given, and that a result belonging to another project is
 * refused rather than reported.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const search = async (args: { projectId?: string; query: string; limit?: number }) =>
  harness.client.callTool({
    name: 'search_graph',
    arguments: { projectId: PROJECT_ID, ...args },
  });

describe('registration', () => {
  it('requires a project id and a query', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'search_graph');

    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { projectId: { type: 'string' }, query: { type: 'string' } },
    });
    expect((tool.inputSchema as { required: string[] }).required.sort()).toEqual([
      'projectId',
      'query',
    ]);
  });

  it('bounds limit below the API’s own ceiling', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'search_graph');

    // The API allows 100; these results go into a model's context, so the tool
    // allows less.
    expect((tool.inputSchema as { properties: { limit: unknown } }).properties.limit).toMatchObject(
      { type: 'integer', minimum: 1, maximum: 50 },
    );
  });

  it('tells a model the matching is literal, not semantic', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'search_graph');

    expect(tool.description).toMatch(/not semantic/i);
  });
});

describe('search_graph', () => {
  it('addresses the request to the canonical route, scoped by project id in the path', async () => {
    harness = await createMcpHarness(() => ({ body: okPaged([codeNode()], { total: 1 }) }));

    await search({ query: 'AuthService' });

    expect(harness.requests).toEqual([
      {
        path: `/api/projects/${PROJECT_ID}/graph/search`,
        query: { q: 'AuthService', limit: '20' },
      },
    ]);
  });

  it('returns the matching nodes', async () => {
    harness = await createMcpHarness(() => ({
      body: okPaged(
        [
          codeNode(),
          codeNode({
            id: 'node-2',
            name: 'AuthController',
            qualifiedName: 'AuthController',
            filePath: 'src/modules/auth/controllers/auth.controller.ts',
            startLine: 9,
          }),
        ],
        { total: 2 },
      ),
    }));

    const result = await search({ query: 'Auth' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      projectId: PROJECT_ID,
      query: 'Auth',
      total: 2,
      returned: 2,
      truncated: false,
    });
    const { results } = result.structuredContent as { results: { name: string }[] };
    expect(results.map((node) => node.name)).toEqual(['AuthService', 'AuthController']);

    const text = textOf(result);
    expect(text).toContain('AuthService');
    expect(text).toContain('src/modules/auth/services/auth.service.ts:12');
  });

  it('reports a node with no file rather than pretending it has one', async () => {
    harness = await createMcpHarness(() => ({
      body: okPaged(
        [
          codeNode({
            id: 'table-1',
            type: 'table',
            name: 'users',
            qualifiedName: 'postgresql.users',
            filePath: undefined,
            startLine: undefined,
            endLine: undefined,
          }),
        ],
        { total: 1 },
      ),
    }));

    const result = await search({ query: 'users' });

    expect(result.structuredContent).toMatchObject({
      results: [{ filePath: null, startLine: null, qualifiedName: 'postgresql.users' }],
    });
    expect(textOf(result)).toMatch(/no file/);
  });
});

describe('project isolation', () => {
  it('searches only the project it was given, never all projects', async () => {
    harness = await createMcpHarness(() => ({ body: okPaged([], { total: 0 }) }));

    await search({ projectId: OTHER_PROJECT_ID, query: 'AuthService' });

    const [request] = harness.requests;
    // The id is in the path, and nothing in the query string widens the scope.
    expect(request?.path).toBe(`/api/projects/${OTHER_PROJECT_ID}/graph/search`);
    expect(request?.path).not.toContain(PROJECT_ID);
    expect(Object.keys(request?.query ?? {}).sort()).toEqual(['limit', 'q']);
  });

  it('returns only project A’s nodes when both projects hold the same name', async () => {
    // Both projects have an AuthService. The stub answers each request from the
    // project named in its own path, the way the API's project-scoped SQL does.
    const byProject: Record<string, ReturnType<typeof codeNode>[]> = {
      [PROJECT_ID]: [codeNode({ id: 'a-auth', filePath: 'a/src/auth.service.ts' })],
      [OTHER_PROJECT_ID]: [
        codeNode({ id: 'b-auth', projectId: OTHER_PROJECT_ID, filePath: 'b/src/auth.service.ts' }),
      ],
    };

    harness = await createMcpHarness((request) => {
      const id = request.path.split('/')[3] ?? '';
      const nodes = byProject[id] ?? [];
      return { body: okPaged(nodes, { total: nodes.length }) };
    });

    const inA = await search({ projectId: PROJECT_ID, query: 'AuthService' });
    const inB = await search({ projectId: OTHER_PROJECT_ID, query: 'AuthService' });

    expect((inA.structuredContent as { results: { id: string }[] }).results.map((n) => n.id)).toEqual([
      'a-auth',
    ]);
    expect((inB.structuredContent as { results: { id: string }[] }).results.map((n) => n.id)).toEqual([
      'b-auth',
    ]);
    expect(textOf(inA)).not.toContain('b/src');
    expect(textOf(inB)).not.toContain('a/src');
  });

  it('refuses the whole answer if a node from another project comes back', async () => {
    // Cannot happen while the API scopes its SQL — which is the point. If it
    // ever did, reporting the results would attribute another project's code to
    // this one, so the tool refuses instead of filtering and carrying on.
    harness = await createMcpHarness(() => ({
      body: okPaged(
        [codeNode(), codeNode({ id: 'leaked', projectId: OTHER_PROJECT_ID })],
        { total: 2 },
      ),
    }));

    const result = await search({ query: 'Auth' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Refusing to return these results/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('carries no project state between calls', async () => {
    harness = await createMcpHarness(() => ({ body: okPaged([], { total: 0 }) }));

    await search({ projectId: PROJECT_ID, query: 'x' });
    await search({ projectId: OTHER_PROJECT_ID, query: 'x' });
    await search({ projectId: PROJECT_ID, query: 'x' });

    expect(harness.requests.map((request) => request.path)).toEqual([
      `/api/projects/${PROJECT_ID}/graph/search`,
      `/api/projects/${OTHER_PROJECT_ID}/graph/search`,
      `/api/projects/${PROJECT_ID}/graph/search`,
    ]);
  });
});

describe('bounding the result set', () => {
  it('passes the API’s own default when no limit is given', async () => {
    harness = await createMcpHarness(() => ({ body: okPaged([], { total: 0 }) }));

    await search({ query: 'anything' });

    expect(harness.requests[0]?.query.limit).toBe('20');
  });

  it('passes a requested limit through', async () => {
    harness = await createMcpHarness(() => ({ body: okPaged([], { total: 0 }) }));

    await search({ query: 'anything', limit: 5 });

    expect(harness.requests[0]?.query.limit).toBe('5');
  });

  it('says how much it did not return', async () => {
    harness = await createMcpHarness(() => ({
      // A page of two out of forty: `meta.total` is the full count.
      body: okPaged([codeNode(), codeNode({ id: 'node-2' })], { total: 40 }),
    }));

    const result = await search({ query: 'a', limit: 2 });

    expect(result.structuredContent).toMatchObject({
      total: 40,
      returned: 2,
      truncated: true,
    });
    expect(textOf(result)).toMatch(/^2 of 40 nodes matching/);
    expect(textOf(result)).toMatch(/38 more match/);
  });

  it('rejects a limit above its ceiling before calling the API', async () => {
    harness = await createMcpHarness();

    const result = await search({ query: 'a', limit: 5000 });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects a limit below one', async () => {
    harness = await createMcpHarness();

    const result = await search({ query: 'a', limit: 0 });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects an empty query before calling the API', async () => {
    harness = await createMcpHarness();

    const result = await search({ query: '   ' });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });
});

describe('empty results', () => {
  it('is a successful answer, not an error', async () => {
    harness = await createMcpHarness(() => ({ body: okPaged([], { total: 0 }) }));

    const result = await search({ query: 'nothing-matches-this' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      query: 'nothing-matches-this',
      total: 0,
      returned: 0,
      truncated: false,
      results: [],
    });
    expect(textOf(result)).toMatch(/No graph nodes matched "nothing-matches-this"/);
  });

  it('says what an empty result does and does not mean', async () => {
    harness = await createMcpHarness(() => ({ body: okPaged([], { total: 0 }) }));

    const result = await search({ query: 'authentication' });

    // Literal matching makes "no match" cheap to misread as "no such code".
    expect(textOf(result)).toMatch(/literal substring/);
    expect(textOf(result)).toMatch(/get_index_status/);
  });
});

describe('when the API is unhappy', () => {
  it('directs the agent to resolve_project for an unknown project', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('PROJECT_NOT_FOUND', `Project ${PROJECT_ID} was not found`),
    }));

    const result = await search({ query: 'Auth' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/There is no project with id/);
    expect(textOf(result)).toMatch(/Call resolve_project/);
  });

  it('passes another refusal through with the API’s code and nothing internal', async () => {
    harness = await createMcpHarness(() => ({
      status: 500,
      body: apiFailure('DATABASE_ERROR', 'the database rejected an operation'),
    }));

    const result = await search({ query: 'Auth' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DATABASE_ERROR');
    // No stack, no SQL, no connection string.
    expect(textOf(result)).not.toMatch(/at .+:\d+:\d+|postgres(ql)?:\/\/|SELECT /i);
  });

  it('says where the API was expected when it is not running', async () => {
    harness = await createMcpHarness();
    await harness.stopApi();

    const result = await search({ query: 'Auth' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
  });

  it('rejects a project id that is not a uuid without troubling the API', async () => {
    harness = await createMcpHarness();

    const result = await search({ projectId: 'not-a-uuid', query: 'Auth' });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });
});
