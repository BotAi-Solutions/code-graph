import { afterEach, describe, expect, it } from 'vitest';
import {
  analysisJob,
  apiFailure,
  createMcpHarness,
  indexFreshness,
  indexProjectResult,
  ok,
  PROJECT_ID,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * Getting a directory indexed from inside a conversation.
 *
 * The decisions — create, re-index, or leave alone; never a second run — live
 * behind the API route and are tested there against a real repository. What
 * this suite holds the tool to is the adapter's half: that it asks the existing
 * route rather than doing anything itself, and that each outcome and each
 * failure reaches the model as something it can act on.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const call = async (args: Record<string, unknown> = { path: '/srv/app' }) =>
  harness.client.callTool({ name: 'index_project', arguments: args });

describe('tool metadata', () => {
  it('takes a path, and an optional force', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'index_project');

    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, force: { type: 'boolean' } },
      required: ['path'],
    });
  });

  it('is a write, but not a destructive one', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'index_project');

    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('tells a model how to wait, and that it never starts a duplicate', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'index_project');

    expect(tool.description).toMatch(/get_index_status/);
    expect(tool.description).toMatch(/duplicate is never started/);
  });
});

describe('index_project', () => {
  it('asks the existing index route, passing the path through untouched', async () => {
    harness = await createMcpHarness(() => ({ status: 202, body: ok(indexProjectResult()) }));

    await call({ path: '/srv/my app#1' });

    expect(harness.requests).toEqual([
      { path: '/api/projects/index', query: {}, method: 'POST', body: { path: '/srv/my app#1', force: false } },
    ]);
  });

  it('passes force through', async () => {
    harness = await createMcpHarness(() => ({ status: 202, body: ok(indexProjectResult()) }));

    await call({ path: '/srv/app', force: true });

    expect(harness.requests[0]?.body).toEqual({ path: '/srv/app', force: true });
  });

  it('registers a new project and starts its first run', async () => {
    harness = await createMcpHarness(() => ({ status: 202, body: ok(indexProjectResult()) }));

    const result = await call();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      action: 'started',
      projectCreated: true,
      jobCreated: true,
      projectId: PROJECT_ID,
      repositoryRoot: '/srv/app',
      jobId: '11111111-1111-4111-8111-111111111111',
      jobStatus: 'QUEUED',
      freshness: null,
    });
    expect(textOf(result)).toMatch(/new project/);
    expect(textOf(result)).toMatch(/Poll get_index_status/);
  });

  it('reports the run already in progress instead of starting another', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        indexProjectResult({
          action: 'already_indexing',
          projectCreated: false,
          jobCreated: false,
          job: analysisJob({ status: 'PARSING', completedAt: null }),
          reason: 'A run (PARSING) is already in progress for this project; no second one was queued.',
        }),
      ),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      action: 'already_indexing',
      jobCreated: false,
      jobStatus: 'PARSING',
    });
    expect(textOf(result)).toMatch(/no second run was queued/);
  });

  it('leaves an already-current project alone', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        indexProjectResult({
          action: 'up_to_date',
          projectCreated: false,
          jobCreated: false,
          job: null,
          freshness: indexFreshness(),
          reason: 'The stored graph already matches the files on disk; no run was queued.',
        }),
      ),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      action: 'up_to_date',
      jobCreated: false,
      jobId: null,
      freshness: 'current',
    });
    expect(textOf(result)).toMatch(/already matches the files/);
    expect(textOf(result)).toMatch(/force: true/);
  });

  it('re-indexes a stale project, saying how stale', async () => {
    harness = await createMcpHarness(() => ({
      status: 202,
      body: ok(
        indexProjectResult({
          projectCreated: false,
          freshness: indexFreshness({ state: 'stale', changedFiles: 4, changedPaths: ['src/a.ts'] }),
          reason: 'Re-index queued because the graph is stale: 4 file(s) differ from what was indexed.',
        }),
      ),
    }));

    const result = await call();

    expect(result.structuredContent).toMatchObject({
      action: 'started',
      projectCreated: false,
      freshness: 'stale',
      changedFiles: 4,
    });
    expect(textOf(result)).toMatch(/Queued a re-index/);
    expect(textOf(result)).toMatch(/4 file\(s\) differ/);
  });
});

describe('when indexing cannot start', () => {
  it.each([
    ['INVALID_PROJECT_PATH', 400, 'The project path must be an absolute path to a local directory.', /absolute path of a directory/],
    ['DIRECTORY_NOT_FOUND', 404, 'Unable to read project directory.', /no such directory/],
    ['DIRECTORY_NOT_READABLE', 403, 'Permission denied while accessing the project.', /permission denied/],
    ['FILESYSTEM_ACCESS_DISABLED', 403, 'Local filesystem access is disabled on this server', /LOCAL_FILESYSTEM_ENABLED=false/],
  ])('explains %s in terms of the fix', async (code, status, message, expected) => {
    harness = await createMcpHarness(() => ({ status, body: apiFailure(code, message) }));

    const result = await call({ path: 'relative/or/missing' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(expected);
  });

  it('reports a job that could not be created with the API’s own code', async () => {
    harness = await createMcpHarness(() => ({
      status: 500,
      body: apiFailure('INTERNAL_ERROR', 'An unexpected error occurred'),
    }));

    const result = await call();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be started \(INTERNAL_ERROR\)/);
  });

  it('says how to start CodeRAG when the API is not running', async () => {
    harness = await createMcpHarness();
    await harness.stopApi();

    const result = await call();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
    expect(textOf(result)).toMatch(/pnpm dev:all/);
  });

  it('refuses to report a response it does not recognise', async () => {
    harness = await createMcpHarness(() => ({ body: ok({ something: 'else' }) }));

    const result = await call();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unexpected response/);
  });
});
