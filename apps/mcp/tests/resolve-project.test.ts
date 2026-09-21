import { afterEach, describe, expect, it } from 'vitest';
import {
  apiFailure,
  createMcpHarness,
  ok,
  projectSummary,
  resolution,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * The MCP surface, driven by a real client over the real protocol.
 *
 * Two things are being checked and they are different: that the tool is
 * *described* in a way a client and a model can act on, and that what comes
 * back says the right thing — including when the API is unhappy or absent,
 * which is when a tool that reports badly does the most damage.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

describe('tool metadata', () => {
  it('declares a single required string input', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'resolve_project');

    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('declares itself read-only, so a client need not ask before calling it', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'resolve_project');

    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('describes when to call it, not just what it does', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'resolve_project');

    // The description is the only thing a model reads before choosing a tool,
    // so "call this first" earning its place there is a behaviour, not prose.
    expect(tool.description).toMatch(/call this first/i);
  });
});

describe('resolve_project', () => {
  it('calls the existing API endpoint rather than resolving anything itself', async () => {
    harness = await createMcpHarness();

    await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app/src/services' },
    });

    expect(harness.requests).toEqual([
      { path: '/api/projects/resolve', query: { path: '/srv/app/src/services' } },
    ]);
  });

  it('passes a path with characters that would otherwise break a query string', async () => {
    harness = await createMcpHarness();

    const awkward = '/srv/my app/v1.0#final/a&b?c=d';
    await harness.client.callTool({ name: 'resolve_project', arguments: { path: awkward } });

    expect(harness.requests[0]?.query).toEqual({ path: awkward });
  });

  it('returns the project id and the path within the repository', async () => {
    harness = await createMcpHarness();

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app/src/services' },
    });

    expect(result.structuredContent).toEqual({
      path: '/srv/app/src/services',
      matches: [
        {
          projectId: '892f0987-c76c-44df-8646-3c0abf3cfbc4',
          name: 'sample',
          repositoryRoot: '/srv/app',
          relativePath: 'src/services',
          exact: false,
          nodeCount: 79,
          edgeCount: 247,
          analysisStatus: 'COMPLETED',
        },
      ],
    });
  });

  it('puts the project id and the relative path in the text a model reads', async () => {
    harness = await createMcpHarness();

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app/src/services' },
    });
    const text = textOf(result);

    expect(text).toContain('892f0987-c76c-44df-8646-3c0abf3cfbc4');
    expect(text).toContain('src/services');
    expect(text).toContain('79 nodes, 247 edges');
    expect(result.isError).toBeFalsy();
  });

  it('says plainly when the path is the repository root', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        resolution({
          path: '/srv/app',
          matches: [
            {
              project: projectSummary(),
              repositoryRoot: '/srv/app',
              relativePath: '',
              exact: true,
            },
          ],
        }),
      ),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app' },
    });

    expect(textOf(result)).toContain('the repository root itself');
  });

  it('treats no match as an answer, not a failure', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(resolution({ path: '/home/someone/scratch', matches: [] })),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/home/someone/scratch' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ path: '/home/someone/scratch', matches: [] });
    // And it says what to do instead, rather than leaving the model to guess.
    expect(textOf(result)).toMatch(/No indexed project contains/);
    expect(textOf(result)).toMatch(/Read the files directly/i);
  });

  it('keeps the API ordering and tells the model the first is narrowest', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        resolution({
          path: '/srv/mono/packages/api/src',
          matches: [
            {
              project: projectSummary({ id: '22222222-2222-4222-8222-222222222222', name: 'api' }),
              repositoryRoot: '/srv/mono/packages/api',
              relativePath: 'src',
              exact: false,
            },
            {
              project: projectSummary({ id: '33333333-3333-4333-8333-333333333333', name: 'mono' }),
              repositoryRoot: '/srv/mono',
              relativePath: 'packages/api/src',
              exact: false,
            },
          ],
        }),
      ),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/mono/packages/api/src' },
    });
    const structured = result.structuredContent as { matches: { name: string }[] };

    expect(structured.matches.map((match) => match.name)).toEqual(['api', 'mono']);
    expect(textOf(result)).toContain('2 indexed projects contain');
    expect(textOf(result)).toMatch(/the first is the narrowest/);
  });

  it('tells the model recency decides when the same directory was indexed twice', async () => {
    // Nested roots and duplicate roots both produce several matches, and the
    // advice for them is opposite: "narrowest" means nothing when the roots are
    // the same directory.
    harness = await createMcpHarness(() => ({
      body: ok(
        resolution({
          path: '/srv/app',
          matches: [
            {
              project: projectSummary({ id: '44444444-4444-4444-8444-444444444444', name: 'newer' }),
              repositoryRoot: '/srv/app',
              relativePath: '',
              exact: true,
            },
            {
              project: projectSummary({ id: '55555555-5555-4555-8555-555555555555', name: 'older' }),
              repositoryRoot: '/srv/app',
              relativePath: '',
              exact: true,
            },
          ],
        }),
      ),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app' },
    });

    expect(textOf(result)).toMatch(/indexed more than once/);
    expect(textOf(result)).not.toMatch(/narrowest/);
  });

  it('reports a project that was never indexed as such, rather than as an empty graph', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        resolution({
          matches: [
            {
              project: projectSummary({ latestAnalysis: null, nodeCount: 0, edgeCount: 0 }),
              repositoryRoot: '/srv/app',
              relativePath: 'src',
              exact: false,
            },
          ],
        }),
      ),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app/src' },
    });

    expect(textOf(result)).toContain('never indexed');
    expect((result.structuredContent as { matches: { analysisStatus: null }[] }).matches[0])
      .toMatchObject({ analysisStatus: null });
  });

  it('warns when the last indexing run failed', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        resolution({
          matches: [
            {
              project: projectSummary({
                latestAnalysis: {
                  ...(projectSummary().latestAnalysis as NonNullable<
                    ReturnType<typeof projectSummary>['latestAnalysis']
                  >),
                  status: 'FAILED',
                  error: 'indexer exited 1',
                },
              }),
              repositoryRoot: '/srv/app',
              relativePath: 'src',
              exact: false,
            },
          ],
        }),
      ),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app/src' },
    });

    expect(textOf(result)).toMatch(/FAILED/);
    expect(textOf(result)).toMatch(/stale or empty/);
  });

  it('says a run is still going rather than reporting a partial graph as final', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        resolution({
          matches: [
            {
              project: projectSummary({
                latestAnalysis: {
                  ...(projectSummary().latestAnalysis as NonNullable<
                    ReturnType<typeof projectSummary>['latestAnalysis']
                  >),
                  status: 'BUILDING_GRAPH',
                },
              }),
              repositoryRoot: '/srv/app',
              relativePath: 'src',
              exact: false,
            },
          ],
        }),
      ),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app/src' },
    });

    expect(textOf(result)).toMatch(/indexing in progress \(BUILDING_GRAPH\)/);
  });
});

describe('when the API is unhappy', () => {
  it('surfaces a refusal with the API’s own stable code', async () => {
    harness = await createMcpHarness(() => ({
      status: 400,
      body: apiFailure('VALIDATION_ERROR', 'A path must not contain a NUL byte'),
    }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('VALIDATION_ERROR');
    expect(textOf(result)).toContain('NUL byte');
  });

  it('reports a body that is not the API envelope as such', async () => {
    // The usual cause is a base URL pointing at something else entirely, and
    // "not this API" is a far more useful thing to say than a parse error.
    harness = await createMcpHarness(() => ({ body: '<html>not the api</html>' }));

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('response envelope');
  });

  it('tells the caller where the API was expected when it cannot be reached', async () => {
    harness = await createMcpHarness();
    // The stub goes away; the MCP session stays up. Exactly what an agent meets
    // when the API is not running.
    await harness.stopApi();

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '/srv/app' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
    expect(textOf(result)).toMatch(/pnpm dev:api/);
  });

  it('rejects an empty path before it reaches the API', async () => {
    harness = await createMcpHarness();

    const result = await harness.client.callTool({
      name: 'resolve_project',
      arguments: { path: '' },
    });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });
});
