import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexFreshness, IndexProjectResult } from '@ckg/shared';
import { captureSourceRevision } from '@ckg/language-detection';
import { body, createHarness, type Harness } from './helpers/harness.js';

/**
 * The agent's way in: index a directory in one call, and ask whether the
 * stored graph still matches the files.
 *
 * Run against a real git repository on disk, because the decisions under test
 * — is this the same project, is its graph current — are answered by the real
 * filesystem and the real git, and a fake of either would be testing the fake.
 * The worker is the one thing not present: a run is "completed" by the test,
 * with the revision the worker would have recorded.
 */

let harness: Harness;
let repo: string;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(tmpdir(), 'ckg-index-')));
  git('init', '--quiet', '--initial-branch=main');
  await write('package.json', '{"name":"sample"}\n');
  await write('src/app.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'initial');
});

afterEach(async () => {
  await harness.app.close();
  await rm(repo, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8' },
  ).trim();
}

async function write(relative: string, contents: string): Promise<void> {
  const absolute = path.join(repo, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

async function indexProject(payload: Record<string, unknown>) {
  const response = await harness.app.inject({ method: 'POST', url: '/api/projects/index', payload });
  return { status: response.statusCode, envelope: body<IndexProjectResult>(response) };
}

async function freshnessOf(projectId: string) {
  const response = await harness.app.inject({ method: 'GET', url: `/api/projects/${projectId}/freshness` });
  return { status: response.statusCode, envelope: body<IndexFreshness>(response) };
}

/**
 * Makes one store lookup take a while, so concurrent requests all make their
 * check before any of them acts — the window a real database round trip opens.
 */
function slowDown<T extends object>(store: T, method: keyof T & string): void {
  const original = (store[method] as (...args: unknown[]) => Promise<unknown>).bind(store);
  (store as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    const result = await original(...args);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return result;
  };
}

/** What the worker does at the end of a run: mark it completed and record what it saw. */
async function completeWithRevision(jobId: string): Promise<void> {
  harness.analyses.revisions.set(jobId, await captureSourceRevision(repo));
  harness.analyses.complete(jobId);
}

describe('POST /api/projects/index', () => {
  it('registers a directory seen for the first time and queues its first run', async () => {
    harness = await createHarness({ canonicalizePaths: true });

    const { status, envelope } = await indexProject({ path: repo });

    expect(status).toBe(202);
    expect(envelope.data).toMatchObject({
      action: 'started',
      projectCreated: true,
      jobCreated: true,
      projectName: path.basename(repo),
      repositoryRoot: repo,
      job: { status: 'QUEUED' },
    });

    // Through the existing stores, exactly as the UI's three calls would leave them.
    const projectId = envelope.data?.projectId ?? '';
    expect(harness.repositories.byProject.get(projectId)).toMatchObject({
      sourceType: 'local',
      sourcePath: repo,
    });
    expect([...harness.analyses.jobs.values()]).toHaveLength(1);
  });

  it('returns the active run instead of queuing a second one', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const first = await indexProject({ path: repo });

    const second = await indexProject({ path: repo });

    expect(second.status).toBe(200);
    expect(second.envelope.data).toMatchObject({
      action: 'already_indexing',
      projectCreated: false,
      jobCreated: false,
      projectId: first.envelope.data?.projectId,
      job: { id: first.envelope.data?.job?.id },
    });
    expect([...harness.analyses.jobs.values()]).toHaveLength(1);
  });

  it('does nothing when the stored graph already matches the files', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const first = await indexProject({ path: repo });
    await completeWithRevision(first.envelope.data?.job?.id ?? '');

    const again = await indexProject({ path: repo });

    expect(again.status).toBe(200);
    expect(again.envelope.data).toMatchObject({
      action: 'up_to_date',
      jobCreated: false,
      job: null,
      freshness: { state: 'current' },
    });
    expect([...harness.analyses.jobs.values()]).toHaveLength(1);
  });

  it('re-indexes the same project when its graph is stale', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const first = await indexProject({ path: repo });
    await completeWithRevision(first.envelope.data?.job?.id ?? '');

    await write('src/app.ts', 'export const a = 2;\n');
    const again = await indexProject({ path: repo });

    expect(again.status).toBe(202);
    expect(again.envelope.data).toMatchObject({
      action: 'started',
      projectCreated: false,
      jobCreated: true,
      projectId: first.envelope.data?.projectId,
      freshness: { state: 'stale', changedFiles: 1, changedPaths: ['src/app.ts'] },
    });
    expect(harness.projects.projects.size).toBe(1);
  });

  it('re-indexes a current graph only when forced', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const first = await indexProject({ path: repo });
    await completeWithRevision(first.envelope.data?.job?.id ?? '');

    const forced = await indexProject({ path: repo, force: true });

    expect(forced.status).toBe(202);
    expect(forced.envelope.data).toMatchObject({ action: 'started', jobCreated: true });
  });

  it('re-indexes a project whose last run failed', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const first = await indexProject({ path: repo });
    harness.analyses.complete(first.envelope.data?.job?.id ?? '', 'FAILED');

    const again = await indexProject({ path: repo });

    expect(again.envelope.data).toMatchObject({ action: 'started', freshness: { state: 'not_indexed' } });
  });

  it('closes the race between two requests: the loser gets the winner’s run', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const first = await indexProject({ path: repo });
    await completeWithRevision(first.envelope.data?.job?.id ?? '');
    await write('src/app.ts', 'changed\n');

    // Another request queued a run between this one's check and its enqueue.
    const original = harness.analyses.findActiveByProject.bind(harness.analyses);
    let calls = 0;
    harness.analyses.findActiveByProject = async (projectId: string) => {
      calls += 1;
      if (calls === 1) {
        await harness.analyses.create({ projectId, repositoryId: randomUUID() });
        return null;
      }
      return original(projectId);
    };

    const loser = await indexProject({ path: repo });

    expect(loser.envelope.data).toMatchObject({ action: 'already_indexing', jobCreated: false });
    expect([...harness.analyses.jobs.values()].filter((job) => job.status === 'QUEUED')).toHaveLength(1);
  });

  it('registers once and queues once when first-time requests arrive together', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    slowDown(harness.repositories, 'listAll');

    const results = await Promise.all([1, 2, 3, 4].map(() => indexProject({ path: repo })));

    expect(harness.projects.projects.size).toBe(1);
    expect([...harness.analyses.jobs.values()]).toHaveLength(1);
    const data = results.map((result) => result.envelope.data);
    expect(new Set(data.map((result) => result?.projectId)).size).toBe(1);
    expect(data.filter((result) => result?.projectCreated)).toHaveLength(1);
    expect(data.filter((result) => result?.action === 'already_indexing')).toHaveLength(3);
  });

  it('queues one re-index when stale requests arrive together', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const first = await indexProject({ path: repo });
    await completeWithRevision(first.envelope.data?.job?.id ?? '');
    await write('src/app.ts', 'export const a = 2;\n');
    slowDown(harness.analyses, 'findActiveByProject');

    const results = await Promise.all([1, 2, 3].map(() => indexProject({ path: repo })));

    expect(results.filter((result) => result.envelope.data?.jobCreated)).toHaveLength(1);
    expect([...harness.analyses.jobs.values()].filter((job) => job.status === 'QUEUED')).toHaveLength(1);
  });

  it('undoes the registration when the run cannot be queued', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    harness.analyses.create = async () => {
      throw new Error('database unavailable');
    };

    const { status, envelope } = await indexProject({ path: repo });

    expect(status).toBe(500);
    expect(envelope.success).toBe(false);
    expect(harness.projects.projects.size).toBe(0);
  });

  it.each([
    ['a relative path', 'src', 400, 'INVALID_PROJECT_PATH'],
    ['a git URL', 'https://github.com/example/repo.git', 400, 'INVALID_PROJECT_PATH'],
  ])('refuses %s', async (_label, requested, expectedStatus, code) => {
    harness = await createHarness({ canonicalizePaths: true });

    const { status, envelope } = await indexProject({ path: requested });

    expect(status).toBe(expectedStatus);
    expect(envelope.error?.code).toBe(code);
    expect(harness.projects.projects.size).toBe(0);
  });

  it('refuses a directory that does not exist', async () => {
    harness = await createHarness({ canonicalizePaths: true });

    const { status, envelope } = await indexProject({ path: path.join(repo, 'missing') });

    expect(status).toBe(404);
    expect(envelope.error?.code).toBe('DIRECTORY_NOT_FOUND');
  });

  it('refuses a file', async () => {
    harness = await createHarness({ canonicalizePaths: true });

    const { status, envelope } = await indexProject({ path: path.join(repo, 'package.json') });

    expect(status).toBe(400);
    expect(envelope.error?.code).toBe('INVALID_PROJECT_PATH');
  });

  it('refuses everything when local filesystem access is off', async () => {
    harness = await createHarness({ canonicalizePaths: true, filesystemEnabled: false });

    const { status, envelope } = await indexProject({ path: repo });

    expect(status).toBe(403);
    expect(envelope.error?.code).toBe('FILESYSTEM_ACCESS_DISABLED');
  });
});

