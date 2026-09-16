import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectMetadata, SupportedLanguage } from '@ckg/shared';
import { detectLanguage } from './extensions.js';
import { scanRepository, type ScanOptions } from './scan.js';
import type { RepositoryScan } from './types/index.js';

/**
 * Sizing up a directory before anything is parsed.
 *
 * This is what the "Selected project" card is made of: how many files there
 * are, how many of them we can actually read, and in which languages. It runs
 * before indexing so that picking the wrong folder is something you find out in
 * a second rather than three minutes in, and it runs again at the start of a
 * run so the indexer knows how much work it has to report against.
 *
 * It is one directory walk and no file reads. Nothing here opens a source file.
 */

export class ProjectScanError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-found' | 'not-a-directory' | 'unreadable',
  ) {
    super(message);
    this.name = 'ProjectScanError';
  }
}

/**
 * Checks that a path is a directory we can actually read, and returns it
 * resolved.
 *
 * Separate from the walk because the three ways this fails — missing, not a
 * directory, not permitted — each deserve their own message, and because by the
 * time the walk is running an unreadable subdirectory is something to skip
 * rather than something to report.
 */
export async function resolveProjectRoot(rootPath: string): Promise<string> {
  const absolute = path.resolve(rootPath);

  let stats;
  try {
    stats = await stat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ProjectScanError(
        `permission denied while accessing ${absolute}`,
        'unreadable',
      );
    }
    throw new ProjectScanError(`no such directory: ${absolute}`, 'not-found');
  }

  if (!stats.isDirectory()) {
    throw new ProjectScanError(`not a directory: ${absolute}`, 'not-a-directory');
  }

  // `stat` succeeds on a directory we are not allowed to open, so it is not
  // enough on its own. Without this check an unreadable project would walk to
  // zero files and be reported as "nothing here to index", which is the wrong
  // thing to tell someone whose problem is permissions.
  try {
    await access(absolute, constants.R_OK | constants.X_OK);
  } catch {
    throw new ProjectScanError(`permission denied while accessing ${absolute}`, 'unreadable');
  }

  return absolute;
}

/** Summarises a walk that has already happened. Pure; does no I/O. */
export function summarizeScan(scan: RepositoryScan): ProjectMetadata {
  const languages: Partial<Record<SupportedLanguage, number>> = {};
  let sourceFiles = 0;

  for (const file of scan.files) {
    const language = detectLanguage(file);
    // An unsupported file type is skipped, not an error: a repository is
    // allowed to contain images, CSVs and Fortran. It is simply not indexed.
    if (!language) continue;
    sourceFiles += 1;
    languages[language] = (languages[language] ?? 0) + 1;
  }

  return {
    rootPath: scan.rootPath,
    name: path.basename(scan.rootPath) || scan.rootPath,
    totalFiles: scan.files.length,
    sourceFiles,
    languages,
    directories: scan.directoryCount,
    truncated: scan.truncated,
  };
}

export interface ScanProjectResult {
  metadata: ProjectMetadata;
  /** The underlying walk, for callers that also want to detect languages. */
  scan: RepositoryScan;
}

/**
 * Walks a project directory and reports what is in it.
 *
 * Throws `ProjectScanError` only for the root itself — a project that is not
 * there, is not a directory, or cannot be read. Everything encountered inside
 * it that cannot be read is skipped.
 */
export async function scanProject(
  rootPath: string,
  options: ScanOptions = {},
): Promise<ScanProjectResult> {
  const absolute = await resolveProjectRoot(rootPath);
  const scan = await scanRepository(absolute, options);
  return { metadata: summarizeScan(scan), scan };
}
