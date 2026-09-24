import { afterEach, describe, expect, it } from 'vitest';
import {
  apiFailure,
  createMcpHarness,
  ok,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  sourceWindow,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * Reading the code behind a location.
 *
 * Two properties matter most here. The first is that the request is forwarded
 * untouched: a path this layer normalised, or a range it adjusted, would be a
 * window the caller did not ask for, and the path rules live on the other side
 * of the boundary precisely so there is one implementation of them. The second
 * is that what comes back is checked before it is reported — malformed content
 * arriving at a model *as source code* is the one wrong answer here that would
 * be acted on without question.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const FILE = 'src/repositories/user.repository.ts';

const read = async (
  args: { projectId?: string; file?: string; startLine?: number; endLine?: number } = {},
) =>
  harness.client.callTool({
    name: 'get_source',
    arguments: { projectId: PROJECT_ID, file: FILE, ...args },
  });

describe('registration', () => {
  it('exposes exactly the eight tools, in the order an agent uses them', async () => {
    harness = await createMcpHarness();

    const { tools } = await harness.client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'resolve_project',
      'get_index_status',
      'index_project',
      'search_graph',
      'get_node',
      'trace_path',
      'search_code',
      'get_source',
    ]);
  });

  it('requires a project and a file, and nothing else', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'get_source');
    const schema = tool.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(schema.required.sort()).toEqual(['file', 'projectId']);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'endLine',
      'file',
      'projectId',
      'startLine',
    ]);
  });

  it('tells a model to pass a range', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'get_source');

    expect(tool.description).toMatch(/pass startLine and endLine/i);
  });
});

describe('the request', () => {
  it('calls the canonical route with the project in the path', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    await read();

    expect(harness.requests).toEqual([
      { path: `/api/projects/${PROJECT_ID}/source`, query: { file: FILE } },
    ]);
  });

  it('forwards a line range unchanged', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    await read({ startLine: 38, endLine: 50 });

    expect(harness.requests[0]?.query).toEqual({
      file: FILE,
      startLine: '38',
      endLine: '50',
    });
  });

  it('sends only the bounds it was given', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    await read({ startLine: 38 });
    expect(harness.requests[0]?.query).toEqual({ file: FILE, startLine: '38' });

    await read({ endLine: 50 });
    expect(harness.requests[1]?.query).toEqual({ file: FILE, endLine: '50' });
  });

  it('forwards the path without normalising it', async () => {
    // Whether a path is acceptable is the API's judgement, not this layer's.
    harness = await createMcpHarness(() => ({
      status: 403,
      body: apiFailure('SOURCE_PATH_NOT_ALLOWED', 'A source path must not climb above the repository root'),
    }));

    await read({ file: '../../etc/passwd' });

    expect(harness.requests[0]?.query.file).toBe('../../etc/passwd');
  });
});

describe('the window that comes back', () => {
  it('reports the file, the range and the code', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    const result = await read({ startLine: 38, endLine: 40 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      projectId: PROJECT_ID,
      file: FILE,
      language: 'typescript',
      startLine: 38,
      endLine: 40,
      totalLines: 120,
      truncated: false,
      lines: [
        { line: 38, text: 'export class UserRepository {' },
        { line: 39, text: '  constructor(private readonly pool: Pool) {}' },
        { line: 40, text: '}' },
      ],
    });
  });

  it('numbers each line so a model can cite one', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    const text = textOf(await read());

    expect(text).toMatch(/lines 38-40 of 120, typescript/);
    expect(text).toContain('38 | export class UserRepository {');
    expect(text).toContain('40 | }');
  });

  it('aligns the gutter to the widest line number', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        sourceWindow({
          lines: [
            { line: 9, text: 'nine' },
            { line: 10, text: 'ten' },
          ],
        }),
      ),
    }));

    const text = textOf(await read());

    expect(text).toContain(' 9 | nine');
    expect(text).toContain('10 | ten');
  });

  it('says when the range was wider than one response carries', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow({ truncated: true })) }));

    const result = await read({ startLine: 1, endLine: 5000 });

    expect(result.structuredContent).toMatchObject({ truncated: true });
    expect(textOf(result)).toMatch(/cut at 2000 lines/);
  });

  it('handles an empty file without pretending it had content', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(sourceWindow({ lines: [], totalLines: 0, startLine: 1, endLine: 1 })),
    }));

    const result = await read();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ lines: [] });
    expect(textOf(result)).toMatch(/the file is empty/);
  });

  it('carries a null language through rather than guessing one', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow({ language: null })) }));

    const result = await read();

    expect(result.structuredContent).toMatchObject({ language: null });
    expect(textOf(result)).not.toMatch(/, null\)/);
  });
});

