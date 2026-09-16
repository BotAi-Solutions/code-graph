import type { SourceFile, SourceFileSet } from '@ckg/graph';
import { BindingTable } from './bindings.js';
import { isAnalysableModule, parseModule, type ts } from './ast.js';
import { ModuleResolver } from './module-resolver.js';

/**
 * The repository's modules, parsed once.
 *
 * Seven analyzers each walking their own AST of the same file would be seven
 * parses and — worse — seven chances to disagree. They share this instead: one
 * syntax tree and one binding table per file, built on first use and cached.
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

    const sourceFile = parseModule(file);
    const parsed: ParsedModule = {
      relativePath,
      sourceFile,
      bindings: new BindingTable(relativePath, sourceFile, this.resolver),
    };

    this.cache.set(relativePath, parsed);
    return parsed;
  }

  /** Every parsed module, in path order. */
  *modules(): Generator<ParsedModule> {
    for (const file of this.analysable) {
      const parsed = this.module(file.relativePath);
      if (parsed) yield parsed;
    }
  }
}
