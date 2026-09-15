import type { SupportedLanguage } from '@ckg/shared';
import type { ScipIndex } from '../types/index.js';

/**
 * Optional, language-specific post-processing of a parsed index.
 *
 * SCIP's `SymbolInformation.kind` is optional and several production indexers
 * (scip-typescript among them) never populate it, which leaves classes,
 * interfaces, enums and type aliases indistinguishable. A refiner is where a
 * language may recover that distinction. The graph builder stays language
 * agnostic; only refiners know about syntax.
 */
export interface ScipSymbolRefiner {
  readonly name: string;
  supports(language: SupportedLanguage): boolean;
  refine(index: ScipIndex, context: RefineContext): Promise<ScipIndex>;
}

export interface RefineContext {
  repositoryPath: string;
}

/** Used when no refiner is registered for a language. */
export class NoopSymbolRefiner implements ScipSymbolRefiner {
  readonly name = 'noop';

  supports(): boolean {
    return true;
  }

  async refine(index: ScipIndex): Promise<ScipIndex> {
    return index;
  }
}
