import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureSourceRevision, compareSourceRevision } from '../src/index.js';

/**
 * Freshness against real git and a real filesystem.
 *
 * Like the scanner suite next door, there is no pure core worth faking: the
 * whole question is what git and the filesystem say. Each case builds a
 * throwaway repository, captures it, changes something, and asks.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ckg-revision-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relative: string, contents: string, base: string = root): Promise<void> {
  const absolute = path.join(base, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } },
  ).trim();
}

async function repository(files: Record<string, string>): Promise<string> {
  git('init', '--quiet', '--initial-branch=main');
  for (const [relative, contents] of Object.entries(files)) await write(relative, contents);
  git('add', '-A');
  git('commit', '--quiet', '-m', 'initial');
  return git('rev-parse', 'HEAD');
}

describe('git working trees', () => {
  it('records HEAD and a clean tree', async () => {
    const head = await repository({ 'src/app.ts': 'export const a = 1;\n' });

    const revision = await captureSourceRevision(root);

    expect(revision).toMatchObject({ vcs: 'git', commit: head, changes: {}, changeCount: 0 });
  });

  it('is current when nothing changed', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n' });
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ vcs: 'git', stale: false, changedFiles: 0, changedPaths: [] });
  });

  it('is stale after an uncommitted edit', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n' });
    const revision = await captureSourceRevision(root);

    await write('src/app.ts', 'export const a = 2;\n');
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: true, changedFiles: 1, changedPaths: ['src/app.ts'] });
  });

  it('is stale after a new untracked file and after a deletion', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n', 'src/gone.ts': 'x\n' });
    const revision = await captureSourceRevision(root);

    await write('src/new.ts', 'export const n = 1;\n');
    await unlink(path.join(root, 'src/gone.ts'));
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({
      stale: true,
      changedFiles: 2,
      changedPaths: ['src/gone.ts', 'src/new.ts'],
    });
  });

  it('is stale after a new commit that changes files, and reports both commits', async () => {
    const indexed = await repository({ 'src/app.ts': 'export const a = 1;\n' });
    const revision = await captureSourceRevision(root);

    await write('src/app.ts', 'export const a = 2;\n');
    git('commit', '--quiet', '-am', 'change');
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison.stale).toBe(true);
    expect(comparison.changedFiles).toBe(1);
    expect(comparison.currentCommit).not.toBe(indexed);
    expect(comparison.reason).toContain(indexed.slice(0, 12));
  });

  it('indexing a dirty tree and then committing exactly that is still current', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n' });
    await write('src/app.ts', 'export const a = 2;\n');
    const revision = await captureSourceRevision(root);
    expect(revision.changeCount).toBe(1);

    git('commit', '--quiet', '-am', 'commit what was indexed');
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: false, changedFiles: 0 });
  });

  it('indexing a dirty tree and then editing that file again is stale', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n' });
    await write('src/app.ts', 'export const a = 2;\n');
    const revision = await captureSourceRevision(root);

    await write('src/app.ts', 'export const a = 3;\n');
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: true, changedFiles: 1, changedPaths: ['src/app.ts'] });
  });

  it('reverting an uncommitted edit makes it current again', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n' });
    const revision = await captureSourceRevision(root);

    await write('src/app.ts', 'export const a = 2;\n');
    expect((await compareSourceRevision(root, revision)).stale).toBe(true);

    await write('src/app.ts', 'export const a = 1;\n');
    expect((await compareSourceRevision(root, revision)).stale).toBe(false);
  });

  it('ignores paths the scanner never reads', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n' });
    const revision = await captureSourceRevision(root);

    await write('node_modules/lib/index.js', 'module.exports = 1;\n');
    await write('dist/app.js', 'var a = 1;\n');
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison.stale).toBe(false);
  });

  it('only sees its own subdirectory of a larger repository', async () => {
    await repository({ 'packages/a/src/a.ts': 'a\n', 'packages/b/src/b.ts': 'b\n' });
    const project = path.join(root, 'packages/a');
    const revision = await captureSourceRevision(project);

    await write('packages/b/src/b.ts', 'changed\n');
    git('commit', '--quiet', '-am', 'change a sibling');
    const unaffected = await compareSourceRevision(project, revision);
    expect(unaffected).toMatchObject({ stale: false, changedFiles: 0 });
    expect(unaffected.currentCommit).not.toBe(revision.commit);

    await write('packages/a/src/a.ts', 'changed\n');
    const affected = await compareSourceRevision(project, revision);
    expect(affected).toMatchObject({ stale: true, changedPaths: ['src/a.ts'] });
  });

  it('says the commit is gone rather than guessing when history was rewritten', async () => {
    await repository({ 'src/app.ts': 'a\n' });
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(root, {
      ...revision,
      commit: '0123456789abcdef0123456789abcdef01234567',
    });

    expect(comparison).toMatchObject({ stale: true, changedFiles: null });
    expect(comparison.reason).toMatch(/no longer in the local repository/);
  });

  it('falls back to the digest when a snapshot was too large to keep', async () => {
    await repository({ 'src/app.ts': 'a\n' });
    const revision = { ...(await captureSourceRevision(root)), changes: null };

    expect((await compareSourceRevision(root, revision)).stale).toBe(false);

    await write('src/app.ts', 'b\n');
    expect(await compareSourceRevision(root, revision)).toMatchObject({ stale: true, changedFiles: null });
  });

  it('treats a directory git ignores inside an enclosing repository as unversioned', async () => {
    await repository({ '.gitignore': 'scratch/\n', 'README.md': 'x\n' });
    await write('scratch/project/app.ts', 'a\n');

    const revision = await captureSourceRevision(path.join(root, 'scratch/project'));

    expect(revision).toMatchObject({ vcs: 'none', commit: null });
  });
});

describe('directories that are not git repositories', () => {
  it('records no commit, and invents none', async () => {
    await write('src/app.ts', 'a\n');

    const revision = await captureSourceRevision(root);

    expect(revision).toMatchObject({ vcs: 'none', commit: null, changes: null, digest: null });
  });

  it('is current when nothing was modified after capture', async () => {
    await write('src/app.ts', 'a\n');
    const revision = await captureSourceRevision(root, { now: () => Date.now() + 5_000 });

    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ vcs: 'none', currentCommit: null, stale: false, changedFiles: 0 });
  });

  it('is stale when a file was modified after capture', async () => {
    await write('src/app.ts', 'a\n');
    await write('src/other.ts', 'b\n');
    const capturedAt = Date.now() + 5_000;
    const revision = await captureSourceRevision(root, { now: () => capturedAt });

    const later = new Date(capturedAt + 5_000);
    await utimes(path.join(root, 'src/app.ts'), later, later);
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: true, changedFiles: 1, changedPaths: ['src/app.ts'] });
  });

  it('is stale when a file was deleted, although no file is left to count', async () => {
    await write('src/app.ts', 'a\n');
    await write('src/gone.ts', 'b\n');
    const capturedAt = Date.now() + 5_000;
    const revision = await captureSourceRevision(root, { now: () => capturedAt });

    await unlink(path.join(root, 'src/gone.ts'));
    const later = new Date(capturedAt + 5_000);
    await utimes(path.join(root, 'src'), later, later);
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: true, changedFiles: null });
  });

  it('says so when the directory is gone', async () => {
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(path.join(root, 'missing'), revision);

    expect(comparison).toMatchObject({ stale: null, changedFiles: null });
  });
});
