import { afterEach, describe, expect, it } from 'vitest';
import {
  apiFailure,
  codeMatch,
  codeSearchBody,
  createMcpHarness,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * Searching a project's source text.
 *
 * Two things carry most of this suite. The first is that the query reaches the
 * API exactly as it was given — a literal search that quietly trimmed or
 * lower-cased its input would be searching for something other than what was
 * asked for. The second is the difference between a bounded answer and an
 * incomplete one: "20 of 53" is a complete search, and "20, and the walk gave
 * up" is not, and a model told the first when the second is true will treat an
 * absence as meaningful when it is not.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const search = async (args: { projectId?: string; query?: string; limit?: number } = {}) =>
  harness.client.callTool({
    name: 'search_code',
    arguments: { projectId: PROJECT_ID, query: 'UserRepository', ...args },
  });

describe('registration', () => {
  it('requires a project and a query', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'search_code');

    expect((tool.inputSchema as { required: string[] }).required.sort()).toEqual([
      'projectId',
      'query',
    ]);
  });

  it('bounds limit below the API’s own ceiling', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'search_code');

    // The API allows 100; these lines go into a model's context.
    expect((tool.inputSchema as { properties: { limit: unknown } }).properties.limit).toMatchObject(
      { type: 'integer', minimum: 1, maximum: 50 },
    );
  });

  it('tells a model the matching is literal and case-sensitive', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'search_code');

    expect(tool.description).toMatch(/case-sensitive literal/i);
    expect(tool.description).toMatch(/not a regular expression/i);
  });
});

describe('the request', () => {
  it('calls the canonical route with the project in the path', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch()]) }));

    await search();

    expect(harness.requests).toEqual([
      {
        path: `/api/projects/${PROJECT_ID}/code/search`,
        query: { q: 'UserRepository', limit: '20' },
      },
    ]);
  });

  it('forwards the query unchanged, without trimming or lowercasing', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    // Leading and trailing whitespace are part of a literal search term.
    await search({ query: '  UserRepository  ' });

    expect(harness.requests[0]?.query.q).toBe('  UserRepository  ');
  });

  it('preserves case exactly', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    await search({ query: 'userrepository' });

    expect(harness.requests[0]?.query.q).toBe('userrepository');
  });

  it.each([
    'foo.bar',
    'src/users/',
    'a:b',
    'foo_bar',
    'foo-bar',
    '(foo)',
    '[foo]',
    '?',
    'a|b',
    'a\\b',
    '$var',
    'x*y',
    '^start',
    'end$',
  ])('forwards %s without escaping it', async (query) => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    await search({ query });

    expect(harness.requests[0]?.query.q).toBe(query);
  });

  it('passes a requested limit through, and defaults when omitted', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    await search({ limit: 5 });
    expect(harness.requests[0]?.query.limit).toBe('5');

    await search();
    expect(harness.requests[1]?.query.limit).toBe('20');
  });
});

describe('results', () => {
  it('preserves the location exactly as the API gave it', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch()]) }));

    const result = await search();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      projectId: PROJECT_ID,
      query: 'UserRepository',
      results: [
        {
          filePath: 'src/app.ts',
          // 1-based line, 0-based column, neither shifted.
          line: 8,
          column: 9,
          match: 'UserRepository',
          lineText: "import { UserRepository } from './repositories/user.repository';",
          lineTruncated: false,
        },
      ],
    });
    expect(textOf(result)).toMatch(/src\/app\.ts:8:9/);
  });

  it('keeps every occurrence, in the API’s order, without merging by line or file', async () => {
    const matches = [
      codeMatch({ filePath: 'docs/a.md', line: 1, column: 0 }),
      codeMatch({ filePath: 'src/a.ts', line: 1, column: 0 }),
      codeMatch({ filePath: 'src/a.ts', line: 1, column: 4 }),
      codeMatch({ filePath: 'src/a.ts', line: 2, column: 0 }),
    ];
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, matches, { total: 4 }) }));

    const result = await search();
    const { results } = result.structuredContent as {
      results: { filePath: string; line: number; column: number }[];
    };

    expect(results.map((r) => [r.filePath, r.line, r.column])).toEqual([
      ['docs/a.md', 1, 0],
      ['src/a.ts', 1, 0],
      ['src/a.ts', 1, 4],
      ['src/a.ts', 2, 0],
    ]);
  });

  it('marks a windowed line rather than presenting it as the whole line', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch({ lineText: 'aaaNEEDLEbbb', lineTruncated: true })]) }));

    const result = await search();

    expect(result.structuredContent).toMatchObject({ results: [{ lineTruncated: true }] });
    expect(textOf(result)).toMatch(/line truncated/);
  });

  it('preserves every metadata field the API reports', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch()], { total: 53, limit: 20, truncated: true, filesSearched: 749, filesSkipped: 2 }) }));

    const result = await search();

    expect(result.structuredContent).toMatchObject({
      meta: {
        total: 53,
        limit: 20,
        truncated: true,
        filesSearched: 749,
        filesSkipped: 2,
        scanTruncated: false,
      },
    });
  });
});

