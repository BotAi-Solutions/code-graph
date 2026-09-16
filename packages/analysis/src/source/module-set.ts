import type { SourceFile, SourceFileSet } from '@ckg/graph';
import type { IndexingError } from '@ckg/shared';
import { BindingTable } from './bindings.js';
import { isAnalysableModule, parseModule, type ts } from './ast.js';
import { ModuleResolver } from './module-resolver.js';

/**
 * The repository's modules, parsed once.
 *
 * Seven analyzers each walking their own AST of the same file would be seven
 * parses and — worse — seven chances to disagree. They share this instead: one
 * syntax tree and one binding table per file, built on first use and cached.
 *
 * It is also the one place a source file is parsed, which makes it the one
 * place a *failure* to parse has to be handled. A file that cannot be turned
 * into a tree is recorded and skipped: the compiler's parser is error-tolerant
 * by design and recovers from almost anything, so a file that defeats it is
 * genuinely broken — and one broken file is no reason to abandon the other
 * nine hundred.
 */

export interface ParsedModule {
  relativePath: string;
  sourceFile: ts.SourceFile;
  bindings: BindingTable;
}

export class ModuleSet {
  readonly resolver: ModuleResolver;

  private readonly analysable: readonly SourceFile[];
  private readonly cache = new Map<string, ParsedModule>();
  private readonly parseFailures = new Map<string, IndexingError>();

  constructor(private readonly sources: SourceFileSet) {
    this.resolver = new ModuleResolver(sources.all().map((file) => file.relativePath));
    this.analysable = sources.all().filter((file) => isAnalysableModule(file.relativePath));
  }

  /** Paths of every module that can be parsed, in path order. */
  paths(): readonly string[] {
    return this.analysable.map((file) => file.relativePath);
  }

  module(relativePath: string): ParsedModule | undefined {
    const cached = this.cache.get(relativePath);
    if (cached) return cached;

    const file = this.sources.byPath(relativePath);
    if (!file || !isAnalysableModule(relativePath)) return undefined;
    // Already known to be unparsable: do not pay for the failure again, and do
    // not report it a second time.
    if (this.parseFailures.has(relativePath)) return undefined;

    let parsed: ParsedModule;
    try {
      const sourceFile = parseModule(file);
      parsed = {
        relativePath,
        sourceFile,
        bindings: new BindingTable(relativePath, sourceFile, this.resolver),
      };
    } catch (error) {
      this.parseFailures.set(relativePath, {
        file: relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    this.cache.set(relativePath, parsed);
    return parsed;
  }

  /** Files that could not be parsed, in path order. */
  failures(): IndexingError[] {
    return [...this.parseFailures.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  /** Every parsed module, in path order. */
  *modules(): Generator<ParsedModule> {
    for (const file of this.analysable) {
      const parsed = this.module(file.relativePath);
      if (parsed) yield parsed;
    }
  }
}
