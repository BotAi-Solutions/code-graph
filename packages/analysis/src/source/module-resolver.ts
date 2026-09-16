/**
 * Resolves a module specifier to something the graph can point at: a file in
 * this repository, or an external package.
 *
 * Resolution is done against the set of files we actually read, never against
 * the disk, so it is pure, fast and identical on every run. It implements the
 * conventions that matter in practice — TypeScript's `.js`-means-`.ts` ESM
 * rule, extensionless imports, directory `index` files — and stops there: an
 * unresolvable specifier is reported as unresolved rather than guessed at.
 */

export type ResolvedModule =
  | { kind: 'file'; relativePath: string }
  | { kind: 'package'; packageName: string; subpath: string | null }
  /** A Node standard library module: the runtime, not a dependency. */
  | { kind: 'builtin'; moduleName: string }
  | { kind: 'unresolved'; specifier: string };

/**
 * Node's standard library.
 *
 * `node:events` is not something this service depends on in any sense worth
 * putting in a graph — it cannot be chosen, upgraded or removed, and listing it
 * beside `express` and `stripe` would make the dependency view less useful, not
 * more. Recognised so it can be told apart from a real package, then ignored.
 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

export function isNodeBuiltin(specifier: string): boolean {
  const withoutPrefix = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return NODE_BUILTINS.has(withoutPrefix.split('/')[0] ?? '');
}

/** Extensions tried for an extensionless or `.js`-suffixed specifier. */
const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export class ModuleResolver {
  private readonly paths: ReadonlySet<string>;

  constructor(paths: Iterable<string>) {
    this.paths = new Set(paths);
  }

  resolve(fromRelativePath: string, specifier: string): ResolvedModule {
    if (specifier.length === 0) return { kind: 'unresolved', specifier };

    if (specifier.startsWith('.')) {
      const target = this.resolveRelative(fromRelativePath, specifier);
      return target
        ? { kind: 'file', relativePath: target }
        : { kind: 'unresolved', specifier };
    }

    if (isNodeBuiltin(specifier)) {
      return { kind: 'builtin', moduleName: specifier };
    }

    // Absolute paths and TypeScript path aliases both land here. Neither can be
    // resolved without a tsconfig, and guessing would produce edges pointing at
    // the wrong file, so they are honestly unresolved.
    if (specifier.startsWith('/') || specifier.startsWith('#')) {
      return { kind: 'unresolved', specifier };
    }

    return packageOf(specifier);
  }

  /** True when the specifier names a file inside this repository. */
  private resolveRelative(fromRelativePath: string, specifier: string): string | null {
    const directory = fromRelativePath.includes('/')
      ? fromRelativePath.slice(0, fromRelativePath.lastIndexOf('/'))
      : '';

    const joined = normalize(directory === '' ? specifier : `${directory}/${specifier}`);
    if (joined === null) return null;

    for (const candidate of this.candidates(joined)) {
      if (this.paths.has(candidate)) return candidate;
    }
    return null;
  }

  private candidates(target: string): string[] {
    const candidates: string[] = [target];

    // `./user.service.js` in TypeScript ESM means `./user.service.ts`.
    const jsExtension = CANDIDATE_EXTENSIONS.find((extension) => target.endsWith(extension));
    if (jsExtension) {
      const stem = target.slice(0, -jsExtension.length);
      for (const extension of CANDIDATE_EXTENSIONS) candidates.push(`${stem}${extension}`);
    } else {
      for (const extension of CANDIDATE_EXTENSIONS) candidates.push(`${target}${extension}`);
    }

    for (const extension of CANDIDATE_EXTENSIONS) {
      candidates.push(`${target}/index${extension}`);
    }

    return candidates;
  }
}

/** Splits a bare specifier into its package name and subpath. */
export function packageOf(specifier: string): ResolvedModule {
  const segments = specifier.split('/');

  if (specifier.startsWith('@')) {
    const scope = segments[0];
    const name = segments[1];
    if (scope === undefined || name === undefined) return { kind: 'unresolved', specifier };
    const subpath = segments.slice(2).join('/');
    return { kind: 'package', packageName: `${scope}/${name}`, subpath: subpath || null };
  }

  const name = segments[0];
  if (name === undefined || name.length === 0) return { kind: 'unresolved', specifier };
  const subpath = segments.slice(1).join('/');
  return { kind: 'package', packageName: name, subpath: subpath || null };
}

/** Collapses `.` and `..` segments. Returns null if the path escapes the root. */
function normalize(pathLike: string): string | null {
  const output: string[] = [];

  for (const segment of pathLike.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) return null;
      output.pop();
      continue;
    }
    output.push(segment);
  }

  return output.join('/');
}