describe('a complete search with bounded output', () => {
  it('says how many were found when everything fits', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch(), codeMatch({ line: 21 })], { total: 2 }) }));

    expect(textOf(await search())).toMatch(/^Found 2 matches for "UserRepository"\./);
  });

  it('says "showing X of Y" when more matches exist', async () => {
    const matches = Array.from({ length: 20 }, (_, i) => codeMatch({ line: i + 1 }));
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, matches, { total: 53, truncated: true }) }));

    const result = await search();

    expect(textOf(result)).toMatch(/^Showing 20 of 53 matches for "UserRepository"\./);
    expect(result.structuredContent).toMatchObject({
      meta: { total: 53, truncated: true, scanTruncated: false },
    });
  });
});

describe('an incomplete search', () => {
  it('never presents a truncated scan as an exact count', async () => {
    // The distinction this tool exists to keep straight: `total` is a floor
    // here, and "20 of 53" would be a claim about a search that did not finish.
    const matches = Array.from({ length: 20 }, (_, i) => codeMatch({ line: i + 1 }));
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, matches, { total: 53, truncated: true, scanTruncated: true, filesSearched: 25_000 }) }));

    const result = await search();
    const text = textOf(result);

    expect(text).not.toMatch(/of 53 matches/);
    expect(text).toMatch(/repository scan was truncated/i);
    expect(text).toMatch(/more matches may exist/i);
    expect(text).toMatch(/floor rather than a total/i);
    expect(result.structuredContent).toMatchObject({ meta: { scanTruncated: true } });
  });

  it('reports skipped files with their count', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch()], { filesSkipped: 3 }) }));

    const result = await search();

    expect(textOf(result)).toMatch(/3 files were skipped for exceeding the source-search size limit/);
    expect(result.structuredContent).toMatchObject({ meta: { filesSkipped: 3 } });
  });

  it('uses the singular for one skipped file', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch()], { filesSkipped: 1 }) }));

    expect(textOf(await search())).toMatch(/1 file was skipped/);
  });
});

describe('empty results', () => {
  it('is a successful answer', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    const result = await search({ query: 'DefinitelyNotPresent' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      results: [],
      meta: { total: 0, truncated: false },
    });
    expect(textOf(result)).toMatch(/No code matches "DefinitelyNotPresent" in this project/);
  });

  it('points at the other search when a literal one finds nothing', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    const text = textOf(await search({ query: 'nope' }));

    expect(text).toMatch(/literal and case-sensitive/);
    expect(text).toMatch(/search_graph/);
  });

  it('does not call an empty result proof of absence when the scan was incomplete', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0, scanTruncated: true }) }));

    const text = textOf(await search({ query: 'nope' }));

    expect(text).toMatch(/not proof the string is absent/i);
    expect(text).toMatch(/floor rather than a total/i);
  });
});