describe('validating the response', () => {
  it('refuses a body that is not a source window', async () => {
    harness = await createMcpHarness(() => ({ body: ok({ nonsense: true }) }));

    const result = await read();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a source window/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('refuses a window whose lines are malformed', async () => {
    // Half-valid is the dangerous case: the shape looks right, so an
    // unvalidated tool would hand a model whatever these turned out to be.
    harness = await createMcpHarness(() => ({
      body: ok({ ...sourceWindow(), lines: [{ line: 'thirty-eight', text: 42 }] }),
    }));

    const result = await read();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a source window/);
  });

  it('refuses a window that is missing a field', async () => {
    const { totalLines: _removed, ...incomplete } = sourceWindow();
    harness = await createMcpHarness(() => ({ body: ok(incomplete) }));

    expect((await read()).isError).toBe(true);
  });
});

describe('project isolation', () => {
  it('reads only from the project it was given', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    await read({ projectId: OTHER_PROJECT_ID });

    expect(harness.requests[0]?.path).toBe(`/api/projects/${OTHER_PROJECT_ID}/source`);
    expect(harness.requests[0]?.path).not.toContain(PROJECT_ID);
  });

  it('carries no project state between calls', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    await read({ projectId: PROJECT_ID });
    await read({ projectId: OTHER_PROJECT_ID });
    await read({ projectId: PROJECT_ID });

    expect(harness.requests.map((request) => request.path)).toEqual([
      `/api/projects/${PROJECT_ID}/source`,
      `/api/projects/${OTHER_PROJECT_ID}/source`,
      `/api/projects/${PROJECT_ID}/source`,
    ]);
  });

  it('does not infer a project from the file path', async () => {
    harness = await createMcpHarness(() => ({ body: ok(sourceWindow()) }));

    await read({ file: 'some/other/project/src/a.ts' });

    expect(harness.requests[0]?.path).toBe(`/api/projects/${PROJECT_ID}/source`);
  });
});

describe('when the read fails', () => {
  it('explains a refused path and where a good one comes from', async () => {
    harness = await createMcpHarness(() => ({
      status: 403,
      body: apiFailure('SOURCE_PATH_NOT_ALLOWED', 'A source path must not climb above the repository root'),
    }));

    const result = await read({ file: '../../etc/passwd' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a path this project will serve/);
    expect(textOf(result)).toMatch(/relative to the repository root/);
    // One request: no retry with a different path, no second guess.
    expect(harness.requests).toHaveLength(1);
  });

  it('explains a file that is not there', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('SOURCE_FILE_NOT_FOUND', 'src/gone.ts was not found in the project repository'),
    }));

    const result = await read({ file: 'src/gone.ts' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/was not found in project/);
    expect(textOf(result)).toMatch(/search_code/);
  });

  it('distinguishes unreadable source from an empty file', async () => {
    harness = await createMcpHarness(() => ({
      status: 403,
      body: apiFailure(
        'SOURCE_NOT_READABLE',
        'Source retrieval is only available for repositories indexed from a local path',
      ),
    }));

    const result = await read();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cannot be read/);
    expect(textOf(result)).toMatch(/git URL keeps no source on disk/);
  });

  it('reports a file too large to serve', async () => {
    harness = await createMcpHarness(() => ({
      status: 422,
      body: apiFailure('SOURCE_FILE_TOO_LARGE', 'too large'),
    }));

    expect(textOf(await read())).toMatch(/larger than source retrieval will read/);
  });

  it('reports the local-filesystem switch being off', async () => {
    harness = await createMcpHarness(() => ({
      status: 403,
      body: apiFailure('FILESYSTEM_ACCESS_DISABLED', 'Local filesystem access is disabled on this server'),
    }));

    const result = await read();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('FILESYSTEM_ACCESS_DISABLED');
  });

  it('directs the agent to resolve_project for an unknown project', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('PROJECT_NOT_FOUND', `Project ${PROJECT_ID} was not found`),
    }));

    const result = await read();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Call resolve_project/);
  });

  it('passes another refusal through with the API’s code and nothing internal', async () => {
    harness = await createMcpHarness(() => ({
      status: 500,
      body: apiFailure('DATABASE_ERROR', 'the database rejected an operation'),
    }));

    const result = await read();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DATABASE_ERROR');
    expect(textOf(result)).not.toMatch(/at .+:\d+:\d+|postgres(ql)?:\/\/|SELECT /i);
  });

  it('says where the API was expected when it is not running', async () => {
    harness = await createMcpHarness();
    await harness.stopApi();

    const result = await read();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
  });
});

describe('invalid input', () => {
  it('rejects a project id that is not a uuid', async () => {
    harness = await createMcpHarness();

    expect((await read({ projectId: 'not-a-uuid' })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects an empty file path', async () => {
    harness = await createMcpHarness();

    expect((await read({ file: '   ' })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects a line number below one', async () => {
    harness = await createMcpHarness();

    expect((await read({ startLine: 0 })).isError).toBe(true);
    expect((await read({ endLine: -5 })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects a non-integer line number', async () => {
    harness = await createMcpHarness();

    expect((await read({ startLine: 4.5 })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects a range that runs backwards, without a round trip', async () => {
    harness = await createMcpHarness();

    const result = await read({ startLine: 50, endLine: 38 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/endLine \(38\) is before startLine \(50\)/);
    expect(harness.requests).toEqual([]);
  });

  it('accepts a single-line range', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(sourceWindow({ lines: [{ line: 42, text: 'const x = 1;' }] })),
    }));

    const result = await read({ startLine: 42, endLine: 42 });

    expect(result.isError).toBeFalsy();
    expect(harness.requests[0]?.query).toEqual({ file: FILE, startLine: '42', endLine: '42' });
  });
});