describe('GET /api/projects/:projectId/freshness', () => {
  async function registered(): Promise<{ projectId: string; jobId: string }> {
    const { envelope } = await indexProject({ path: repo });
    return { projectId: envelope.data?.projectId ?? '', jobId: envelope.data?.job?.id ?? '' };
  }

  it('reports not_indexed before any run completes', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId } = await registered();

    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({ state: 'not_indexed', analysisId: null });
  });

  it('reports current, with the indexed commit, when nothing changed', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);
    const head = git('rev-parse', 'HEAD');

    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({
      state: 'current',
      analysisId: jobId,
      vcs: 'git',
      indexedCommit: head,
      currentCommit: head,
      changedFiles: 0,
    });
  });

  it('reports stale after an uncommitted edit, naming the file', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);

    await write('src/app.ts', 'export const a = 3;\n');
    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({ state: 'stale', changedFiles: 1, changedPaths: ['src/app.ts'] });
  });

  it('reports stale for working-tree changes at the same commit, by kind', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    await write('src/gone.ts', 'export const g = 1;\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'add gone');
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);
    const head = git('rev-parse', 'HEAD');

    await write('src/app.ts', 'export const a = 2;\n');
    await write('src/new-feature.ts', 'export const n = 1;\n');
    await rm(path.join(repo, 'src/gone.ts'));
    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({
      state: 'stale',
      indexedCommit: head,
      currentCommit: head,
      changedFiles: 3,
      changedPaths: ['src/app.ts', 'src/gone.ts', 'src/new-feature.ts'],
      changes: { added: ['src/new-feature.ts'], modified: ['src/app.ts'], deleted: ['src/gone.ts'] },
    });
  });

  it('is current again after the working-tree change is reverted', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);

    await write('src/app.ts', 'export const a = 2;\n');
    expect((await freshnessOf(projectId)).envelope.data?.state).toBe('stale');

    git('checkout', '--', 'src/app.ts');
    expect((await freshnessOf(projectId)).envelope.data).toMatchObject({ state: 'current', changedFiles: 0 });
  });

  it('stays current when only ignored or non-indexed files change', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    await write('.gitignore', 'scratch.log\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'ignore');
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);

    await write('scratch.log', 'noise\n');
    await write('node_modules/dep/index.js', 'module.exports = 1;\n');
    await write('dist/app.js', 'var a = 1;\n');
    await write('package-lock.json', '{}\n');

    expect((await freshnessOf(projectId)).envelope.data).toMatchObject({ state: 'current', changedFiles: 0 });
  });

  it('is unknown, not current, for a run recorded before source manifests', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    const { manifest: _manifest, ...legacy } = await captureSourceRevision(repo);
    harness.analyses.revisions.set(jobId, legacy);
    harness.analyses.complete(jobId);

    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({ state: 'unknown', analysisId: jobId });
    expect(envelope.data?.reason).toMatch(/re-index once/);
  });

  it('never queues a run, however many status checks arrive together', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);
    await write('src/app.ts', 'export const a = 2;\n');

    const results = await Promise.all(Array.from({ length: 8 }, () => freshnessOf(projectId)));

    expect(results.every((result) => result.envelope.data?.state === 'stale')).toBe(true);
    expect(harness.analyses.jobs.size).toBe(1);
  });

  it('reports stale after a commit, with both commits', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);
    const indexed = git('rev-parse', 'HEAD');

    await write('src/new.ts', 'export const n = 1;\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'add');
    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({ state: 'stale', indexedCommit: indexed, changedFiles: 1 });
    expect(envelope.data?.currentCommit).not.toBe(indexed);
  });

  it('compares against the last completed run while a newer one is in flight', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);
    await write('src/app.ts', 'changed\n');
    await indexProject({ path: repo });

    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({ state: 'stale', analysisId: jobId });
  });

  it('is unknown, and says why, for a run recorded before revisions were captured', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    harness.analyses.complete(jobId);

    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({ state: 'unknown', analysisId: jobId });
    expect(envelope.data?.reason).toMatch(/re-index/i);
  });

  it('is unknown for a project indexed from a git URL', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const project = await harness.projects.create({ name: 'remote' });
    const repository = await harness.repositories.upsert({
      projectId: project.id,
      sourceType: 'git',
      sourcePath: 'https://example.com/repo.git',
    });
    const job = await harness.analyses.create({ projectId: project.id, repositoryId: repository.id });
    harness.analyses.revisions.set(job.id, {
      vcs: 'git',
      commit: 'abc123abc123abc123abc123abc123abc123abcd',
      changes: {},
      changeCount: 0,
      digest: 'd',
      capturedAt: new Date().toISOString(),
    });
    harness.analyses.complete(job.id);

    const { envelope } = await freshnessOf(project.id);

    expect(envelope.data).toMatchObject({
      state: 'unknown',
      indexedCommit: 'abc123abc123abc123abc123abc123abc123abcd',
      currentCommit: null,
    });
    expect(envelope.data?.reason).toMatch(/git URL/);
  });

  it('is unknown when local filesystem access is off', async () => {
    harness = await createHarness({ canonicalizePaths: true });
    const { projectId, jobId } = await registered();
    await completeWithRevision(jobId);
    await harness.app.close();

    // Same stores, new app with the switch off.
    const stores = harness;
    harness = await createHarness({ canonicalizePaths: true, filesystemEnabled: false });
    harness.projects.projects = stores.projects.projects;
    harness.repositories.byProject.set(projectId, stores.repositories.byProject.get(projectId)!);
    for (const [id, job] of stores.analyses.jobs) harness.analyses.jobs.set(id, job);
    for (const [id, revision] of stores.analyses.revisions) harness.analyses.revisions.set(id, revision);

    const { envelope } = await freshnessOf(projectId);

    expect(envelope.data).toMatchObject({ state: 'unknown' });
    expect(envelope.data?.reason).toMatch(/disabled/);
  });

  it('is a 404 for a project that does not exist', async () => {
    harness = await createHarness({ canonicalizePaths: true });

    const { status, envelope } = await freshnessOf('00000000-0000-4000-8000-000000000000');

    expect(status).toBe(404);
    expect(envelope.error?.code).toBe('PROJECT_NOT_FOUND');
  });
});
