import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectDirectoryHint, ProjectDirectoryVariable } from './config.js';

/**
 * Which directory is "the current project"?
 *
 * The one place that question is answered, so no tool reads the environment
 * and no two tools answer it differently. The answer is either a path the
 * caller named or the one the MCP client put in the environment
 * (`CLAUDE_PROJECT_DIR` under Claude Code); `config.ts` has already read which.
 *
 * What it adds is validation, done here on the machine the client runs on so
 * that a wrong guess fails with a reason instead of registering a project:
 *
 *   - absolute and normalised, then canonicalised with `realpath` — the API
 *     canonicalises the same way, so `/tmp/x` and `/private/tmp/x` are one
 *     project, not two;
 *   - an existing directory;
 *   - something that looks like a repository: a version-control directory or a
 *     project manifest at the root, or a git work tree around it;
 *   - not the filesystem root or the home directory, either of which a missing
 *     variable could plausibly produce and neither of which should be indexed.
 *
 * Identity is the canonical path, never the directory's name: two checkouts
 * called `my-app` in different places are two projects.
 */

export type ProjectRootErrorCode =
  | 'PROJECT_ROOT_UNDETERMINED'
  | 'PROJECT_ROOT_NOT_FOUND'
  | 'PROJECT_ROOT_NOT_DIRECTORY'
  | 'PROJECT_ROOT_NOT_A_PROJECT'
  | 'PROJECT_ROOT_TOO_BROAD';

export class ProjectRootError extends Error {
  constructor(
    readonly code: ProjectRootErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectRootError';
  }
}

export interface ResolvedProjectRoot {
  /** Absolute, normalised, symlinks resolved. */
  rootPath: string;
  /** Where the path came from: the caller's argument, or an environment variable. */
  source: 'argument' | ProjectDirectoryVariable;
}

export interface ResolveProjectRootOptions {
  /** A path the caller named. Wins over the environment. */
  explicit?: string | undefined;
  /** What the environment named, from `McpConfig.project`. */
  hint: ProjectDirectoryHint | null;
  /** Injected for tests; the real home directory otherwise. */
  homeDirectory?: string;
}

/**
 * Files or directories whose presence at a directory's top says "this is a
 * project". Deliberately broad — the indexer decides what it can parse; this
 * only has to rule out directories that are plainly not a codebase.
 */
const PROJECT_MARKERS = [
  '.git',
  '.hg',
  '.svn',
  'package.json',
  'pnpm-workspace.yaml',
  'deno.json',
  'tsconfig.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'Makefile',
  'CMakeLists.txt',
] as const;

export async function resolveProjectRoot(
  options: ResolveProjectRootOptions,
): Promise<ResolvedProjectRoot> {
  const requested = pick(options);
  const absolute = path.normalize(requested.path);

  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new ProjectRootError(
      'PROJECT_ROOT_NOT_FOUND',
      `The project root ${absolute} (from ${describe(requested.source)}) does not exist.`,
    );
  }
  if (!info.isDirectory()) {
    throw new ProjectRootError(
      'PROJECT_ROOT_NOT_DIRECTORY',
      `The project root ${absolute} (from ${describe(requested.source)}) is not a directory.`,
    );
  }

  const rootPath = await realpath(absolute).catch(() => absolute);

  const home = options.homeDirectory ?? os.homedir();
  if (rootPath === path.parse(rootPath).root || samePath(rootPath, home)) {
    throw new ProjectRootError(
      'PROJECT_ROOT_TOO_BROAD',
      `Refusing to treat ${rootPath} as a project: it is the ${rootPath === path.parse(rootPath).root ? 'filesystem root' : 'home directory'}. Open a repository, or pass its rootPath.`,
    );
  }

  if (!looksLikeProject(rootPath)) {
    throw new ProjectRootError(
      'PROJECT_ROOT_NOT_A_PROJECT',
      `${rootPath} does not look like a repository: it has no version-control directory or project manifest (package.json, pyproject.toml, go.mod, …) and is not inside a git work tree.`,
    );
  }

  return { rootPath, source: requested.source };
}

function pick(options: ResolveProjectRootOptions): { path: string; source: ResolvedProjectRoot['source'] } {
  const explicit = options.explicit?.trim();

  if (explicit) {
    if (path.isAbsolute(explicit)) return { path: explicit, source: 'argument' };
    // A relative path only means something against a known project directory.
    if (options.hint) {
      return { path: path.resolve(options.hint.path, explicit), source: 'argument' };
    }
    throw new ProjectRootError(
      'PROJECT_ROOT_UNDETERMINED',
      `rootPath "${explicit}" is relative and there is no current project directory to resolve it against. Pass an absolute path.`,
    );
  }

  if (options.hint) {
    if (!path.isAbsolute(options.hint.path)) {
      throw new ProjectRootError(
        'PROJECT_ROOT_UNDETERMINED',
        `${options.hint.source} is set to a relative path ("${options.hint.path}"); it must be absolute.`,
      );
    }
    return { path: options.hint.path, source: options.hint.source };
  }

  throw new ProjectRootError(
    'PROJECT_ROOT_UNDETERMINED',
    'The current project could not be determined: CLAUDE_PROJECT_DIR is not set (Claude Code sets it for the servers it launches; other clients can set CODERAG_PROJECT_DIR). Pass rootPath explicitly.',
  );
}

function looksLikeProject(directory: string): boolean {
  if (PROJECT_MARKERS.some((marker) => existsSync(path.join(directory, marker)))) return true;

  // A subdirectory of a git checkout is still inside a repository.
  let current = path.dirname(directory);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

function describe(source: ResolvedProjectRoot['source']): string {
  return source === 'argument' ? 'the rootPath argument' : source;
}
