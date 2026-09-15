import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryScan } from './types/index.js';

/** Directories that never contain first-party source worth indexing. */
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.workspace',
]);

export interface ScanOptions {
  /** Stops the walk once this many files have been seen. */
  maxFiles?: number;
  maxDepth?: number;
}

const DEFAULT_MAX_FILES = 25_000;
const DEFAULT_MAX_DEPTH = 24;

/**
 * Walks a repository once and produces the read-only view every detector works
 * from. Doing the I/O here keeps detectors pure and unit-testable.
 */
export async function scanRepository(
  rootPath: string,
  options: ScanOptions = {},
): Promise<RepositoryScan> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const files: string[] = [];
  const rootFiles = new Set<string>();
  const extensionCounts = new Map<string, number>();
  let truncated = false;

  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: rootPath, relative: '', depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > maxDepth) continue;

    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, broken symlink): skip it rather than
      // failing the whole analysis.
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      }

      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        queue.push({
          absolute: path.join(current.absolute, entry.name),
          relative,
          depth: current.depth + 1,
        });
        continue;
      }

      if (!entry.isFile()) continue;

      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }

      files.push(relative);
      if (current.depth === 0) rootFiles.add(entry.name.toLowerCase());

      const extension = extensionOf(entry.name);
      if (extension) {
        extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
      }
    }
  }

  files.sort();
  return { rootPath, files, rootFiles, extensionCounts, truncated };
}

/** Returns the lower-cased extension, treating `.d.ts` as its own extension. */
export function extensionOf(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.d.ts')) return '.d.ts';
  const index = lower.lastIndexOf('.');
  if (index <= 0) return null;
  return lower.slice(index);
}
