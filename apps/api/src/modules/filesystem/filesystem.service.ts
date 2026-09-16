import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DirectoryEntry,
  DirectoryListing,
  ProjectMetadata,
  SelectedDirectory,
} from '@ckg/shared';
import { ERROR_CODES } from '@ckg/shared';
import {
  DEFAULT_IGNORE_RULES,
  ProjectScanError,
  resolveProjectRoot,
  scanProject,
} from '@ckg/language-detection';
import { AppError } from '../../common/errors/index.js';
import {
  DirectoryPickerUnavailableError,
  type DirectoryPicker,
} from './directory-picker.js';

/**
 * The local filesystem, as narrowly as the intake flow needs it.
 *
 * Three questions and no others: which folder did the user choose, what
 * directories are under this one, and what is in that folder. In particular
 * there is no route that reads a file — the only thing that opens source is the
 * worker, on a directory the user explicitly picked and explicitly asked to
 * index.
 *
 * This is the boundary the rest of the system's filesystem access hangs off, so
 * everything that makes it safe is here rather than spread across handlers:
 * paths are resolved before use, listings never include files, and the whole
 * module refuses to answer when the local-filesystem switch is off.
 */

/** Files whose presence at a directory root says "this is a project". */
const PROJECT_MARKERS = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'deno.json',
  'go.mod',
  'cargo.toml',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'pubspec.yaml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gemfile',
  'composer.json',
  '.git',
]);

/** Entries returned by one listing. Enough for any real directory. */
const MAX_ENTRIES = 500;

export interface FilesystemServiceOptions {
  enabled: boolean;
  picker: DirectoryPicker;
  pickerTimeoutMs: number;
  /** Overridable so a test need not depend on the runner's home directory. */
  homeDirectory?: string;
}

export class FilesystemService {
  private readonly homeDirectory: string;

  constructor(private readonly options: FilesystemServiceOptions) {
    this.homeDirectory = options.homeDirectory ?? os.homedir();
  }

  /**
   * Opens the host's folder dialog and returns what the user chose.
   *
   * Null means they cancelled, which is an ordinary outcome and not an error —
   * the UI simply stays where it was.
   */
  async pickDirectory(): Promise<SelectedDirectory | null> {
    this.assertEnabled();

    let chosen: string | null;
    try {
      chosen = await this.options.picker.pick({ timeoutMs: this.options.pickerTimeoutMs });
    } catch (error) {
      if (error instanceof DirectoryPickerUnavailableError) {
        throw new AppError(ERROR_CODES.DIRECTORY_PICKER_UNAVAILABLE, error.message, {
          context: { platform: process.platform },
        });
      }
      throw AppError.internal('The folder dialog could not be opened', error);
    }

    if (chosen === null) return null;

    // The dialog can only return a directory, but it is still a path arriving
    // from outside this process, so it is validated like any other.
    return this.describe(await this.resolveDirectory(chosen));
  }

  /**
   * Subdirectories of one directory, for the in-app browser used where no
   * native dialog exists.
   *
   * Directories only. A file listing would be a way to learn what is on
   * someone's disk without ever indexing anything, and the intake flow has no
   * use for one.
   */
  async listDirectories(requested?: string): Promise<DirectoryListing> {
    this.assertEnabled();

    const absolute = await this.resolveDirectory(requested ?? this.homeDirectory);

    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      throw this.readError(absolute, error);
    }

    const names = new Set(dirents.map((entry) => entry.name.toLowerCase()));

    const entries: DirectoryEntry[] = dirents
      .filter((entry) => entry.isDirectory())
      // Ignored directories are noise here for the same reason they are noise
      // to the scanner: nobody means to index `node_modules`.
      .filter((entry) => !DEFAULT_IGNORE_RULES.ignoresDirectory(entry.name))
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.join(absolute, entry.name),
        // Resolved per child below; seeded false so the shape is complete.
        isProjectRoot: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const truncated = entries.length > MAX_ENTRIES;
    const page = truncated ? entries.slice(0, MAX_ENTRIES) : entries;

    // One extra readdir per child is what makes the browser usable — the folder
    // you are looking for is marked before you open it — and it is bounded by
    // the page size, not by the tree.
    await Promise.all(
      page.map(async (entry) => {
        entry.isProjectRoot = await this.looksLikeProject(entry.path);
      }),
    );

    const parent = path.dirname(absolute);

    return {
      path: absolute,
      parentPath: parent === absolute ? null : parent,
      // Whether the directory we are *in* is itself a project, so the browser
      // can offer "index this folder" without making you go up and back down.
      isProjectRoot: hasMarker(names),
      entries: page,
      truncated,
    };
  }

  /**
   * Walks a candidate project and reports what is in it.
   *
   * This is what the "Selected project" card is filled from, and it runs before
   * anything is created in the database: picking the wrong folder should cost a
   * second, not a full indexing run.
   */
  async inspectProject(requested: string): Promise<ProjectMetadata> {
    this.assertEnabled();

    let result;
    try {
      result = await scanProject(requested);
    } catch (error) {
      throw this.scanError(requested, error);
    }

    if (result.metadata.sourceFiles === 0) {
      throw new AppError(
        ERROR_CODES.NO_SOURCE_FILES,
        `No supported source files were found in ${result.metadata.name}`,
        { context: { path: result.metadata.rootPath, files: result.metadata.totalFiles } },
      );
    }

    return result.metadata;
  }

  private describe(absolute: string): SelectedDirectory {
    return { path: absolute, name: path.basename(absolute) || absolute };
  }

  private async resolveDirectory(requested: string): Promise<string> {
    try {
      return await resolveProjectRoot(requested);
    } catch (error) {
      throw this.scanError(requested, error);
    }
  }

  private async looksLikeProject(directory: string): Promise<boolean> {
    try {
      const entries = await readdir(directory);
      return entries.some((name) => PROJECT_MARKERS.has(name.toLowerCase()));
    } catch {
      // Unreadable: not a reason to hide the directory, only a reason not to
      // claim anything about it.
      return false;
    }
  }

  private assertEnabled(): void {
    if (this.options.enabled) return;
    throw new AppError(
      ERROR_CODES.FILESYSTEM_ACCESS_DISABLED,
      'Local filesystem access is disabled on this server',
    );
  }

  /** Turns a scanner failure into the error the client should see. */
  private scanError(requested: string, error: unknown): AppError {
    if (!(error instanceof ProjectScanError)) {
      return AppError.internal('The project directory could not be read', error);
    }

    if (error.reason === 'unreadable') {
      return new AppError(
        ERROR_CODES.DIRECTORY_NOT_READABLE,
        'Permission denied while accessing the project.',
        { context: { path: requested } },
      );
    }

    if (error.reason === 'not-a-directory') {
      return new AppError(
        ERROR_CODES.INVALID_PROJECT_PATH,
        'That path is a file, not a project folder.',
        { context: { path: requested } },
      );
    }

    return new AppError(
      ERROR_CODES.DIRECTORY_NOT_FOUND,
      'Unable to read project directory.',
      { context: { path: requested } },
    );
  }

  private readError(absolute: string, error: unknown): AppError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return new AppError(
        ERROR_CODES.DIRECTORY_NOT_READABLE,
        'Permission denied while accessing the project.',
        { context: { path: absolute } },
      );
    }
    return new AppError(ERROR_CODES.DIRECTORY_NOT_FOUND, 'Unable to read project directory.', {
      context: { path: absolute },
    });
  }
}

function hasMarker(names: ReadonlySet<string>): boolean {
  for (const marker of PROJECT_MARKERS) {
    if (names.has(marker)) return true;
  }
  return false;
}
