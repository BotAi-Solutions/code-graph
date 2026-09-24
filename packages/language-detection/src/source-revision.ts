import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { SourceManifest, SourceRevision } from '@ckg/shared';
import { DEFAULT_IGNORE_RULES, type IgnoreRules } from './ignore.js';
import { holdsSecrets, isIndexedSourceFile } from './indexed-files.js';
import { resolveProjectRoot } from './project-scan.js';
import { scanRepository } from './scan.js';

/**
 * What a directory looked like when it was indexed, and whether it still does.
 *
 * Two halves that must agree, which is why they live together: the worker
 * *captures* a revision before a run reads anything, and the API *compares* the
 * directory against it later. A change to how one half fingerprints a tree
 * without the other would make every project read as stale, or none.
 *
 * **The source manifest** is the fingerprint. It is every file the indexing
 * pipeline reads — the scanner's walk, filtered exactly as the source loader
 * filters it — mapped to a SHA-256 of its content. A check rebuilds the same
 * map and diffs the two: a file in one and not the other was added or deleted,
 * a file in both with different hashes was modified. Content, not modification
 * times, and not git: a gitignored file the scanner still reads is watched, and
 * a file git reports that the scanner never reads is not.
 *
 * **The commit** is recorded beside it for git working trees, and a HEAD that
 * moved is stale on its own — the graph was built at one commit and the
 * repository is now at another — even when no indexed file changed. The reason
 * says which of the two it was.
 *
 * Paths the scanner ignores — `node_modules`, build output, lockfiles — are
 * ignored here too, because the manifest is built from the scanner's own walk.
 *
 * Revisions recorded before manifests existed hold only a delta against HEAD
 * (for git) or a capture time (otherwise). Those are still compared the old way,
 * but can only ever prove a graph *stale*: the old delta could not see files
 * the scanner reads and git does not, so "no difference found" is reported as
 * unknown rather than current until the project is re-indexed once.
 */

/** Past this many changed paths, only the digest is kept: the record is read on every freshness check. */
export const SOURCE_REVISION_MAX_CHANGES = 2_000;

/** Paths returned for a caller to look at. The count says how many there were. */
export const FRESHNESS_MAX_CHANGED_PATHS = 20;

/** Entries a modification-time walk will stat before giving up on an answer. */
const MTIME_WALK_MAX_ENTRIES = 50_000;

const GIT_TIMEOUT_MS = 30_000;

/** Files hashed at once when building a manifest: enough to keep the disk busy, few enough to spare descriptors. */
const MANIFEST_HASH_CONCURRENCY = 32;

/**
 * Stands in for the content hash of a live `.env` file. The pipeline records
 * that such a file exists and never reads it, so only its presence can change
 * the graph — and a hash of credentials has no business in the database.
 */
const SECRET_FILE_MARKER = 'secret';

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
  /** The differences by kind, each capped like `changedPaths`; null when they could not be told apart. */
  changes: ChangesByKind | null;
  reason: string;
}

export interface ChangesByKind {
  added: string[];
  modified: string[];
  deleted: string[];
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
  const [delta, manifest] = await Promise.all([
    head ? workingTreeDelta(directory, head, ignore) : Promise.resolve(null),
    buildSourceManifest(directory, ignore),
  ]);

  if (!head || !delta) {
    return { vcs: 'none', commit: null, changes: null, changeCount: 0, digest: null, capturedAt, manifest };
  }

  return {
    vcs: 'git',
    commit: head,
    changes: delta.size <= SOURCE_REVISION_MAX_CHANGES ? Object.fromEntries(delta) : null,
    changeCount: delta.size,
    digest: digestOf(delta),
    capturedAt,
    manifest,
  };
}

/**
 * The content of every file an indexing run reads, keyed by
 * repository-relative path. Deterministic: the same tree always produces the
 * same entries in the same order, and so the same digest.
 *
 * Reads files but parses nothing. Throws `ProjectScanError` when the directory
 * itself cannot be read; a file that vanishes mid-walk is simply absent.
 */
export async function buildSourceManifest(
  directory: string,
  ignore: IgnoreRules = DEFAULT_IGNORE_RULES,
): Promise<SourceManifest> {
  const root = await resolveProjectRoot(directory);
  const scan = await scanRepository(root, { rules: ignore });
  const paths = scan.files.filter(isIndexedSourceFile);

  const files: Record<string, string> = {};
  for (let index = 0; index < paths.length; index += MANIFEST_HASH_CONCURRENCY) {
    const batch = paths.slice(index, index + MANIFEST_HASH_CONCURRENCY);
    const hashes = await Promise.all(batch.map((relative) => manifestHash(root, relative)));
    batch.forEach((relative, offset) => {
      const hash = hashes[offset];
      if (hash !== null && hash !== undefined) files[relative] = hash;
    });
  }

  const hash = createHash('sha256');
  for (const [relative, content] of Object.entries(files)) hash.update(`${relative}\u0000${content}\n`);

  return {
    version: 1,
    files,
    fileCount: Object.keys(files).length,
    digest: hash.digest('hex'),
    truncated: scan.truncated,
  };
}

