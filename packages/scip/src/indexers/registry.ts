import type { SupportedLanguage } from '@ckg/shared';
import type { ScipIndexer } from '../types/index.js';
import type { ScipSymbolRefiner } from '../adapters/symbol-refiner.js';
import { NoopSymbolRefiner } from '../adapters/symbol-refiner.js';
import { TypeScriptSymbolRefiner } from '../adapters/typescript-symbol-refiner.js';
import { TypeScriptScipIndexer } from './typescript.indexer.js';

/**
 * Language -> indexer lookup. Adding scip-python means registering one more
 * implementation; no call site changes.
 */
export class ScipIndexerRegistry {
  private readonly indexers: ScipIndexer[] = [];
  private readonly refiners: ScipSymbolRefiner[] = [];
  private readonly fallbackRefiner = new NoopSymbolRefiner();

  register(indexer: ScipIndexer): this {
    this.indexers.push(indexer);
    return this;
  }

  registerRefiner(refiner: ScipSymbolRefiner): this {
    this.refiners.push(refiner);
    return this;
  }

  resolve(language: SupportedLanguage): ScipIndexer | null {
    return this.indexers.find((indexer) => indexer.supports(language)) ?? null;
  }

  resolveRefiner(language: SupportedLanguage): ScipSymbolRefiner {
    return this.refiners.find((refiner) => refiner.supports(language)) ?? this.fallbackRefiner;
  }

  supportedLanguages(candidates: readonly SupportedLanguage[]): SupportedLanguage[] {
    return candidates.filter((language) => this.resolve(language) !== null);
  }

  list(): readonly ScipIndexer[] {
    return this.indexers;
  }
}

export interface DefaultRegistryOptions {
  typescriptCommand?: string;
  timeoutMs?: number;
  executableSearchRoots?: string[];
}

export function createDefaultIndexerRegistry(
  options: DefaultRegistryOptions = {},
): ScipIndexerRegistry {
  const registry = new ScipIndexerRegistry();

  registry.register(
    new TypeScriptScipIndexer({
      ...(options.typescriptCommand ? { command: options.typescriptCommand } : {}),
      ...(options.timeoutMs ? { defaultTimeoutMs: options.timeoutMs } : {}),
      ...(options.executableSearchRoots
        ? { executableSearchRoots: options.executableSearchRoots }
        : {}),
    }),
  );

  registry.registerRefiner(new TypeScriptSymbolRefiner());

  return registry;
}
