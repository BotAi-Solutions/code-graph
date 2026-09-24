import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { SourceRevision } from '@ckg/shared';
import { DEFAULT_IGNORE_RULES, type IgnoreRules } from './ignore.js';

/**
 * What a directory looked like when it was indexed, and whether it still does.
 *
 * Two halves that must agree, which is why they live together: the worker
 * *captures* a revision before a run reads anything, and the API *compares* the
 * directory against it later. A change to how one half fingerprints a tree
 * without the other would make every project read as stale, or none.
 *
 * **Git working trees** are fingerprinted by content, not by commit. The record
 * is HEAD plus every path that differed from it at capture time, each with the
 * hash of its content. A later check diffs the working tree against that same
 * commit and compares the two sets. So committing exactly what was indexed is
 * still current, while a one-line edit that was never committed is stale — the
 * graph describes files, not commits.
 *
 * **Anything else** has no commit, and none is invented. Freshness falls back
 * to modification times: a file or directory changed after capture means the
 * graph may be out of date. Directory mtimes are what catch deletions and
 * additions, which leave no file behind to be newer.
 *
 * Paths the scanner ignores — `node_modules`, build output, lockfiles — are
 * ignored here too. The indexer never read them, so a rebuild must not make a
 * graph look stale.
 */

/** Past this many changed paths, only the digest is kept: the record is read on every freshness check. */
export const SOURCE_REVISION_MAX_CHANGES = 2_000;

/** Paths returned for a caller to look at. The count says how many there were. */
export const FRESHNESS_MAX_CHANGED_PATHS = 20;

/** Entries a modification-time walk will stat before giving up on an answer. */
const MTIME_WALK_MAX_ENTRIES = 50_000;

const GIT_TIMEOUT_MS = 30_000;

/** Enough for `git diff --name-only` on any repository this system can index. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface SourceRevisionOptions {
  ignore?: IgnoreRules;
  /** Clock, for tests. */
  now?: () => number;
}

export interface RevisionComparison {
  /** What the directory is now. Differs from the recorded one when a repository was created or removed. */
  vcs: 'git' | 'none';
  currentCommit: string | null;
  /** Null when there was no way to tell. */
  stale: boolean | null;
  /** Null when the files could not be counted, even if staleness is known. */
  changedFiles: number | null;
  changedPaths: string[];
  reason: string;
}

/**
 * Fingerprints a directory before it is indexed.
 *
 * `capturedAt` is taken before anything is read, so a file saved while the run
 * is in flight is newer than the capture and reads as stale afterwards. That is
 * the safe direction to be wrong in.
 */
export async function captureSourceRevision(
  directory: string,
  options: SourceRevisionOptions = {},
): Promise<SourceRevision> {
  const capturedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const ignore = options.ignore ?? DEFAULT_IGNORE_RULES;

  const head = await gitHead(directory);
  const delta = head ? await workingTreeDelta(directory, head, ignore) : null;

  if (!head || !delta) {
    return { vcs: 'none', commit: null, changes: null, changeCount: 0, digest: null, capturedAt };
  }

  return {
    vcs: 'git',
    commit: head,
    changes: delta.size <= SOURCE_REVISION_MAX_CHANGES ? Object.fromEntries(delta) : null,
    changeCount: delta.size,
    digest: digestOf(delta),
    capturedAt,
  };
}

/** Compares a directory with the revision a run recorded. Never throws for an unreadable tree: it says so. */
export async function compareSourceRevision(
  directory: string,
  recorded: SourceRevision,
  options: SourceRevisionOptions = {},
): Promise<RevisionComparison> {
  const ignore = options.ignore ?? DEFAULT_IGNORE_RULES;

  if (recorded.vcs === 'git' && recorded.commit) {
    return compareGit(directory, recorded, recorded.commit, ignore);
  }

  return compareModificationTimes(directory, recorded, ignore);
}

// --- git ------------------------------------------------------------------

