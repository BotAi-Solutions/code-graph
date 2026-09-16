import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { scanRepository } from '@ckg/language-detection';
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

/** Extensions that carry code or architecture. */
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
  '.prisma',
  '.sql',
  '.yml',
  '.yaml',
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

  const scan = await scanRepository(repositoryPath);
  const candidates = scan.files.filter(isInteresting);

  const selected = candidates.slice(0, maxFiles);
  const truncated = scan.truncated || candidates.length > selected.length;

  const files: Array<{ relativePath: string; text: string }> = [];
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
        } catch {
          // Removed or unreadable since the walk: analysing the rest is better
          // than failing the run.
          return null;
        }
      }),
    );

    for (const file of read) {
      if (!file) continue;
      if (totalBytes + file.size > maxTotalBytes) {
        return new InMemorySourceFileSet(files, true);
      }
      totalBytes += file.size;
      files.push({ relativePath: file.relativePath, text: file.text });
    }
  }

  return new InMemorySourceFileSet(files, truncated);
}

function isInteresting(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;

  const fileName = lower.slice(lower.lastIndexOf('/') + 1);
  if (SOURCE_FILENAMES.includes(fileName as (typeof SOURCE_FILENAMES)[number])) return true;
  if (fileName.startsWith('.env')) return true;

  return SOURCE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
