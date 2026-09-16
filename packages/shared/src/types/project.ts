import type { SupportedLanguage } from './language.js';

/**
 * What a local directory looks like before it is a project.
 *
 * These types describe the *intake* half of the pipeline — choosing a folder,
 * sizing it up, watching it being indexed — as distinct from the graph that
 * comes out the other end. They cross the API boundary, so they live here with
 * the rest of the wire vocabulary; the scanner that produces them lives in
 * `@ckg/language-detection` and the UI that renders them in `apps/web`.
 */

/** A directory the user chose. Nothing else about their filesystem. */
export interface SelectedDirectory {
  /** Absolute path, as the local runtime resolved it. */
  path: string;
  /** Basename, which is what the project is called by default. */
  name: string;
}

/** One entry in the in-app directory browser. Directories only, no files. */
export interface DirectoryEntry {
  name: string;
  path: string;
  /** True when the walk found a manifest suggesting this is a project root. */
  isProjectRoot: boolean;
}

/** A page of the directory browser: where we are, and what is under it. */
export interface DirectoryListing {
  path: string;
  /** Parent directory, or null at a filesystem root. */
  parentPath: string | null;
  /** True when this directory is itself a project, so it can be chosen as-is. */
  isProjectRoot: boolean;
  entries: DirectoryEntry[];
  /** True when the listing stopped early because the directory is very large. */
  truncated: boolean;
}

/**
 * What one pass over a project directory establishes, before any parsing.
 *
 * Deliberately counts rather than contents: this is what the "Selected project"
 * card shows so someone can tell they picked the right folder, and what the
 * indexer sizes its work from. No file list crosses the wire.
 */
export interface ProjectMetadata {
  rootPath: string;
  name: string;
  /** Every file the walk saw, ignored directories excluded. */
  totalFiles: number;
  /** Files in a language the platform can detect. */
  sourceFiles: number;
  /** Source-file counts per language, highest first when rendered. */
  languages: Partial<Record<SupportedLanguage, number>>;
  directories: number;
  /** True when the walk hit its file or depth cap; counts are a lower bound. */
  truncated: boolean;
}

/**
 * A file the pipeline could not read or parse.
 *
 * One unparsable file must never end a run — a repository with a broken file in
 * it is still worth a graph — so the failure is recorded against the file and
 * the walk continues. Holds the reason, never the file's contents.
 */
export interface IndexingError {
  /** Repository-relative POSIX path. */
  file: string;
  error: string;
}
