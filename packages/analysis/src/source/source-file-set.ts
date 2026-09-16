import type { SourceFile, SourceFileSet } from '@ckg/graph';
import type { IndexingError } from '@ckg/shared';

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
