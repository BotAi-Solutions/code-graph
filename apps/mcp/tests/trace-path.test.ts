import { afterEach, describe, expect, it } from 'vitest';
import {
  apiFailure,
  codeNode,
  createMcpHarness,
  graphPath,
  noPath,
  ok,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * Tracing a route between two nodes.
 *
 * The distinction this suite guards hardest is between the three things that
 * are not the same answer: there is no route, there might be a route but the
 * search could not finish, and one of the endpoints does not exist. The first
 * two are successful answers and the third is an error, and an agent that
 * confused them would report an absence the graph never claimed.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const trace = async (
  args: { projectId?: string; fromNodeId?: string; toNodeId?: string; maxDepth?: number } = {},
) =>
  harness.client.callTool({
    name: 'trace_path',
    arguments: { projectId: PROJECT_ID, fromNodeId: 'a', toNodeId: 'c', ...args },
  });

describe('registration', () => {
  it('requires a project and both endpoints', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'trace_path');

    expect((tool.inputSchema as { required: string[] }).required.sort()).toEqual([
      'fromNodeId',
      'projectId',
      'toNodeId',
    ]);
  });

  it('bounds maxDepth to the API’s own range', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'trace_path');

    expect(
      (tool.inputSchema as { properties: { maxDepth: unknown } }).properties.maxDepth,
    ).toMatchObject({ type: 'integer', minimum: 1, maximum: 12 });
  });
});

describe('the request', () => {
  it('posts to the canonical route with the project in the path and both ids in the body', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath()) }));

    await trace();

    expect(harness.requests).toEqual([
      {
        path: `/api/projects/${PROJECT_ID}/graph/path`,
        query: {},
        method: 'POST',
        // The API's own field names, not the tool's.
        body: { from: 'a', to: 'c' },
      },
    ]);
  });

  it('passes maxDepth through only when given', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath()) }));

    await trace({ maxDepth: 3 });

    expect(harness.requests[0]?.body).toEqual({ from: 'a', to: 'c', maxDepth: 3 });
  });
});

describe('a route that exists', () => {
  it('returns the nodes in order, the steps in order, and the length', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath()) }));

    const result = await trace();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      projectId: PROJECT_ID,
      from: 'a',
      to: 'c',
      found: true,
      depth: 2,
      undirected: false,
      truncated: false,
      relationships: ['CALLS'],
    });

    const output = result.structuredContent as {
      nodes: { id: string; name: string }[];
      steps: { sourceNodeId: string; targetNodeId: string }[];
    };
    expect(output.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
    expect(output.nodes.map((node) => node.name)).toEqual([
      'AuthController',
      'AuthService',
      'UserRepository',
    ]);
    // steps[i] leaves nodes[i]: the pairing the canonical API defines.
    expect(output.steps.map((step) => [step.sourceNodeId, step.targetNodeId])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });

  it('renders the route, its length and each hop', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath()) }));

    const text = textOf(await trace());

    expect(text).toMatch(/Path found: AuthController → AuthService → UserRepository/);
    expect(text).toMatch(/Length: 2 edges/);
    expect(text).toMatch(/1\. AuthController/);
    expect(text).toMatch(/src\/auth\.controller\.ts:42/);
    expect(text).toMatch(/↓ CALLS/);
    expect(text).toMatch(/3\. UserRepository/);
  });

  it('returns a one-edge path for a direct relationship', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          to: 'b',
          depth: 1,
          nodes: [
            codeNode({ id: 'a', name: 'AuthController' }),
            codeNode({ id: 'b', name: 'AuthService' }),
          ],
          edges: [graphPath().edges[0]!],
          steps: [graphPath().steps[0]!],
        }),
      ),
    }));

    const result = await trace({ toNodeId: 'b' });

    expect(result.structuredContent).toMatchObject({ found: true, depth: 1 });
    expect((result.structuredContent as { steps: unknown[] }).steps).toHaveLength(1);
    expect(textOf(result)).toMatch(/Length: 1 edge(?!s)/);
  });

  it('reports an undirected route as one, rather than as a normal path', async () => {
    // Two nodes can be genuinely related without one reaching the other, and
    // the API says so instead of reporting nothing.
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          undirected: true,
          steps: graphPath().steps.map((step) => ({ ...step, reversed: true })),
        }),
      ),
    }));

    const result = await trace();

    expect(result.structuredContent).toMatchObject({ undirected: true });
    expect(textOf(result)).toMatch(/No directed route exists/);
    expect(textOf(result)).toMatch(/against direction/);
  });

  it('preserves the canonical zero-edge answer for a node and itself', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          from: 'a',
          to: 'a',
          depth: 0,
          nodes: [codeNode({ id: 'a', name: 'AuthController' })],
          edges: [],
          steps: [],
          relationships: [],
        }),
      ),
    }));

    const result = await trace({ toNodeId: 'a' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ found: true, depth: 0, steps: [] });
    expect(textOf(result)).toMatch(/are the same node/);
  });
});

