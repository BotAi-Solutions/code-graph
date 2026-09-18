import type { FileCategory, SupportedLanguage } from '@ckg/shared';

/**
 * `SupportedLanguage` is declared in `@ckg/shared` because the graph, database
 * and SCIP layers all speak it; this package owns *detection* and re-exports the
 * union so callers can depend on a single import.
 */
export type { SupportedLanguage } from '@ckg/shared';
export { SUPPORTED_LANGUAGES, IMPLEMENTED_LANGUAGES, isSupportedLanguage } from '@ckg/shared';

export interface LanguageDetectionResult {
  languages: SupportedLanguage[];
  primaryLanguage?: SupportedLanguage;
}

/** What a detector is allowed to look at. Detectors never touch the disk. */
export interface RepositoryScan {
  rootPath: string;
  /** Repository-relative POSIX paths of every scanned file. */
  files: string[];
  /** Lower-cased basenames present at the repository root. */
  rootFiles: Set<string>;
  /** Count of files per lower-cased extension, e.g. `.ts` -> 42. */
  extensionCounts: Map<string, number>;
  /**
   * Count of files per category, e.g. `document` -> 12.
   *
   * Computed during the walk from the path alone, so it costs nothing beyond
   * the walk itself and is available to the language detectors, the statistics
   * panel and the source loader without any of them re-deriving it.
   */
  categoryCounts: Map<FileCategory, number>;
  /** Directories walked, ignored ones excluded. The root itself is not counted. */
  directoryCount: number;
  /** True when the scan stopped early because the repository is very large. */
  truncated: boolean;
}

export interface LanguageEvidence {
  language: SupportedLanguage;
  /** Higher wins. Comparable only between detectors in this package. */
  score: number;
  /** Human-readable reasons, surfaced in logs and the analysis record. */
  markers: string[];
  /** Number of analysable source files found for this language. */
  sourceFileCount: number;
}

export interface LanguageDetector {
  readonly language: SupportedLanguage;
  /** Returns null when the language is not present at all. */
  detect(scan: RepositoryScan): LanguageEvidence | null;
}