async function manifestHash(root: string, relative: string): Promise<string | null> {
  if (holdsSecrets(relative)) return SECRET_FILE_MARKER;
  try {
    return sha256(await readFile(path.join(root, relative)));
  } catch {
    return null;
  }
}

/** Compares a directory with the revision a run recorded. Never throws for an unreadable tree: it says so. */
export async function compareSourceRevision(
  directory: string,
  recorded: SourceRevision,
  options: SourceRevisionOptions = {},
): Promise<RevisionComparison> {
  const ignore = options.ignore ?? DEFAULT_IGNORE_RULES;

  if (recorded.manifest) {
    return compareManifest(directory, recorded, recorded.manifest, ignore);
  }

  const legacy =
    recorded.vcs === 'git' && recorded.commit
      ? await compareGit(directory, recorded, recorded.commit, ignore)
      : await compareModificationTimes(directory, recorded, ignore);

  return legacy.stale === true ? legacy : { ...legacy, stale: null, reason: `${legacy.reason} ${LEGACY_CAVEAT}` };
}

const LEGACY_CAVEAT =
  'This graph was indexed before per-file source manifests were recorded, so it cannot be confirmed current; re-index once to enable full freshness checks.';

// --- manifest -------------------------------------------------------------

async function compareManifest(
  directory: string,
  recorded: SourceRevision,
  indexed: SourceManifest,
  ignore: IgnoreRules,
): Promise<RevisionComparison> {
  let current: SourceManifest;
  let head: string | null;
  try {
    [current, head] = await Promise.all([buildSourceManifest(directory, ignore), gitHead(directory)]);
  } catch {
    return {
      vcs: 'none',
      currentCommit: null,
      stale: null,
      changedFiles: null,
      changedPaths: [],
      changes: null,
      reason: 'The project directory could not be read.',
    };
  }

  const diff = diffManifests(indexed, current);
  const changedFiles = diff.added.length + diff.modified.length + diff.deleted.length;
  const changedPaths = [...diff.added, ...diff.modified, ...diff.deleted]
    .sort()
    .slice(0, FRESHNESS_MAX_CHANGED_PATHS);
  const changes: ChangesByKind = {
    added: diff.added.slice(0, FRESHNESS_MAX_CHANGED_PATHS),
    modified: diff.modified.slice(0, FRESHNESS_MAX_CHANGED_PATHS),
    deleted: diff.deleted.slice(0, FRESHNESS_MAX_CHANGED_PATHS),
  };

  const lostRepository = recorded.vcs === 'git' && head === null;
  const moved = recorded.commit !== null && head !== null && head !== recorded.commit;

  const clauses: string[] = [];
  if (changedFiles > 0) clauses.push(describeDiff(diff));
  if (moved && recorded.commit && head) clauses.push(`HEAD moved from ${short(recorded.commit)} to ${short(head)}.`);
  if (lostRepository) clauses.push('The directory was a git working tree when it was indexed and is not one now.');

  const stale = changedFiles > 0 || moved || lostRepository;
  if (!stale) clauses.push('No indexed source file differs from what was indexed.');
  else if (changedFiles === 0) clauses.push('No indexed source file differs in content.');

  return {
    vcs: head ? 'git' : 'none',
    currentCommit: head,
    stale,
    changedFiles,
    changedPaths,
    changes,
    reason: clauses.join(' '),
  };
}

/** Sorted paths added, modified and deleted between two manifests. */
export function diffManifests(before: SourceManifest, after: SourceManifest): {
  added: string[];
  modified: string[];
  deleted: string[];
} {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [relative, hash] of Object.entries(after.files)) {
    const was = before.files[relative];
    if (was === undefined) added.push(relative);
    else if (was !== hash) modified.push(relative);
  }
  for (const relative of Object.keys(before.files)) {
    if (after.files[relative] === undefined) deleted.push(relative);
  }

  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function describeDiff(diff: { added: string[]; modified: string[]; deleted: string[] }): string {
  const parts: string[] = [];
  if (diff.modified.length > 0) parts.push(`${String(diff.modified.length)} modified`);
  if (diff.added.length > 0) parts.push(`${String(diff.added.length)} added`);
  if (diff.deleted.length > 0) parts.push(`${String(diff.deleted.length)} deleted`);
  return `Indexed source files differ from what was indexed: ${parts.join(', ')}.`;
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
      changes: null,
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
      changes: null,
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
      changes: null,
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
    changes: null,
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
      changes: null,
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
      changes: null,
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
    changes: null,
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
