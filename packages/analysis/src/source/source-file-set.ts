import type { SourceFile, SourceFileSet } from '@ckg/graph';
import type { ScanLimits } from '@ckg/language-detection';
import type { IndexingError } from '@ckg/shared';

/**
 * What the read left out, cause by cause. `truncated` on the set is true
 * exactly when the scan was truncated or one of the two count limits here was
 * reached; skipped oversized files are reported but do not set it.
 */
export interface SourceReadReport {
  /** Files the walk found that the analyzers read (source, manifests, schemas). */
  candidateFiles: number;
  /** Files actually held in the set. */
  filesRead: number;
  bytesRead: number;
  /** The walk's own limits; null when the scan did not record them. */
  scan: ScanLimits | null;
  /** Candidates beyond the file-count limit, never opened. */
  fileLimit: { limit: number; reached: boolean; filesNotRead: number };
  /** Files larger than the per-file limit, skipped one by one. */
  fileSizeLimit: { limitBytes: number; filesSkipped: number };
  /**
   * Files from the first one that would have taken the total past the limit
   * onward, in read order, which were not kept.
   */
  totalSizeLimit: { limitBytes: number; reached: boolean; filesNotRead: number };
}

/**
 * The repository's source, read once.
 *
 * Seven analyzers over the same files must not mean seven passes over the
 * disk, and they must all see exactly the same bytes — otherwise a finding
 * could depend on which analyzer read the file first. So the walk happens once,
 * the result is immutable, and this is the only thing analyzers are handed.
 */
export class InMemorySourceFileSet implements SourceFileSet {
  private readonly files: readonly SourceFile[];
  private readonly byRelativePath: Map<string, SourceFile>;

  constructor(
    files: readonly SourceFile[],
    readonly truncated = false,
    /**
     * Files the walk found but could not read. Carried with the set rather
     * than thrown, so every analyzer sees the same account of what was
     * readable and the run reports it once at the end.
     */
    readonly failures: readonly IndexingError[] = [],
    /** How the set was read, when it came from `loadSourceFiles`. */
    readonly report: SourceReadReport | null = null,
  ) {
    // Path order, so every analyzer visits files in the same sequence and the
    // graph is reproducible.
    this.files = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    this.byRelativePath = new Map(this.files.map((file) => [file.relativePath, file]));
  }

  all(): readonly SourceFile[] {
    return this.files;
  }

  byPath(relativePath: string): SourceFile | undefined {
    return this.byRelativePath.get(relativePath);
  }

  matching(...suffixes: string[]): readonly SourceFile[] {
    if (suffixes.length === 0) return this.files;
    return this.files.filter((file) =>
      suffixes.some((suffix) => file.relativePath.endsWith(suffix)),
    );
  }

  /** Every path in the set, for module resolution. */
  paths(): readonly string[] {
    return this.files.map((file) => file.relativePath);
  }
}

export const EMPTY_SOURCE_FILE_SET = new InMemorySourceFileSet([]);