describe('evidence', () => {
  it('preserves the whole evidence record on every hop', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath()) }));

    const result = await trace();
    const [first] = (result.structuredContent as { steps: { evidence: unknown }[] }).steps;

    expect(first?.evidence).toMatchObject({
      source: 'scip',
      confidence: 'high',
      file: 'src/auth.controller.ts',
      line: 42,
      method: null,
      column: null,
      matched: null,
    });
  });

  it('shows the evidence beside each hop, so the route is checkable', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath()) }));

    const text = textOf(await trace());

    expect(text).toMatch(/↓ CALLS — scip\/high, src\/auth\.controller\.ts:42/);
    expect(text).toMatch(/↓ CALLS — scip\/high, src\/auth\.service\.ts:81/);
  });

  it('renders a line without a file as a line, not as "no location"', async () => {
    // The same case that was wrong in get_node; both now read it from one place.
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          steps: [
            {
              ...graphPath().steps[0]!,
              evidence: { source: 'database-analyzer', confidence: 'medium', line: 38 },
            },
            graphPath().steps[1]!,
          ],
        }),
      ),
    }));

    const text = textOf(await trace());

    expect(text).toMatch(/database-analyzer\/medium, line 38/);
    expect(text).not.toMatch(/no location recorded/);
  });

  it('says so when a hop carries no evidence rather than fabricating one', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          steps: [
            { ...graphPath().steps[0]!, evidence: null },
            graphPath().steps[1]!,
          ],
        }),
      ),
    }));

    const result = await trace();

    expect(result.structuredContent).toMatchObject({ steps: [{ evidence: null }, {}] });
    expect(textOf(result)).toMatch(/no evidence recorded/);
  });
});

describe('when there is no route', () => {
  it('is a successful answer, not an error', async () => {
    harness = await createMcpHarness(() => ({ body: ok(noPath()) }));

    const result = await trace();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: false,
      depth: 0,
      nodes: [],
      steps: [],
      truncated: false,
    });
    expect(textOf(result)).toMatch(/No path exists from "a" to "c" in this project/);
    expect(textOf(result)).toMatch(/Both nodes exist/);
  });

  it('says what hop limit the no-path answer is a statement about', async () => {
    // Reporting the default when a narrower bound was asked for would make a
    // "no path within 1 hop" read as "no path within 6".
    harness = await createMcpHarness(() => ({ body: ok(noPath()) }));

    const wide = await trace();
    expect(wide.structuredContent).toMatchObject({ maxDepth: 6 });
    expect(textOf(wide)).toMatch(/within 6 hops/);

    const narrow = await trace({ maxDepth: 1 });
    expect(narrow.structuredContent).toMatchObject({ maxDepth: 1 });
    expect(textOf(narrow)).toMatch(/within 1 hop(?!s)/);
  });

  it('does not claim there is no route when the search ran out of budget', async () => {
    // `found: false` with `truncated: true` is "could not tell", which is a
    // different statement from "they are not connected".
    harness = await createMcpHarness(() => ({ body: ok(noPath({ truncated: true })) }));

    const result = await trace();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ found: false, truncated: true });
    expect(textOf(result)).toMatch(/Could not determine whether a path exists/);
    expect(textOf(result)).toMatch(/does not mean no route exists/);
    expect(textOf(result)).not.toMatch(/^No path exists/m);
  });
});

