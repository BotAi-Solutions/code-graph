import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FileCategory } from '@ckg/shared';
import { classifyFile } from './classify.js';
import { IgnoreRules, type IgnoreOptions } from './ignore.js';
import type { RepositoryScan } from './types/index.js';

export interface ScanOptions extends IgnoreOptions {
  /** Stops the walk once this many files have been seen. */
  maxFiles?: number;
  maxDepth?: number;
  /**
   * Called as the walk proceeds, with files seen so far. There is no total to
   * report against — a walk does not know how big a tree is until it has walked
   * it — so a caller showing this must show it as a count, not a percentage.
   */
  onProgress?: (filesSeen: number) => void;
  /** Files between progress callbacks. Keeps a big walk from spamming. */
  progressInterval?: number;
  /** Aborts the walk. Whatever was found so far is returned, `truncated`. */
  signal?: AbortSignal;
  /** An already-compiled policy; takes precedence over the list options above. */
  rules?: IgnoreRules;
}

const DEFAULT_MAX_FILES = 25_000;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_PROGRESS_INTERVAL = 250;

/**
 * Walks a repository once and produces the read-only view every detector — and
 * the project scanner, and the source loader — works from. Doing the I/O here
 * keeps all three of those pure and unit-testable, and means a repository is
 * walked once per run rather than once per consumer.
 *
 * Unreadable directories are skipped rather than fatal: a permission error on
 * one subtree is not a reason to refuse to analyse the rest.
 */
export async function scanRepository(
  rootPath: string,
  options: ScanOptions = {},
): Promise<RepositoryScan> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const progressInterval = options.progressInterval ?? DEFAULT_PROGRESS_INTERVAL;
  const ignore = options.rules ?? new IgnoreRules(options);

  const files: string[] = [];
  const rootFiles = new Set<string>();
  const extensionCounts = new Map<string, number>();
  const categoryCounts = new Map<FileCategory, number>();
  let directoryCount = 0;
  let truncated = false;
  let sinceProgress = 0;

  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: rootPath, relative: '', depth: 0 },
  ];

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      truncated = true;
      break;
    }

    const current = queue.shift();
    if (!current) break;
    if (current.depth > maxDepth) {
      truncated = true;
      continue;
    }

    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, broken symlink): skip it rather than
      // failing the whole analysis. The root itself is validated by the caller,
      // which is where an unreadable project is worth reporting.
      continue;
    }

    for (const entry of entries) {
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (ignore.ignoresDirectory(entry.name)) continue;
        directoryCount += 1;
        queue.push({
          absolute: path.join(current.absolute, entry.name),
          relative,
          depth: current.depth + 1,
        });
        continue;
      }

      // Symlinks are not followed: a link out of the tree is a way to read
      // files the user did not choose, and a link back into it is a cycle.
      if (!entry.isFile()) continue;
      if (ignore.ignoresFile(entry.name)) continue;

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

      const category = classifyFile(relative).category;
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);

      sinceProgress += 1;
      if (options.onProgress && sinceProgress >= progressInterval) {
        sinceProgress = 0;
        options.onProgress(files.length);
      }
    }
  }

  options.onProgress?.(files.length);

  files.sort();
  return {
    rootPath,
    files,
    rootFiles,
    extensionCounts,
    categoryCounts,
    directoryCount,
    truncated,
  };
}

/** Returns the lower-cased extension, treating `.d.ts` as its own extension. */
export function extensionOf(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.d.ts')) return '.d.ts';
  const index = lower.lastIndexOf('.');
  if (index <= 0) return null;
  return lower.slice(index);
}
