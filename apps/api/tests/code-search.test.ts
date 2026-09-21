import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResponse, CodeSearchMatch, Project } from '@ckg/shared';
import { body, createHarness, type Harness } from './helpers/harness.js';

/**
 * Literal source search, against real directories on a real disk.
 *
 * Deliberately not a fake filesystem. The things most likely to be wrong here
 * are the boundaries — which files the walk offers, whether the ignore policy
 * is the project's own, whether a search can reach outside the project root —
 * and a stubbed file layer would test none of them. So each suite writes a
 * throwaway repository, registers it as a project's source, and searches it
 * through the HTTP route.
 */

let harness: Harness;
let base: string;

/** Writes a tree under a fresh directory and returns it as a project id. */
async function project(name: string, files: Record<string, string>): Promise<string> {
  const root = path.join(base, name);

  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }

  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name },
  });
  const projectId = (body<Project>(created).data as Project).id;

  await harness.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/repository`,
    // Relative to the harness's repository base directory, which is `base`.
    payload: { sourceType: 'local', sourcePath: name },
  });

  return projectId;
}

interface SearchResponse {
  status: number;
  matches: CodeSearchMatch[];
  meta: Record<string, unknown>;
  error: { code: string } | null;
}

async function search(
  projectId: string,
  q: string,
  query: Record<string, string> = {},
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, ...query });
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/code/search?${params.toString()}`,
  });
  const payload = body<CodeSearchMatch[]>(response) as ApiResponse<CodeSearchMatch[]>;

  return {
    status: response.statusCode,
    matches: payload.success ? payload.data : [],
    meta: payload.meta,
    error: payload.success ? null : payload.error,
  };
}

beforeAll(async () => {
  // `realpath` because macOS puts the temp directory behind its own symlink,
  // and the source root is resolved through one.
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'ckg-code-search-')));
  harness = await createHarness({ repositoryBaseDirectory: base });
});

afterAll(async () => {
  await harness.app.close();
  await rm(base, { recursive: true, force: true });
});