describe('project isolation', () => {
  it('traces only within the project it was given', async () => {
    harness = await createMcpHarness(() => ({ body: ok(noPath()) }));

    await trace({ projectId: OTHER_PROJECT_ID });

    expect(harness.requests[0]?.path).toBe(`/api/projects/${OTHER_PROJECT_ID}/graph/path`);
    expect(harness.requests[0]?.path).not.toContain(PROJECT_ID);
  });

  it('cannot reach a node in another project from either direction', async () => {
    // Node ids are project-specific: the API resolves both endpoints inside the
    // project before searching, so one from elsewhere is simply not found.
    harness = await createMcpHarness((request) =>
      request.path.startsWith(`/api/projects/${PROJECT_ID}/`)
        ? { status: 404, body: apiFailure('NODE_NOT_FOUND', 'Graph node b-node was not found') }
        : { body: ok(graphPath()) },
    );

    const forward = await trace({ toNodeId: 'b-node' });
    expect(forward.isError).toBe(true);
    expect(textOf(forward)).not.toContain(OTHER_PROJECT_ID);

    const backward = await trace({ fromNodeId: 'b-node' });
    expect(backward.isError).toBe(true);
    expect(textOf(backward)).not.toContain(OTHER_PROJECT_ID);
  });

  it('carries no project state between calls', async () => {
    harness = await createMcpHarness(() => ({ body: ok(noPath()) }));

    await trace({ projectId: PROJECT_ID });
    await trace({ projectId: OTHER_PROJECT_ID });

    expect(harness.requests.map((request) => request.path)).toEqual([
      `/api/projects/${PROJECT_ID}/graph/path`,
      `/api/projects/${OTHER_PROJECT_ID}/graph/path`,
    ]);
  });

  it('refuses the whole route when a node belongs to another project', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          nodes: [
            codeNode({ id: 'a' }),
            codeNode({ id: 'b', projectId: OTHER_PROJECT_ID }),
            codeNode({ id: 'c' }),
          ],
        }),
      ),
    }));

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Refusing to return this path/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('refuses when an edge belongs to another project', async () => {
    // Edges are checked although they are not reported: they are part of the
    // answer's provenance, and a foreign one means the same broken scoping.
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          edges: [
            { ...graphPath().edges[0]!, projectId: OTHER_PROJECT_ID },
            graphPath().edges[1]!,
          ],
        }),
      ),
    }));

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Refusing to return this path/);
  });
});

describe('answering the question that was asked', () => {
  it('refuses a route whose endpoints are not the ones requested', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath({ from: 'x', to: 'y' })) }));

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/a path for a different question/);
  });

  it('refuses a route that does not start and end where it says', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        graphPath({
          nodes: [codeNode({ id: 'b' }), codeNode({ id: 'c' })],
        }),
      ),
    }));

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/which is not the "a" to "c" that was asked for/);
  });

  it('refuses a route reported as found but carrying no nodes', async () => {
    harness = await createMcpHarness(() => ({ body: ok(graphPath({ nodes: [] })) }));

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/reported as found but carries no nodes/);
  });
});

describe('when the trace fails', () => {
  it('reports a missing endpoint without looking anywhere else', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('NODE_NOT_FOUND', 'Graph node zzz was not found'),
    }));

    const result = await trace({ fromNodeId: 'zzz' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Graph node zzz was not found/);
    expect(textOf(result)).toMatch(/search_graph/);
    // One request: no fallback, no retry against another project.
    expect(harness.requests).toHaveLength(1);
  });

  it('directs the agent to resolve_project for an unknown project', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('PROJECT_NOT_FOUND', `Project ${PROJECT_ID} was not found`),
    }));

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/There is no project with id/);
    expect(textOf(result)).toMatch(/Call resolve_project/);
  });

  it('passes another refusal through with the API’s code and nothing internal', async () => {
    harness = await createMcpHarness(() => ({
      status: 500,
      body: apiFailure('DATABASE_ERROR', 'the database rejected an operation'),
    }));

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DATABASE_ERROR');
    expect(textOf(result)).not.toMatch(/at .+:\d+:\d+|postgres(ql)?:\/\/|SELECT /i);
  });

  it('says where the API was expected when it is not running', async () => {
    harness = await createMcpHarness();
    await harness.stopApi();

    const result = await trace();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
  });
});

describe('invalid input', () => {
  it('rejects a project id that is not a uuid', async () => {
    harness = await createMcpHarness();

    const result = await trace({ projectId: 'not-a-uuid' });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects an empty source node id', async () => {
    harness = await createMcpHarness();

    expect((await trace({ fromNodeId: '   ' })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects an empty destination node id', async () => {
    harness = await createMcpHarness();

    expect((await trace({ toNodeId: '' })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects a maxDepth beyond the API’s ceiling', async () => {
    harness = await createMcpHarness();

    expect((await trace({ maxDepth: 99 })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });
});
