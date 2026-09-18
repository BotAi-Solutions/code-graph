import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { scanRepository, type RepositoryScan } from '@ckg/language-detection';
import type { IndexingError } from '@ckg/shared';
import { InMemorySourceFileSet } from './source-file-set.js';

/**
 * Reads the files the analyzers can say something about.
 *
 * Deliberately narrow: source files in the languages we analyse, plus the
 * handful of declarative files that carry architectural facts (manifests,
 * schemas, configuration). Everything else — images, lock files, compiled
 * output — is skipped, which is what keeps this one bounded pass rather than a
 * whole-repository read.
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

export interface LoadSourceOptions {
  /** Hard cap on files read. Beyond it the set is marked truncated. */
  maxFiles?: number;
  /** Files larger than this are skipped: nothing useful is that big. */
  maxFileBytes?: number;
  /** Hard cap on total bytes held in memory. */
  maxTotalBytes?: number;
  /**
   * Called as files are read, with a real count and a real total — by this
   * point the walk has finished, so both numbers are known.
   */
  onProgress?: (read: number, total: number) => void;
  /**
   * A walk that has already happened. The indexing pipeline scans a project
   * before it does anything else, to size the work and report what it found;
   * handing that scan back here is what keeps a run to one pass over the
   * directory tree rather than two.
   */
  scan?: RepositoryScan;
}

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Files read concurrently; enough to saturate a disk, few enough to be polite. */
const READ_CONCURRENCY = 16;

export async function loadSourceFiles(
  repositoryPath: string,
  options: LoadSourceOptions = {},
): Promise<InMemorySourceFileSet> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const scan = options.scan ?? (await scanRepository(repositoryPath));
  const candidates = scan.files.filter(isInteresting);

  const selected = candidates.slice(0, maxFiles);
  const truncated = scan.truncated || candidates.length > selected.length;

  const files: Array<{ relativePath: string; text: string }> = [];
  const failures: IndexingError[] = [];
  let totalBytes = 0;

  for (let index = 0; index < selected.length; index += READ_CONCURRENCY) {
    const batch = selected.slice(index, index + READ_CONCURRENCY);

    const read = await Promise.all(
      batch.map(async (relativePath) => {
        const absolute = path.join(repositoryPath, relativePath);
        try {
          const stats = await stat(absolute);
          if (!stats.isFile() || stats.size > maxFileBytes) return null;
          // A live `.env` is listed but never read: its path is a fact about
          // the service, its contents are credentials.
          if (holdsSecrets(relativePath)) return { relativePath, text: '', size: 0 };
          return { relativePath, text: await readFile(absolute, 'utf8'), size: stats.size };
        } catch (error) {
          // Removed or unreadable since the walk: analysing the rest is better
          // than failing the run, but the file is reported rather than
          // disappearing silently.
          failures.push({
            file: relativePath,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );

    for (const file of read) {
      if (!file) continue;
      if (totalBytes + file.size > maxTotalBytes) {
        return new InMemorySourceFileSet(files, true, failures);
      }
      totalBytes += file.size;
      files.push({ relativePath: file.relativePath, text: file.text });
    }

    options.onProgress?.(Math.min(index + READ_CONCURRENCY, selected.length), selected.length);
  }

  return new InMemorySourceFileSet(files, truncated, failures);
}

function isInteresting(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;

  const fileName = lower.slice(lower.lastIndexOf('/') + 1);
  if (SOURCE_FILENAMES.includes(fileName as (typeof SOURCE_FILENAMES)[number])) return true;
  if (fileName.startsWith('.env')) return true;

  return SOURCE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
