import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Project, ProjectResolution } from '@ckg/shared';
import {
  containmentOf,
  resolveRequestedPath,
} from '../src/modules/projects/project-path.js';
import { body, createHarness, sampleGraph, WORKSPACE_ROOT, type Harness } from './helpers/harness.js';

/**
 * Resolving a directory back to the projects indexed from it.
 *
 * This is the entry point for anything that holds a working directory rather
 * than a project id, so the cases that matter are the ones where a wrong answer
 * would be confidently wrong: a sibling directory that merely shares a prefix,
 * a monorepo where two projects both legitimately cover a path, and a git
 * source whose `sourcePath` is a URL that must never be treated as a directory.
 */

describe('project path containment', () => {
  it('matches a root against itself', () => {
    expect(containmentOf('/srv/app', '/srv/app')).toEqual({
      root: '/srv/app',
      relativePath: '',
      exact: true,
    });
  });

  it('reports where a path sits inside a root', () => {
    expect(containmentOf('/srv/app', '/srv/app/src/services')).toEqual({
      root: '/srv/app',
      relativePath: 'src/services',
      exact: false,
    });
  });

  it('does not match a sibling that only shares a prefix', () => {
    // The whole reason containment compares against `root + separator`: without
    // it, every backup and every `-old` copy of a repository would resolve to
    // the repository.
    expect(containmentOf('/srv/app', '/srv/app-backup')).toBeNull();
    expect(containmentOf('/srv/app', '/srv/application/src')).toBeNull();
  });

  it('does not match a parent of the root', () => {
    expect(containmentOf('/srv/app', '/srv')).toBeNull();
  });

  it('handles a root that already ends in a separator', () => {
    expect(containmentOf(path.sep, path.join(path.sep, 'srv'))).toEqual({
      root: path.sep,
      relativePath: 'srv',
      exact: false,
    });
  });
});

describe('requested path normalisation', () => {
  it('resolves a relative path against the repository base directory', () => {
    expect(resolveRequestedPath('test-repositories/sample', '/base')).toBe(
      path.resolve('/base', 'test-repositories/sample'),
    );
  });

  it('leaves an absolute path absolute', () => {
    expect(resolveRequestedPath(path.resolve('/srv/app'), '/base')).toBe(path.resolve('/srv/app'));
  });

  it('normalises away `.` and `..`', () => {
    expect(resolveRequestedPath('/srv/app/../app/./src', '/base')).toBe(
      path.resolve('/srv/app/src'),
    );
  });

  it('rejects a NUL byte rather than letting it reach a syscall', () => {
    expect(() => resolveRequestedPath('/srv/app\u0000/etc/passwd', '/base')).toThrowError(
      /NUL byte/,
    );
  });

  it('rejects a path that is only whitespace', () => {
    expect(() => resolveRequestedPath('   ', '/base')).toThrowError(/path is required/);
  });
});

