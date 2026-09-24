/**
 * Which scanned files the indexing pipeline actually reads.
 *
 * The scan decides what is in the project; this decides which of those files a
 * run opens. Two consumers need the same answer and must never disagree: the
 * source loader, which reads these files into the graph, and the source
 * manifest, which fingerprints them so a later freshness check can tell whether
 * the graph still describes them. A format added here is read by the one and
 * watched by the other in the same change.
 */

/**
 * Extensions that carry code, architecture or repository knowledge.
 *
 * Grown, not replaced: everything the code graph read is still read, and the
 * document formats were added when the graph stopped being only about code. A
 * category the pipeline has no analyzer for is still not read — adding an
 * extension here is what makes a format cost a file open.
 */
const SOURCE_SUFFIXES = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.prisma',
  '.sql',
  '.ddl',
  '.psql',
  '.yml',
  '.yaml',
  '.md',
  '.mdx',
] as const;

/** Files worth reading whose name, not extension, identifies them. */
const SOURCE_FILENAMES = ['dockerfile', 'procfile', 'makefile'] as const;

/** Compiler output and vendored copies masquerading as source. */
const EXCLUDED_SUFFIXES = ['.min.js', '.d.ts.map', '.js.map', '.tsbuildinfo'] as const;

/**
 * Environment files whose contents are examples rather than real values. Any
 * other `.env` file holds live credentials, so its *path* is recorded — the
 * fact that the service is configured by environment is worth knowing — and its
 * contents are never read.
 */
const EXAMPLE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.defaults', '.dist'] as const;

export function holdsSecrets(relativePath: string): boolean {
  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1).toLowerCase();
  if (!fileName.startsWith('.env')) return false;
  return !EXAMPLE_ENV_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

/** True for a scanned, repository-relative path the pipeline reads. */
export function isIndexedSourceFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;

  const fileName = lower.slice(lower.lastIndexOf('/') + 1);
  if (SOURCE_FILENAMES.includes(fileName as (typeof SOURCE_FILENAMES)[number])) return true;
  if (fileName.startsWith('.env')) return true;

  return SOURCE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