async function compareGit(
  directory: string,
  recorded: SourceRevision,
  indexedCommit: string,
  ignore: IgnoreRules,
): Promise<RevisionComparison> {
  const head = await gitHead(directory);

  if (!head) {
    return {
      vcs: 'none',
      currentCommit: null,
      stale: true,
      changedFiles: null,
      changedPaths: [],
      reason: 'The directory was a git working tree when it was indexed and is not one now.',
    };
  }

  const delta = await workingTreeDelta(directory, indexedCommit, ignore);
  if (!delta) {
    return {
      vcs: 'git',
      currentCommit: head,
      stale: true,
      changedFiles: null,
      changedPaths: [],
      reason: `The indexed commit ${short(indexedCommit)} is no longer in the local repository (rebased or garbage-collected), so changes cannot be counted.`,
    };
  }

  const moved = head !== indexedCommit ? ` HEAD moved from ${short(indexedCommit)} to ${short(head)}.` : '';

  // The exact comparison needs both change sets. A snapshot too large to keep
  // still has its digest, which answers "same or not" without "how many".
  if (recorded.changes === null || delta.size > SOURCE_REVISION_MAX_CHANGES) {
    const stale = digestOf(delta) !== recorded.digest;
    return {
      vcs: 'git',
      currentCommit: head,
      stale,
      changedFiles: stale ? null : 0,
      changedPaths: [],
      reason: stale
        ? `The working tree differs from what was indexed; too many files changed to count.${moved}`
        : `No file differs from what was indexed.${moved}`,
    };
  }

  const changed = changedBetween(new Map(Object.entries(recorded.changes)), delta);

  return {
    vcs: 'git',
    currentCommit: head,
    stale: changed.length > 0,
    changedFiles: changed.length,
    changedPaths: changed.slice(0, FRESHNESS_MAX_CHANGED_PATHS),
    reason:
      changed.length > 0
        ? `${String(changed.length)} file(s) differ from what was indexed.${moved}`
        : `No file differs from what was indexed.${moved}`,
  };
}

/**
 * HEAD, when the directory is a git working tree whose commit actually holds
 * it; otherwise null.
 *
 * "Holds it" matters. A project directory that is untracked or ignored inside
 * some enclosing repository — a home directory under version control, say —
 * would otherwise diff as clean forever, because git does not report on paths
 * it was told to ignore. Such a directory is treated as not versioned at all.
 */
async function gitHead(directory: string): Promise<string | null> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], directory);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;

  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], directory);
  if (head.code !== 0) return null;

  const prefix = await git(['rev-parse', '--show-prefix'], directory);
  if (prefix.code !== 0) return null;

  const tree = prefix.stdout.trim() === '' ? 'HEAD^{tree}' : `HEAD:${prefix.stdout.trim()}`;
  const tracked = await git(['cat-file', '-e', tree], directory);
  if (tracked.code !== 0) return null;

  return head.stdout.trim();
}

/**
 * Every path under `directory` whose working-tree content differs from
 * `commit`, mapped to a hash of that content — or null when it is gone.
 *
 * Tracked changes (staged or not) come from one diff against the commit;
 * untracked files from `ls-files --others`, which honours `.gitignore`. Both
 * run with `--relative`/the directory as cwd, so a project that is a
 * subdirectory of a larger repository sees only its own files. Null when the
 * commit cannot be diffed against.
 */
async function workingTreeDelta(
  directory: string,
  commit: string,
  ignore: IgnoreRules,
): Promise<Map<string, string | null> | null> {
  const tracked = await git(
    ['diff', '--name-only', '-z', '--no-renames', '--relative', commit, '--'],
    directory,
  );
  if (tracked.code !== 0) return null;

  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], directory);
  if (untracked.code !== 0) return null;

  const paths = new Set(
    [...splitNul(tracked.stdout), ...splitNul(untracked.stdout)].filter(
      (relative) => !ignoredPath(relative, ignore),
    ),
  );

  const entries = await Promise.all(
    [...paths].sort().map(async (relative) => [relative, await contentHash(directory, relative)] as const),
  );

  return new Map(entries);
}

/** Paths whose state differs between two deltas against the same commit. Absent means "as committed". */
function changedBetween(
  before: Map<string, string | null>,
  after: Map<string, string | null>,
): string[] {
  const changed: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.has(key) ? before.get(key) : undefined;
    const now = after.has(key) ? after.get(key) : undefined;
    if (was !== now) changed.push(key);
  }
  return changed.sort();
}