describe('finding a string', () => {
  it('reports the file, line, column, match and line', async () => {
    const id = await project('basic', {
      'src/user.service.ts': [
        'import { UserRepository } from "./user.repository";',
        '',
        'export class UserService {',
        '  constructor(private readonly repo: UserRepository) {}',
        '}',
      ].join('\n'),
    });

    const { status, matches, meta } = await search(id, 'UserRepository');

    expect(status).toBe(200);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      filePath: 'src/user.service.ts',
      line: 1,
      // 0-based, matching `startCharacter` everywhere else in this API.
      column: 9,
      match: 'UserRepository',
      lineText: 'import { UserRepository } from "./user.repository";',
      lineTruncated: false,
    });
    expect(matches[1]).toMatchObject({ line: 4, column: 37 });
    expect(meta).toMatchObject({ total: 2, truncated: false, query: 'UserRepository' });
  });

  it('finds matches across several files', async () => {
    const id = await project('multi-file', {
      'src/a.ts': 'const marker = 1;\n',
      'src/b.ts': 'const marker = 2;\n',
      'docs/notes.md': 'the marker is documented here\n',
    });

    const { matches, meta } = await search(id, 'marker');

    expect(meta).toMatchObject({ total: 3 });
    expect(matches.map((match) => match.filePath)).toEqual([
      'docs/notes.md',
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('returns one result per occurrence, not per line', async () => {
    const id = await project('occurrences', { 'src/a.ts': 'foo(foo, foo);\n' });

    const { matches, meta } = await search(id, 'foo');

    expect(meta).toMatchObject({ total: 3 });
    expect(matches.map((match) => match.column)).toEqual([0, 4, 9]);
    expect(matches.every((match) => match.line === 1)).toBe(true);
  });

  it('counts overlapping occurrences the way every other literal search does', async () => {
    // `aa` occurs once in `aaa`: the scan moves past what it matched.
    const id = await project('overlap', { 'src/a.ts': 'aaa\n' });

    expect((await search(id, 'aa')).meta).toMatchObject({ total: 1 });
  });

  it('is case-sensitive', async () => {
    const id = await project('case', {
      'src/a.ts': 'const UserRepository = 1;\nconst userRepository = 2;\n',
    });

    const upper = await search(id, 'UserRepository');
    expect(upper.meta).toMatchObject({ total: 1 });
    expect(upper.matches[0]?.line).toBe(1);

    const lower = await search(id, 'userRepository');
    expect(lower.meta).toMatchObject({ total: 1 });
    expect(lower.matches[0]?.line).toBe(2);
  });

  it('orders by file path, then line, then column', async () => {
    const id = await project('ordering', {
      'src/z.ts': 'x\n',
      'src/a.ts': 'x x\nx\n',
      'docs/a.md': 'x\n',
    });

    const { matches } = await search(id, 'x');

    expect(matches.map((match) => [match.filePath, match.line, match.column])).toEqual([
      ['docs/a.md', 1, 0],
      ['src/a.ts', 1, 0],
      ['src/a.ts', 1, 2],
      ['src/a.ts', 2, 0],
      ['src/z.ts', 1, 0],
    ]);
  });
});

describe('bounding the results', () => {
  it('returns at most the requested limit', async () => {
    const id = await project('limit', { 'src/a.ts': 'x\n'.repeat(10) });

    const { matches } = await search(id, 'x', { limit: '2' });

    expect(matches).toHaveLength(2);
  });

  it('reports the true total when results were cut', async () => {
    // The count keeps going after the page is full; the page does not.
    const id = await project('truncation', { 'src/a.ts': 'needle\n'.repeat(87) });

    const { matches, meta } = await search(id, 'needle', { limit: '20' });

    expect(matches).toHaveLength(20);
    expect(meta).toMatchObject({ total: 87, limit: 20, truncated: true });
  });

  it('reports no truncation when everything fits', async () => {
    const id = await project('no-truncation', { 'src/a.ts': 'needle\n'.repeat(3) });

    const { matches, meta } = await search(id, 'needle', { limit: '20' });

    expect(matches).toHaveLength(3);
    expect(meta).toMatchObject({ total: 3, truncated: false });
  });

  it('defaults to twenty', async () => {
    const id = await project('default-limit', { 'src/a.ts': 'x\n'.repeat(50) });

    const { matches, meta } = await search(id, 'x');

    expect(matches).toHaveLength(20);
    expect(meta).toMatchObject({ total: 50, limit: 20, truncated: true });
  });

  it('windows a very long line around the match rather than returning all of it', async () => {
    const id = await project('long-line', {
      'src/bundle.ts': `${'a'.repeat(5000)}NEEDLE${'b'.repeat(5000)}\n`,
    });

    const { matches } = await search(id, 'NEEDLE');

    expect(matches[0]?.lineTruncated).toBe(true);
    expect(matches[0]?.lineText.length).toBe(200);
    // The window follows the match, so the match is always visible in it.
    expect(matches[0]?.lineText).toContain('NEEDLE');
  });

  it('rejects a limit outside the permitted range', async () => {
    const id = await project('bad-limit', { 'src/a.ts': 'x\n' });

    expect((await search(id, 'x', { limit: '0' })).error?.code).toBe('VALIDATION_ERROR');
    expect((await search(id, 'x', { limit: '101' })).error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('which files are searched', () => {
  it('uses the project’s own ignore policy rather than a second one', async () => {
    const id = await project('ignored', {
      'src/match.ts': 'needle\n',
      'node_modules/pkg/match.ts': 'needle\n',
      'dist/match.js': 'needle\n',
      'build/match.js': 'needle\n',
      'coverage/match.js': 'needle\n',
      '.git/match.ts': 'needle\n',
      'package-lock.json': 'needle\n',
    });

    const { matches, meta } = await search(id, 'needle');

    expect(matches.map((match) => match.filePath)).toEqual(['src/match.ts']);
    expect(meta).toMatchObject({ total: 1 });
  });

  it('searches documents, configuration, schemas and SQL, not only code', async () => {
    const id = await project('categories', {
      'src/a.ts': 'needle\n',
      'README.md': 'needle\n',
      'config.yaml': 'needle\n',
      'openapi.yaml': 'needle\n',
      'migrations/001.sql': '-- needle\n',
    });

    const { matches } = await search(id, 'needle');

    expect(matches.map((match) => match.filePath).sort()).toEqual([
      'README.md',
      'config.yaml',
      'migrations/001.sql',
      'openapi.yaml',
      'src/a.ts',
    ]);
  });

  it('does not search binary files', async () => {
    const id = await project('binary', { 'src/a.ts': 'needle\n' });
    // A real PNG header followed by the search term as raw bytes.
    await writeFile(
      path.join(base, 'binary', 'logo.png'),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('needle')]),
    );

    const { matches } = await search(id, 'needle');

    expect(matches.map((match) => match.filePath)).toEqual(['src/a.ts']);
  });

  it('does not search generated or vendored code', async () => {
    const id = await project('generated', {
      'src/a.ts': 'needle\n',
      'src/api.generated.ts': 'needle\n',
    });

    const { matches } = await search(id, 'needle');

    expect(matches.map((match) => match.filePath)).toEqual(['src/a.ts']);
  });

  it('skips a file larger than source retrieval will read, and says so', async () => {
    const id = await project('huge', { 'src/small.ts': 'needle\n' });
    await writeFile(
      path.join(base, 'huge', 'src', 'big.ts'),
      `${'/'.repeat(4 * 1024 * 1024 + 10)}needle\n`,
    );

    const { matches, meta } = await search(id, 'needle');

    expect(matches.map((match) => match.filePath)).toEqual(['src/small.ts']);
    // Silently dropping it would make `total` a floor with nothing saying so.
    expect(meta).toMatchObject({ total: 1, filesSkipped: 1 });
  });
});

describe('literal semantics', () => {
  it('treats regular-expression metacharacters as text', async () => {
    const id = await project('regex-chars', {
      'src/a.ts': 'const value = obj.method(arg);\nconst other = objXmethodYargZ;\n',
    });

    // As a regex this would match both lines; as a literal it matches one.
    const { matches, meta } = await search(id, 'obj.method(arg)');

    expect(meta).toMatchObject({ total: 1 });
    expect(matches[0]?.line).toBe(1);
  });

  it.each([
    ['.', 'a.b'],
    ['/', 'src/user'],
    [':', 'key: value'],
    ['_', 'snake_case'],
    ['-', 'kebab-case'],
    ['(', 'call('],
    [')', 'call()'],
    ['[', 'list[0]'],
    [']', 'list[0]'],
    ['?', 'maybe?'],
    ['*', 'a*b'],
    ['$', '$variable'],
    ['|', 'a|b'],
    ['\\', 'a\\b'],
  ])('handles %s as a literal character', async (_label, needle) => {
    const id = await project(`literal-${Buffer.from(needle).toString('hex')}`, {
      'src/a.ts': `${needle}\n`,
    });

    const { meta } = await search(id, needle);

    expect(meta).toMatchObject({ total: 1 });
  });

  it('never lets a query act as a path', async () => {
    const id = await project('traversal', { 'src/a.ts': 'inside\n' });

    // The query is a search string, never joined to a path. Nothing escapes,
    // and nothing outside the project is read.
    for (const q of ['../../etc/passwd', '/etc/passwd', '..\\..\\windows']) {
      const { status, matches, meta } = await search(id, q);
      expect(status).toBe(200);
      expect(matches).toEqual([]);
      expect(meta).toMatchObject({ total: 0 });
    }
  });
});

describe('empty results', () => {
  it('is a successful answer', async () => {
    const id = await project('empty', { 'src/a.ts': 'something\n' });

    const { status, matches, meta, error } = await search(id, 'NoSuchStringAnywhere');

    expect(status).toBe(200);
    expect(error).toBeNull();
    expect(matches).toEqual([]);
    expect(meta).toMatchObject({ total: 0, truncated: false });
  });
});

describe('project isolation', () => {
  it('never returns another project’s files, in either direction', async () => {
    const a = await project('isolation-a', { 'src/a-only.ts': 'SharedName\n' });
    const b = await project('isolation-b', { 'src/b-only.ts': 'SharedName\n' });

    const inA = await search(a, 'SharedName');
    expect(inA.matches.map((match) => match.filePath)).toEqual(['src/a-only.ts']);
    expect(inA.meta).toMatchObject({ total: 1 });

    const inB = await search(b, 'SharedName');
    expect(inB.matches.map((match) => match.filePath)).toEqual(['src/b-only.ts']);
    expect(inB.meta).toMatchObject({ total: 1 });
  });

  it('cannot reach a sibling directory that shares a path prefix', async () => {
    const a = await project('sibling', { 'src/a.ts': 'inside\n' });
    await project('sibling-backup', { 'src/b.ts': 'inside\n' });

    const { matches } = await search(a, 'inside');

    expect(matches.map((match) => match.filePath)).toEqual(['src/a.ts']);
  });
});

describe('when the source cannot be searched', () => {
  it('reports an unknown project as PROJECT_NOT_FOUND', async () => {
    const { status, error } = await search('00000000-0000-4000-8000-000000000000', 'x');

    expect(status).toBe(404);
    expect(error?.code).toBe('PROJECT_NOT_FOUND');
  });

  it('rejects a malformed project id before reaching the service', async () => {
    expect((await search('not-a-uuid', 'x')).error?.code).toBe('VALIDATION_ERROR');
  });

  it('reports a project with no repository attached', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'no-repository' },
    });
    const id = (body<Project>(created).data as Project).id;

    expect((await search(id, 'x')).error?.code).toBe('REPOSITORY_NOT_FOUND');
  });

  it('refuses a git-backed project, whose clone no longer exists', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'git-backed' },
    });
    const id = (body<Project>(created).data as Project).id;
    await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/repository`,
      payload: { sourceType: 'git', sourcePath: 'https://github.com/example/app.git' },
    });

    const { status, error } = await search(id, 'x');

    expect(status).toBe(403);
    expect(error?.code).toBe('SOURCE_NOT_READABLE');
  });

  it('reports a repository whose directory has gone', async () => {
    const id = await project('vanishing', { 'src/a.ts': 'x\n' });
    await rm(path.join(base, 'vanishing'), { recursive: true, force: true });

    const { status, error } = await search(id, 'x');

    expect(status).toBe(404);
    expect(error?.code).toBe('REPOSITORY_PATH_NOT_FOUND');
  });

  it('rejects a missing or over-long query', async () => {
    const id = await project('bad-query', { 'src/a.ts': 'x\n' });

    const missing = await harness.app.inject({
      method: 'GET',
      url: `/api/projects/${id}/code/search`,
    });
    expect(missing.statusCode).toBe(400);

    expect((await search(id, 'x'.repeat(201))).error?.code).toBe('VALIDATION_ERROR');
    expect((await search(id, '')).error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('when local filesystem access is disabled', () => {
  it('refuses to search at all', async () => {
    const closed = await createHarness({
      filesystemEnabled: false,
      repositoryBaseDirectory: base,
    });

    try {
      const created = await closed.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'disabled' },
      });
      const id = (body<Project>(created).data as Project).id;

      const response = await closed.app.inject({
        method: 'GET',
        url: `/api/projects/${id}/code/search?q=x`,
      });

      expect(response.statusCode).toBe(403);
      expect(body(response).error?.code).toBe('FILESYSTEM_ACCESS_DISABLED');
    } finally {
      await closed.app.close();
    }
  });
});
