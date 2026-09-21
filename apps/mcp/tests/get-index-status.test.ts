import { afterEach, describe, expect, it } from 'vitest';
import {
  analysisJob,
  apiFailure,
  createMcpHarness,
  ok,
  PROJECT_ID,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * Whether a project can answer, before anything asks it.
 *
 * The four states exist because they call for four different behaviours, so
 * each is checked for the thing that behaviour depends on: that `ready` reports
 * a size, that `indexing` says not to trust the result yet, that `failed` says
 * whether an older graph survives, and above all that `never_indexed` is never
 * mistakable for "this code does not exist" — which is the failure this tool is
 * here to prevent.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const call = async (projectId: string = PROJECT_ID) =>
  harness.client.callTool({ name: 'get_index_status', arguments: { projectId } });

describe('tool metadata', () => {
  it('takes a project id and nothing else', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'get_index_status');

    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    });
  });

  it('tells a model to call it after resolve_project and before querying', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'get_index_status');

    expect(tool.description).toMatch(/after resolve_project/i);
  });

  it('is read-only but not idempotent, because the answer changes mid-run', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'get_index_status');

    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: false });
  });
});

describe('get_index_status', () => {
  it('reads the existing analysis endpoint rather than a new one', async () => {
    harness = await createMcpHarness(() => ({ body: ok([analysisJob()]) }));

    await call();

    expect(harness.requests).toEqual([
      { path: `/api/projects/${PROJECT_ID}/analysis`, query: {} },
    ]);
  });

  it('reports a completed run as ready, with the graph size', async () => {
    harness = await createMcpHarness(() => ({ body: ok([analysisJob()]) }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      projectId: PROJECT_ID,
      state: 'ready',
      usable: true,
      status: 'COMPLETED',
      language: 'typescript',
      nodeCount: 79,
      edgeCount: 247,
      warningCount: 0,
      error: null,
      progress: null,
      lastSuccessfulRun: null,
    });
    expect(textOf(result)).toMatch(/indexed and ready to query/);
    expect(textOf(result)).toContain('79 nodes, 247 edges');
    expect(result.isError).toBeFalsy();
  });

  it('says which files were skipped when a run completed with warnings', async () => {
    harness = await createMcpHarness(() => ({
      body: ok([
        analysisJob({
          errors: [
            { file: 'src/generated/huge.ts', error: 'file too large' },
            { file: 'src/broken.ts', error: 'parse error' },
          ],
        }),
      ]),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({ state: 'ready', warningCount: 2 });
    // The graph is missing whatever was in them, which changes whether a model
    // should trust an absence.
    expect(textOf(result)).toMatch(/2 file\(s\) could not be read or parsed/);
    expect(textOf(result)).toMatch(/read them directly/i);
  });

  it('reports a run in flight as indexing, with the phase and a percentage', async () => {
    harness = await createMcpHarness(() => ({
      body: ok([
        analysisJob({
          status: 'PARSING',
          completedAt: null,
          stats: null,
          progress: {
            phase: 'parsing',
            current: 40,
            total: 100,
            message: 'Parsing source',
            files: 40,
          },
        }),
      ]),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      state: 'indexing',
      status: 'PARSING',
      usable: false,
      progress: { phase: 'parsing', message: 'Parsing source' },
    });
    expect(textOf(result)).toMatch(/being indexed right now/);
    expect(textOf(result)).toMatch(/do not trust results yet/i);
  });

  it('uses the pipeline’s own weighting for the percentage', async () => {
    harness = await createMcpHarness(() => ({
      body: ok([
        analysisJob({
          status: 'QUEUED',
          completedAt: null,
          stats: null,
          progress: { phase: 'queued', current: 0, total: 0, message: 'Queued' },
        }),
      ]),
    }));

    const result = await call();

    // Queued is the start of the run, so it is 0% by the shared weighting
    // rather than "one of seven statuses" — the two disagree, and the shared
    // one is the one the UI shows.
    expect(result.structuredContent).toMatchObject({ progress: { phase: 'queued', percent: 0 } });
  });

  it('falls back to the phase a status implies when a run reports no progress', async () => {
    harness = await createMcpHarness(() => ({
      body: ok([analysisJob({ status: 'BUILDING_GRAPH', completedAt: null, progress: null })]),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      state: 'indexing',
      progress: { phase: 'building_graph', message: 'Building graph' },
    });
  });

  it('reports a failed run with its reason', async () => {
    harness = await createMcpHarness(() => ({
      body: ok([
        analysisJob({
          status: 'FAILED',
          completedAt: null,
          stats: null,
          error: 'SCIP_INDEX_FAILED: the indexer exited with code 1',
        }),
      ]),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      state: 'failed',
      usable: false,
      error: 'SCIP_INDEX_FAILED: the indexer exited with code 1',
      lastSuccessfulRun: null,
    });
    expect(textOf(result)).toMatch(/failed to index/);
    expect(textOf(result)).toMatch(/nothing to query|Read the files directly/i);
  });

  it('points at the surviving graph when an earlier run succeeded', async () => {
    // The pipeline replaces a project's graph in one step at the end of a run,
    // so a failed re-index leaves the previous graph exactly where it was.
    harness = await createMcpHarness(() => ({
      body: ok([
        analysisJob({
          id: '22222222-2222-4222-8222-222222222222',
          status: 'FAILED',
          completedAt: null,
          stats: null,
          error: 'SCIP_INDEX_FAILED',
        }),
        analysisJob({
          id: '33333333-3333-4333-8333-333333333333',
          completedAt: '2025-12-30T00:00:00.000Z',
        }),
      ]),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      state: 'failed',
      usable: true,
      lastSuccessfulRun: {
        analysisId: '33333333-3333-4333-8333-333333333333',
        completedAt: '2025-12-30T00:00:00.000Z',
        nodeCount: 79,
      },
    });
    expect(textOf(result)).toMatch(/earlier successful run/);
    expect(textOf(result)).toMatch(/predates/);
  });

  it('warns that a graph is stale while a re-index is running over it', async () => {
    harness = await createMcpHarness(() => ({
      body: ok([
        analysisJob({ id: '44444444-4444-4444-8444-444444444444', status: 'INDEXING', completedAt: null, stats: null }),
        analysisJob({ id: '55555555-5555-4555-8555-555555555555' }),
      ]),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({ state: 'indexing', usable: true });
    expect(textOf(result)).toMatch(/earlier run is still stored/);
    expect(textOf(result)).toMatch(/out of date/);
  });

  it('never lets a never-indexed project read as "no such code"', async () => {
    harness = await createMcpHarness(() => ({ body: ok([]) }));

    const result = await call();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      state: 'never_indexed',
      usable: false,
      status: null,
      analysisId: null,
      nodeCount: null,
    });
    // The single most important sentence this tool produces.
    expect(textOf(result)).toMatch(/never been indexed/);
    expect(textOf(result)).toMatch(/never "no such code"/);
  });

  it('reports a completed run that stored nothing as empty rather than as a size', async () => {
    harness = await createMcpHarness(() => ({
      body: ok([
        analysisJob({
          stats: {
            documentCount: 0,
            symbolCount: 0,
            nodeCount: 0,
            edgeCount: 0,
            durationMs: 100,
          },
        }),
      ]),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({ state: 'ready', nodeCount: 0 });
    expect(textOf(result)).toMatch(/empty — the run completed but stored nothing/);
  });

  it('copes with an old run that recorded no statistics', async () => {
    harness = await createMcpHarness(() => ({ body: ok([analysisJob({ stats: null })]) }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      state: 'ready',
      nodeCount: null,
      edgeCount: null,
    });
    expect(textOf(result)).toMatch(/recorded no size/);
  });
});

describe('when the API is unhappy', () => {
  it('explains a deleted or invented project id in terms of what to do', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('PROJECT_NOT_FOUND', `Project ${PROJECT_ID} was not found`),
    }));

    const result = await call();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Call resolve_project/);
  });

  it('passes any other refusal through with the API’s own code', async () => {
    harness = await createMcpHarness(() => ({
      status: 500,
      body: apiFailure('DATABASE_ERROR', 'the database rejected an operation'),
    }));

    const result = await call();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DATABASE_ERROR');
  });

  it('says where the API was expected when it is not running', async () => {
    harness = await createMcpHarness();
    await harness.stopApi();

    const result = await call();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
  });

  it('rejects an id that is not a uuid without troubling the API', async () => {
    harness = await createMcpHarness();

    const result = await call('not-a-uuid');

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });
});