async function contentHash(directory: string, relative: string): Promise<string | null> {
  const absolute = path.join(directory, relative);
  try {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) return `l:${sha256(await readlink(absolute))}`;
    if (stats.isFile()) return sha256(await readFile(absolute));
    // A gitlink (submodule) or some other non-file: present, content not ours to hash.
    return 'other';
  } catch {
    return null;
  }
}

function digestOf(delta: Map<string, string | null>): string {
  const hash = createHash('sha256');
  for (const [relative, content] of [...delta.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${relative}\u0000${content ?? '-'}\n`);
  }
  return hash.digest('hex');
}

// --- modification times ---------------------------------------------------

async function compareModificationTimes(
  directory: string,
  recorded: SourceRevision,
  ignore: IgnoreRules,
): Promise<RevisionComparison> {
  const since = Date.parse(recorded.capturedAt);
  const walk = await newerThan(directory, since, ignore);

  if (walk === 'unreadable') {
    return {
      vcs: 'none',
      currentCommit: null,
      stale: null,
      changedFiles: null,
      changedPaths: [],
      reason: 'The project directory could not be read.',
    };
  }

  if (walk.truncated) {
    return {
      vcs: 'none',
      currentCommit: null,
      stale: walk.files.length > 0 || walk.directories > 0 ? true : null,
      changedFiles: null,
      changedPaths: walk.files.slice(0, FRESHNESS_MAX_CHANGED_PATHS),
      reason: 'Not a git repository, and too large to check every file’s modification time.',
    };
  }

  const stale = walk.files.length > 0 || walk.directories > 0;

  return {
    vcs: 'none',
    currentCommit: null,
    stale,
    // Only a directory changed: something was added, removed or renamed, and
    // there is no file left behind to count.
    changedFiles: walk.files.length > 0 || !stale ? walk.files.length : null,
    changedPaths: walk.files.slice(0, FRESHNESS_MAX_CHANGED_PATHS),
    reason: stale
      ? walk.files.length > 0
        ? `Not a git repository: ${String(walk.files.length)} file(s) were modified after indexing began.`
        : 'Not a git repository: files were added, removed or renamed after indexing began.'
      : 'Not a git repository: nothing was modified after indexing began.',
  };
}

interface MtimeWalk {
  files: string[];
  directories: number;
  truncated: boolean;
}

async function newerThan(
  root: string,
  since: number,
  ignore: IgnoreRules,
): Promise<MtimeWalk | 'unreadable'> {
  const result: MtimeWalk = { files: [], directories: 0, truncated: false };
  const queue: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  let seen = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
      const stats = await lstat(current.absolute);
      if (stats.mtimeMs > since) result.directories += 1;
    } catch {
      if (current.relative === '') return 'unreadable';
      continue;
    }

    for (const entry of entries) {
      seen += 1;
      if (seen > MTIME_WALK_MAX_ENTRIES) {
        result.truncated = true;
        return result;
      }

      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      const absolute = path.join(current.absolute, entry.name);

      if (entry.isDirectory()) {
        if (!ignore.ignoresDirectory(entry.name)) queue.push({ absolute, relative });
        continue;
      }
      if (ignore.ignoresFile(entry.name)) continue;

      try {
        const stats = await lstat(absolute);
        if (stats.mtimeMs > since) result.files.push(relative);
      } catch {
        // Vanished between listing and stat: the directory's mtime says so.
      }
    }
  }

  result.files.sort();
  return result;
}

// --- helpers --------------------------------------------------------------

/** True when any segment is a directory the scanner skips, or the file is one it skips. */
function ignoredPath(relative: string, ignore: IgnoreRules): boolean {
  const segments = relative.split('/');
  const file = segments.pop() ?? '';
  return segments.some((segment) => ignore.ignoresDirectory(segment)) || ignore.ignoresFile(file);
}

function splitNul(output: string): string[] {
  return output.split('\u0000').filter((entry) => entry.length > 0);
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * Environment for git, with anything that could point it at a different
 * repository removed. A process started from inside a git hook inherits
 * `GIT_DIR`, and every answer would then be about the wrong tree.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    delete env[name];
  }
  return env;
}

/** Runs git. A missing binary reads as a failed command, which every caller treats as "not a repository". */
function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: gitEnvironment(),
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (!error) {
          resolve({ code: 0, stdout });
          return;
        }
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1;
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
      },
    );
  });
}
