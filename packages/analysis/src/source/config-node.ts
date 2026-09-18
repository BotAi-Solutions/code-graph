import type { AnalyzerNodeDraft } from '@ckg/graph';

/**
 * Which files count as configuration, and the node that stands for one.
 *
 * Shared because two analyzers now describe the same file: the file analyzer
 * places it in the architecture — this service is configured by these files —
 * and the configuration analyzer reads what is inside it. They must produce the
 * same node, so they build it from the same function, exactly as the service
 * and table nodes work.
 */

/** Files whose exact name identifies them as configuration. */
const CONFIG_BY_NAME: ReadonlyMap<string, string> = new Map([
  ['package.json', 'manifest'],
  ['tsconfig.json', 'typescript'],
  ['jsconfig.json', 'javascript'],
  ['dockerfile', 'container'],
  ['docker-compose.yml', 'container'],
  ['docker-compose.yaml', 'container'],
  ['compose.yml', 'container'],
  ['compose.yaml', 'container'],
  ['nest-cli.json', 'framework'],
  ['serverless.yml', 'deployment'],
  ['serverless.yaml', 'deployment'],
  ['procfile', 'deployment'],
  ['vercel.json', 'deployment'],
  ['fly.toml', 'deployment'],
]);

/** Suffix patterns that identify configuration regardless of directory. */
const CONFIG_SUFFIXES = [
  '.config.ts',
  '.config.js',
  '.config.mjs',
  '.config.cjs',
  '.config.json',
] as const;

/** Lock files and generated manifests are noise, not architecture. */
const NOT_CONFIG = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'tsconfig.tsbuildinfo',
]);

/**
 * The node for a configuration file.
 *
 * Only for a file the compiler did *not* index: `vite.config.ts` is
 * configuration and code, and the file analyzer enriches its existing node
 * rather than calling this. Callers make that check themselves because only
 * they hold the symbol index.
 */
export function configDraft(relativePath: string, kind: string): AnalyzerNodeDraft {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);

  return {
    type: 'config',
    name,
    symbolKey: relativePath,
    qualifiedName: relativePath,
    filePath: relativePath,
    metadata: { configKind: kind },
  };
}

export function configKindOf(relativePath: string): string | null {
  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1).toLowerCase();

  if (NOT_CONFIG.has(fileName)) return null;
  if (fileName.startsWith('.env')) return 'environment';

  const byName = CONFIG_BY_NAME.get(fileName);
  if (byName) return byName;

  if (fileName.startsWith('tsconfig.') && fileName.endsWith('.json')) return 'typescript';

  // `*.config.*` is a tool's configuration only at the repository root, which
  // is where every tool looks for it. `src/config/app.config.ts` is a module
  // that reads configuration — ordinary code, and the compiler already
  // describes it.
  const atRoot = !relativePath.includes('/');
  if (atRoot && CONFIG_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) return 'tooling';

  return null;
}
