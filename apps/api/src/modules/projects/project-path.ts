import path from 'node:path';
import type { RepositorySourceType } from '@ckg/shared';
import { AppError } from '../../common/errors/index.js';

/**
 * Deciding whether one directory sits inside another.
 *
 * Pure and synchronous on purpose: resolution's only interesting rule is a
 * containment test between two paths, and a rule that never touches the disk is
 * one that can be checked exhaustively in a unit test — including the cases a
 * real filesystem makes awkward to arrange, like a project at `/` or a path
 * that merely shares a prefix with a repository root.
 *
 * The containment test is deliberately the same one source retrieval applies
 * (`modules/source/source.service.ts`): a candidate is inside a root when it is
 * the root itself, or when it starts with the root *followed by a separator*.
 * Comparing raw prefixes without that separator is the classic mistake, and it
 * would make `/srv/app-backup` look like part of `/srv/app`.
 *
 * Comparison is case-sensitive, like the rest of the system's path handling,
 * even though macOS and Windows usually are not. A case-insensitive match would
 * make the answer depend on which host the API happens to run on, and a caller
 * passing a working directory the operating system gave it already has the
 * casing the repository was registered with.
 */

/** A path that has been resolved to absolute, and its symlink-free form when known. */
export interface ResolvedPath {
  /** Absolute, with `.` and `..` removed. Always present. */
  absolute: string;
  /**
   * The same path with every symlink resolved, when the filesystem was
   * consulted and could answer. Undefined when path canonicalisation is off, or
   * when the path does not exist — which is not an error here, because a caller
   * may legitimately ask about a directory this machine cannot see.
   */
  canonical?: string | undefined;
}

/** Where a path landed inside a repository root. */
export interface PathContainment {
  /** The root form that matched — canonical when that is what matched, absolute otherwise. */
  root: string;
  /** POSIX-form path from `root` to the requested path. Empty at the root itself. */
  relativePath: string;
  /** True when the requested path *is* the root rather than something under it. */
  exact: boolean;
}

/**
 * Resolves a caller-supplied path to an absolute one.
 *
 * A relative path is resolved against `baseDirectory` rather than the API
 * process's working directory. That is the same rule a stored relative
 * `sourcePath` follows, and it is what makes `test-repositories/typescript-sample`
 * resolve to the project registered under exactly that path — the process's cwd
 * differs between `pnpm dev` and a package script, so it can decide nothing.
 */
export function resolveRequestedPath(requested: string, baseDirectory: string): string {
  const trimmed = requested.trim();

  if (trimmed.length === 0) {
    throw AppError.validation('A path is required', [{ path: 'path', message: 'A path is required' }]);
  }

  // A NUL byte truncates the path at the syscall boundary, so a string that
  // passed every check above it can still name a different file than it reads
  // like. Rejected here rather than anywhere near the filesystem.
  if (trimmed.includes('\u0000')) {
    throw AppError.validation('A path must not contain a NUL byte', [
      { path: 'path', message: 'A path must not contain a NUL byte' },
    ]);
  }

  return path.resolve(baseDirectory, trimmed);
}

/**
 * Where `candidate` sits relative to `root`, or null when it is outside it.
 *
 * Both arguments must already be absolute; this function does no resolution of
 * its own so that the caller stays in control of which form — lexical or
 * canonical — an answer was derived from.
 */
export function containmentOf(root: string, candidate: string): PathContainment | null {
  if (candidate === root) return { root, relativePath: '', exact: true };

  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!candidate.startsWith(prefix)) return null;

  return {
    root,
    // POSIX form regardless of host, so the result can be handed straight to
    // source retrieval and graph search, which both speak repository-relative
    // POSIX paths.
    relativePath: path.relative(root, candidate).split(path.sep).join('/'),
    exact: false,
  };
}

/**
 * Containment tried against the lexical paths first, then the canonical ones.
 *
 * Two passes because symlinks are ordinary. A repository registered as
 * `/tmp/work` on macOS really lives at `/private/tmp/work`, and an agent
 * reporting its own working directory may name either. Whichever form matched
 * is the form reported back, so `root` and `relativePath` always compose to the
 * path that was asked about rather than to a mixture of the two.
 */
export function containmentWithin(root: ResolvedPath, candidate: ResolvedPath): PathContainment | null {
  const lexical = containmentOf(root.absolute, candidate.absolute);
  if (lexical) return lexical;

  if (root.canonical === undefined || candidate.canonical === undefined) return null;
  // Nothing new to try: canonicalisation changed neither side.
  if (root.canonical === root.absolute && candidate.canonical === candidate.absolute) return null;

  return containmentOf(root.canonical, candidate.canonical);
}

/**
 * Guards against a `sourcePath` that cannot name a directory on this machine.
 *
 * A git repository stores a clone URL here, and the worker deletes its shallow
 * clone when the run finishes, so there is no directory for a path to be inside
 * of. Treating one as a filesystem path would let `https://…/app.git` match by
 * accident; refusing is both safer and truthful.
 */
export function isFilesystemSource(sourceType: RepositorySourceType): boolean {
  return sourceType === 'local';
}
