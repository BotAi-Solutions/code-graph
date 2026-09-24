import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceRevision } from '@ckg/shared';
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

  it('indexing a dirty tree and then committing exactly that is stale on the commit alone', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n' });
    await write('src/app.ts', 'export const a = 2;\n');
    const revision = await captureSourceRevision(root);
    expect(revision.changeCount).toBe(1);

    git('commit', '--quiet', '-am', 'commit what was indexed');
    const comparison = await compareSourceRevision(root, revision);

    // HEAD moved, so the graph is stale; the reason says no file differs.
    expect(comparison).toMatchObject({ stale: true, changedFiles: 0, changedPaths: [] });
    expect(comparison.reason).toMatch(/HEAD moved/);
    expect(comparison.reason).toMatch(/No indexed source file differs in content/);
  });

  it('is current for a dirty tree that is still exactly as it was indexed', async () => {
    await repository({ 'src/app.ts': 'export const a = 1;\n', 'src/gone.ts': 'x\n' });
    await write('src/app.ts', 'export const a = 2;\n');
    await unlink(path.join(root, 'src/gone.ts'));
    await write('src/new.ts', 'export const n = 1;\n');
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: false, changedFiles: 0, currentCommit: revision.commit });
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
    const sibling = await compareSourceRevision(project, revision);
    expect(sibling).toMatchObject({ stale: false, changedFiles: 0 });

    await write('packages/a/src/a.ts', 'changed\n');
    const affected = await compareSourceRevision(project, revision);
    expect(affected).toMatchObject({ stale: true, changedPaths: ['src/a.ts'] });
  });

  it('still counts file changes when the indexed commit is gone from history', async () => {
    await repository({ 'src/app.ts': 'a\n' });
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(root, {
      ...revision,
      commit: '0123456789abcdef0123456789abcdef01234567',
    });

    // The manifest does not need the old commit: only HEAD differs.
    expect(comparison).toMatchObject({ stale: true, changedFiles: 0 });
    expect(comparison.reason).toMatch(/HEAD moved from 0123456789ab/);
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

  it('is current when nothing changed', async () => {
    await write('src/app.ts', 'a\n');
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ vcs: 'none', currentCommit: null, stale: false, changedFiles: 0 });
  });

  it('compares content, not modification times', async () => {
    await write('src/app.ts', 'a\n');
    await write('src/other.ts', 'b\n');
    const revision = await captureSourceRevision(root);

    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(root, 'src/app.ts'), later, later);
    expect(await compareSourceRevision(root, revision)).toMatchObject({ stale: false, changedFiles: 0 });

    await write('src/app.ts', 'changed\n');
    expect(await compareSourceRevision(root, revision)).toMatchObject({
      stale: true,
      changedFiles: 1,
      changedPaths: ['src/app.ts'],
      changes: { added: [], modified: ['src/app.ts'], deleted: [] },
    });
  });

  it('names a deleted file', async () => {
    await write('src/app.ts', 'a\n');
    await write('src/gone.ts', 'b\n');
    const revision = await captureSourceRevision(root);

    await unlink(path.join(root, 'src/gone.ts'));
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: true, changedFiles: 1, changes: { deleted: ['src/gone.ts'] } });
  });

  it('says so when the directory is gone', async () => {
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(path.join(root, 'missing'), revision);

    expect(comparison).toMatchObject({ stale: null, changedFiles: null });
  });
});

