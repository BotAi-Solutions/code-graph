/**
 * What a repository walk skips, and how a caller changes it.
 *
 * Kept apart from the walk itself because the *policy* is the thing that grows:
 * every language added brings its own build output, and every team has a
 * directory they would rather we did not read. The walk stays fixed; this list
 * moves.
 *
 * Nothing here is a heuristic about whether a directory is *interesting* — it
 * is only about whether it holds first-party source. A directory we are unsure
 * about is walked, because missing real code is worse than reading a little
 * more than we needed.
 */

/** Directories that never contain first-party source worth indexing. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  // version control and editors
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  // package managers
  'node_modules',
  'bower_components',
  'vendor',
  '.pnpm-store',
  // build output
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  '.dart_tool',
  // caches, test output, virtualenvs
  'coverage',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '__pycache__',
  '.venv',
  'venv',
  // this tool's own scratch space
  '.workspace',
];

/**
 * Files that are large, generated, and say nothing about the code.
 *
 * Lock files are the whole point: they are the biggest text files in most
 * repositories and reading one has never once helped. Matched by exact name or
 * by suffix, never by a regex over the whole path.
 */
export const DEFAULT_IGNORED_FILES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pubspec.lock',
  'cargo.lock',
  'go.sum',
];

/** Suffixes that identify a generated or vendored file wherever it sits. */
export const DEFAULT_IGNORED_SUFFIXES: readonly string[] = [
  '.lock',
  '.min.js',
  '.min.css',
  '.map',
  '.tsbuildinfo',
];

export interface IgnoreOptions {
  /** Replaces the default directory list outright. */
  ignoredDirectories?: readonly string[];
  /** Added to whichever directory list is in force. */
  extraIgnoredDirectories?: readonly string[];
  ignoredFiles?: readonly string[];
  extraIgnoredFiles?: readonly string[];
  ignoredSuffixes?: readonly string[];
  extraIgnoredSuffixes?: readonly string[];
}

/**
 * A compiled ignore policy.
 *
 * Compiled once per walk rather than consulted as arrays per entry: a 10,000
 * file repository asks these questions 10,000 times, and a `Set` lookup is the
 * difference between a walk you wait for and one you do not.
 */
export class IgnoreRules {
  private readonly directories: ReadonlySet<string>;
  private readonly files: ReadonlySet<string>;
  private readonly suffixes: readonly string[];

  constructor(options: IgnoreOptions = {}) {
    this.directories = new Set(
      [
        ...(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES),
        ...(options.extraIgnoredDirectories ?? []),
      ].map((name) => name.toLowerCase()),
    );
    this.files = new Set(
      [
        ...(options.ignoredFiles ?? DEFAULT_IGNORED_FILES),
        ...(options.extraIgnoredFiles ?? []),
      ].map((name) => name.toLowerCase()),
    );
    this.suffixes = [
      ...(options.ignoredSuffixes ?? DEFAULT_IGNORED_SUFFIXES),
      ...(options.extraIgnoredSuffixes ?? []),
    ].map((suffix) => suffix.toLowerCase());
  }

  ignoresDirectory(name: string): boolean {
    return this.directories.has(name.toLowerCase());
  }

  ignoresFile(name: string): boolean {
    const lower = name.toLowerCase();
    if (this.files.has(lower)) return true;
    return this.suffixes.some((suffix) => lower.endsWith(suffix));
  }
}

export const DEFAULT_IGNORE_RULES = new IgnoreRules();