describe('project isolation', () => {
  it('searches only the project it was given', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    await search({ projectId: OTHER_PROJECT_ID });

    expect(harness.requests[0]?.path).toBe(`/api/projects/${OTHER_PROJECT_ID}/code/search`);
    expect(harness.requests[0]?.path).not.toContain(PROJECT_ID);
  });

  it('returns only the addressed project’s files when both contain the text', async () => {
    const byProject: Record<string, ReturnType<typeof codeMatch>[]> = {
      [PROJECT_ID]: [codeMatch({ filePath: 'a/src/user.repository.ts' })],
      [OTHER_PROJECT_ID]: [codeMatch({ filePath: 'b/src/user.repository.ts' })],
    };

    harness = await createMcpHarness((request) => {
      const id = request.path.split('/')[3] ?? '';
      const matches = byProject[id] ?? [];
      return { body: codeSearchBody(request, matches) };
    });

    const inA = await search({ projectId: PROJECT_ID });
    const inB = await search({ projectId: OTHER_PROJECT_ID });

    expect((inA.structuredContent as { results: { filePath: string }[] }).results[0]?.filePath).toBe(
      'a/src/user.repository.ts',
    );
    expect((inB.structuredContent as { results: { filePath: string }[] }).results[0]?.filePath).toBe(
      'b/src/user.repository.ts',
    );
    expect(textOf(inA)).not.toContain('b/src');
    expect(textOf(inB)).not.toContain('a/src');
  });

  it('carries no project state between calls', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    await search({ projectId: PROJECT_ID });
    await search({ projectId: OTHER_PROJECT_ID });

    expect(harness.requests.map((request) => request.path)).toEqual([
      `/api/projects/${PROJECT_ID}/code/search`,
      `/api/projects/${OTHER_PROJECT_ID}/code/search`,
    ]);
  });

  it('refuses results answering a different query than the one asked', async () => {
    // A code match carries no project id, only a relative path, so this is the
    // one post-condition the response makes available.
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [codeMatch()], { query: 'SomethingElse' }) }));

    const result = await search({ query: 'UserRepository' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/matches for a different question/);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('when the search fails', () => {
  it('distinguishes unsearchable source from finding nothing', async () => {
    harness = await createMcpHarness(() => ({
      status: 403,
      body: apiFailure(
        'SOURCE_NOT_READABLE',
        'Source retrieval is only available for repositories indexed from a local path',
      ),
    }));

    const result = await search();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cannot be searched/);
    expect(textOf(result)).toMatch(/not a zero-result search/i);
    // No quiet substitution of one capability for another.
    expect(harness.requests).toHaveLength(1);
  });

  it('explains a source directory that has gone', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('REPOSITORY_PATH_NOT_FOUND', 'The repository directory is no longer readable'),
    }));

    const result = await search();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no longer readable/);
  });

  it('directs the agent to resolve_project for an unknown project', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('PROJECT_NOT_FOUND', `Project ${PROJECT_ID} was not found`),
    }));

    const result = await search();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/There is no project with id/);
    expect(textOf(result)).toMatch(/Call resolve_project/);
  });

  it('passes another refusal through with the API’s code and nothing internal', async () => {
    harness = await createMcpHarness(() => ({
      status: 500,
      body: apiFailure('DATABASE_ERROR', 'the database rejected an operation'),
    }));

    const result = await search();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DATABASE_ERROR');
    expect(textOf(result)).not.toMatch(/at .+:\d+:\d+|postgres(ql)?:\/\/|SELECT /i);
  });

  it('says where the API was expected when it is not running', async () => {
    harness = await createMcpHarness();
    await harness.stopApi();

    const result = await search();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
  });
});

describe('invalid input', () => {
  it('rejects a project id that is not a uuid', async () => {
    harness = await createMcpHarness();

    expect((await search({ projectId: 'not-a-uuid' })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects an empty query', async () => {
    harness = await createMcpHarness();

    expect((await search({ query: '' })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects a query beyond the canonical maximum', async () => {
    harness = await createMcpHarness();

    expect((await search({ query: 'x'.repeat(201) })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('accepts a query at exactly the maximum', async () => {
    harness = await createMcpHarness((request) => ({ body: codeSearchBody(request, [], { total: 0 }) }));

    const result = await search({ query: 'x'.repeat(200) });

    expect(result.isError).toBeFalsy();
    expect(harness.requests).toHaveLength(1);
  });

  it('rejects a limit outside its range', async () => {
    harness = await createMcpHarness();

    expect((await search({ limit: 0 })).isError).toBe(true);
    expect((await search({ limit: 51 })).isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });
});