describe('the source manifest', () => {
  it('covers exactly the files the pipeline reads, by content', async () => {
    await repository({
      'src/app.ts': 'export const a = 1;\n',
      'README.md': '# app\n',
      'public/logo.png': 'png',
      'package-lock.json': '{}\n',
      '.env': 'SECRET=hunter2\n',
    });

    const { manifest } = await captureSourceRevision(root);

    expect(Object.keys(manifest?.files ?? {})).toEqual(['.env', 'README.md', 'src/app.ts']);
    expect(manifest?.files['src/app.ts']).toMatch(/^[0-9a-f]{64}$/);
    // A live .env is watched for presence only; its contents are never hashed.
    expect(manifest?.files['.env']).toBe('secret');
  });

  it('is deterministic', async () => {
    await repository({ 'src/b.ts': 'b\n', 'src/a.ts': 'a\n' });

    const first = await captureSourceRevision(root);
    const second = await captureSourceRevision(root);

    expect(second.manifest?.digest).toBe(first.manifest?.digest);
    expect(second.manifest).toEqual(first.manifest);
  });

  it('reports each kind of change by kind', async () => {
    await repository({ 'src/routes.tsx': 'a\n', 'src/career/foo.ts': 'f\n' });
    const revision = await captureSourceRevision(root);

    await write('src/routes.tsx', 'b\n');
    await unlink(path.join(root, 'src/career/foo.ts'));
    await write('src/new-feature.ts', 'n\n');
    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({
      stale: true,
      changedFiles: 3,
      changedPaths: ['src/career/foo.ts', 'src/new-feature.ts', 'src/routes.tsx'],
      changes: { added: ['src/new-feature.ts'], modified: ['src/routes.tsx'], deleted: ['src/career/foo.ts'] },
    });
  });

  it('ignores gitignored files the pipeline does not read, but watches gitignored files it does', async () => {
    await repository({ '.gitignore': 'notes.txt\nsrc/generated/\n', 'src/app.ts': 'a\n' });
    await write('notes.txt', 'draft\n');
    await write('src/generated/client.ts', 'export const v = 1;\n');
    const revision = await captureSourceRevision(root);

    // An ignored, non-source file: invisible to git and never read by the indexer.
    await write('notes.txt', 'draft 2\n');
    expect((await compareSourceRevision(root, revision)).stale).toBe(false);

    // A gitignored source file the scanner reads anyway: git cannot see this edit.
    await write('src/generated/client.ts', 'export const v = 2;\n');
    expect(await compareSourceRevision(root, revision)).toMatchObject({
      stale: true,
      changedPaths: ['src/generated/client.ts'],
    });
  });

  it('ignores lockfiles, node_modules and build output even when tracked', async () => {
    await repository({
      'src/app.ts': 'a\n',
      'package-lock.json': '{}\n',
      'node_modules/lib/index.js': 'x\n',
      'dist/app.js': 'x\n',
      'build/out.js': 'x\n',
    });
    const revision = await captureSourceRevision(root);

    await write('package-lock.json', '{"v":2}\n');
    await write('node_modules/lib/index.js', 'y\n');
    await write('node_modules/new/index.js', 'y\n');
    await write('dist/app.js', 'y\n');
    await write('build/out.js', 'y\n');

    expect(await compareSourceRevision(root, revision)).toMatchObject({ stale: false, changedFiles: 0 });
  });

  it('is stale when HEAD moved, and when both HEAD and files changed says both', async () => {
    const indexed = await repository({ 'src/app.ts': 'a\n', 'docs.txt': 'x\n' });
    const revision = await captureSourceRevision(root);

    await write('docs.txt', 'y\n');
    git('commit', '--quiet', '-am', 'non-source change');
    const moved = await compareSourceRevision(root, revision);
    expect(moved).toMatchObject({ stale: true, changedFiles: 0 });
    expect(moved.currentCommit).not.toBe(indexed);

    await write('src/app.ts', 'b\n');
    const both = await compareSourceRevision(root, revision);
    expect(both).toMatchObject({ stale: true, changedFiles: 1 });
    expect(both.reason).toMatch(/1 modified/);
    expect(both.reason).toMatch(/HEAD moved/);
  });

  it('is current again once a deletion is restored', async () => {
    await repository({ 'src/app.ts': 'a\n', 'src/keep.ts': 'k\n' });
    const revision = await captureSourceRevision(root);

    await unlink(path.join(root, 'src/keep.ts'));
    expect((await compareSourceRevision(root, revision)).stale).toBe(true);

    git('checkout', '--', 'src/keep.ts');
    expect(await compareSourceRevision(root, revision)).toMatchObject({ stale: false, changedFiles: 0 });
  });

  it('says so when the directory is gone', async () => {
    await write('src/app.ts', 'a\n');
    const revision = await captureSourceRevision(root);

    const comparison = await compareSourceRevision(path.join(root, 'missing'), revision);

    expect(comparison).toMatchObject({ stale: null, changedFiles: null, changes: null });
  });
});

describe('revisions recorded before manifests existed', () => {
  function legacy(revision: SourceRevision): SourceRevision {
    const { manifest: _manifest, ...rest } = revision;
    return rest;
  }

  it('never claims current: no difference found is unknown', async () => {
    await repository({ 'src/app.ts': 'a\n' });
    const revision = legacy(await captureSourceRevision(root));

    const comparison = await compareSourceRevision(root, revision);

    expect(comparison).toMatchObject({ stale: null, changedFiles: 0 });
    expect(comparison.reason).toMatch(/re-index once/);
  });

  it('still reports a difference it can see as stale', async () => {
    await repository({ 'src/app.ts': 'a\n' });
    const revision = legacy(await captureSourceRevision(root));

    await write('src/app.ts', 'b\n');

    expect(await compareSourceRevision(root, revision)).toMatchObject({
      stale: true,
      changedFiles: 1,
      changedPaths: ['src/app.ts'],
    });
  });

  it('falls back to the digest when a snapshot was too large to keep', async () => {
    await repository({ 'src/app.ts': 'a\n' });
    const revision = { ...legacy(await captureSourceRevision(root)), changes: null };

    expect((await compareSourceRevision(root, revision)).stale).toBe(null);

    await write('src/app.ts', 'b\n');
    expect(await compareSourceRevision(root, revision)).toMatchObject({ stale: true, changedFiles: null });
  });

  it('non-git: a file modified after capture is stale, nothing modified is unknown', async () => {
    await write('src/app.ts', 'a\n');
    const capturedAt = Date.now() + 5_000;
    const revision = legacy(await captureSourceRevision(root, { now: () => capturedAt }));

    expect((await compareSourceRevision(root, revision)).stale).toBe(null);

    const later = new Date(capturedAt + 5_000);
    await utimes(path.join(root, 'src/app.ts'), later, later);
    expect(await compareSourceRevision(root, revision)).toMatchObject({ stale: true, changedPaths: ['src/app.ts'] });
  });
});