describe('GET /api/projects/resolve', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.app.close();
  });

  afterEach(() => {
    // Every test names its own repository roots, so state between them would
    // only ever produce a match a test did not ask for.
    harness.projects.projects.clear();
    harness.repositories.byProject.clear();
  });

  async function seed(
    name: string,
    sourcePath: string,
    options: { sourceType?: 'local' | 'git'; withGraph?: boolean } = {},
  ): Promise<string> {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name },
    });
    const projectId = (body<Project>(created).data as Project).id;

    await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/repository`,
      payload: { sourceType: options.sourceType ?? 'local', sourcePath },
    });

    if (options.withGraph ?? false) harness.graph.setGraph(sampleGraph(projectId));

    return projectId;
  }

  async function resolve(requested: string): Promise<{
    statusCode: number;
    data: ProjectResolution | null;
    error: { code: string } | null;
    meta: Record<string, unknown>;
  }> {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/projects/resolve?path=${encodeURIComponent(requested)}`,
    });
    const payload = body<ProjectResolution>(response);
    return {
      statusCode: response.statusCode,
      data: payload.data,
      error: payload.error,
      meta: payload.meta,
    };
  }

  it('resolves a repository root to its project', async () => {
    const projectId = await seed('root-match', '/srv/app');

    const { statusCode, data } = await resolve('/srv/app');

    expect(statusCode).toBe(200);
    expect(data?.path).toBe(path.resolve('/srv/app'));
    expect(data?.matches).toHaveLength(1);
    expect(data?.matches[0]).toMatchObject({
      repositoryRoot: path.resolve('/srv/app'),
      relativePath: '',
      exact: true,
    });
    expect(data?.matches[0]?.project.id).toBe(projectId);
  });

  it('resolves a directory inside the repository and says where it sits', async () => {
    await seed('inner', '/srv/app');

    const { data } = await resolve('/srv/app/src/services');

    expect(data?.matches[0]).toMatchObject({
      repositoryRoot: path.resolve('/srv/app'),
      relativePath: 'src/services',
      exact: false,
    });
  });

  it('resolves a file path, not just a directory', async () => {
    await seed('file', '/srv/app');

    const { data } = await resolve('/srv/app/src/user.service.ts');

    expect(data?.matches[0]?.relativePath).toBe('src/user.service.ts');
  });

  it('carries the graph size and last run on each match', async () => {
    const projectId = await seed('sized', '/srv/sized', { withGraph: true });
    await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/analysis`,
      payload: {},
    });

    const { data } = await resolve('/srv/sized');

    // The whole point of returning the summary: a caller can tell a usable
    // project from one that was created and never indexed without asking again.
    expect(data?.matches[0]?.project).toMatchObject({
      id: projectId,
      nodeCount: 5,
      edgeCount: 4,
      repository: { sourceType: 'local', sourcePath: '/srv/sized' },
    });
    expect(data?.matches[0]?.project.latestAnalysis?.status).toBe('QUEUED');
  });

  it('answers a path nothing covers with an empty list and a 200', async () => {
    await seed('elsewhere', '/srv/app');

    const { statusCode, data, error, meta } = await resolve('/home/someone/scratch');

    expect(statusCode).toBe(200);
    expect(error).toBeNull();
    expect(data?.matches).toEqual([]);
    expect(meta).toMatchObject({ total: 0 });
  });

  it('returns both projects when a monorepo nests one inside the other, most specific first', async () => {
    const outer = await seed('monorepo', '/srv/mono');
    const inner = await seed('package', '/srv/mono/packages/api');

    const { data } = await resolve('/srv/mono/packages/api/src');

    expect(data?.matches).toHaveLength(2);
    expect(data?.matches.map((match) => match.project.id)).toEqual([inner, outer]);
    expect(data?.matches.map((match) => match.relativePath)).toEqual([
      'src',
      'packages/api/src',
    ]);
  });

  it('matches only the outer project for a path the inner one does not cover', async () => {
    const outer = await seed('monorepo', '/srv/mono');
    await seed('package', '/srv/mono/packages/api');

    const { data } = await resolve('/srv/mono/packages/web/src');

    expect(data?.matches).toHaveLength(1);
    expect(data?.matches[0]?.project.id).toBe(outer);
  });

  it('does not match a sibling directory that shares a prefix', async () => {
    await seed('app', '/srv/app');

    expect((await resolve('/srv/app-backup')).data?.matches).toEqual([]);
    expect((await resolve('/srv/app-backup/src')).data?.matches).toEqual([]);
  });

  it('never matches a git repository, whose source path is a URL', async () => {
    await seed('cloned', 'https://github.com/example/app.git', { sourceType: 'git' });

    expect((await resolve('https://github.com/example/app.git')).data?.matches).toEqual([]);
    expect((await resolve('/srv/app')).data?.matches).toEqual([]);
  });

  it('ignores a project that has no repository attached', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'no-repository' },
    });

    expect((await resolve('/srv/app')).data?.matches).toEqual([]);
  });

  it('resolves a stored relative source path the same way the worker does', async () => {
    // The bundled samples are registered relative to the workspace root, so a
    // caller may name either form and must get the same project.
    const projectId = await seed('sample', 'test-repositories/typescript-sample');
    const absolute = path.join(WORKSPACE_ROOT, 'test-repositories/typescript-sample');

    expect((await resolve('test-repositories/typescript-sample')).data?.matches[0]?.project.id).toBe(
      projectId,
    );
    expect((await resolve(absolute)).data?.matches[0]?.project.id).toBe(projectId);
    expect((await resolve(path.join(absolute, 'src/services'))).data?.matches[0]).toMatchObject({
      relativePath: 'src/services',
    });
  });

  it('normalises `..` before matching', async () => {
    await seed('dots', '/srv/app');

    const { data } = await resolve('/srv/app/src/../src/services');

    expect(data?.matches[0]?.relativePath).toBe('src/services');
  });

  it('orders two projects indexed from the same root deterministically', async () => {
    const first = await seed('first', '/srv/same');
    const second = await seed('second', '/srv/same');

    const { data } = await resolve('/srv/same');
    const again = await resolve('/srv/same');

    expect(data?.matches).toHaveLength(2);
    expect(data?.matches.map((match) => match.project.id)).toEqual(
      again.data?.matches.map((match) => match.project.id),
    );
    expect(data?.matches.map((match) => match.project.id).sort()).toEqual([first, second].sort());
  });

  it('rejects a missing path before reaching the service', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/projects/resolve' });

    expect(response.statusCode).toBe(400);
    expect(body(response).error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a NUL byte in the path', async () => {
    const { statusCode, error } = await resolve('/srv/app\u0000/etc/passwd');

    expect(statusCode).toBe(400);
    expect(error?.code).toBe('VALIDATION_ERROR');
  });

  it('does not read the path, so a directory that does not exist still resolves', async () => {
    await seed('gone', '/srv/deleted-since-indexing');

    const { data } = await resolve('/srv/deleted-since-indexing/src');

    expect(data?.matches).toHaveLength(1);
    expect(data?.matches[0]?.relativePath).toBe('src');
  });

  it('is not shadowed by the :projectId route it shares a prefix with', async () => {
    // `resolve` is not a uuid, so reaching `/projects/:projectId` would produce
    // a validation error rather than a resolution.
    const { statusCode } = await resolve('/srv/anything');

    expect(statusCode).toBe(200);
  });
});

describe('GET /api/projects/resolve with symlinks resolved', () => {
  let harness: Harness;
  let root: string;

  beforeAll(async () => {
    harness = await createHarness({ canonicalizePaths: true });
    // `realpath` because macOS puts the temp directory behind its own symlink,
    // which would otherwise make this test pass for the wrong reason.
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'ckg-resolve-')));
  });

  afterAll(async () => {
    await harness.app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('matches a path reached through a symlink to the repository root', async () => {
    const real = path.join(root, 'real-project');
    const linked = path.join(root, 'linked-project');
    await mkdir(path.join(real, 'src'), { recursive: true });
    await symlink(real, linked, 'dir');

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'symlinked' },
    });
    const projectId = (body<Project>(created).data as Project).id;
    await harness.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/repository`,
      // Registered by its real path; asked about by the link.
      payload: { sourceType: 'local', sourcePath: real },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/projects/resolve?path=${encodeURIComponent(path.join(linked, 'src'))}`,
    });
    const resolution = body<ProjectResolution>(response).data;

    expect(response.statusCode).toBe(200);
    expect(resolution?.matches).toHaveLength(1);
    expect(resolution?.matches[0]).toMatchObject({
      repositoryRoot: real,
      relativePath: 'src',
    });
  });
});
