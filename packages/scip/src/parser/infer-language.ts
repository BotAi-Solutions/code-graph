import { languageFromPath } from '@ckg/language-detection';
import type { ScipIndex } from '../types/index.js';

/**
 * Fills in `Document.language` where the indexer left it blank.
 *
 * `Document.language` is optional in SCIP and several production indexers
 * (scip-typescript among them) never set it. Recovering it here means every
 * consumer downstream can rely on the field, and keeps extension-to-language
 * knowledge inside the SCIP layer instead of leaking into the graph builder.
 */
export function inferDocumentLanguages(index: ScipIndex): ScipIndex {
  const documents = index.documents.map((document) =>
    document.language
      ? document
      : { ...document, language: languageFromPath(document.relativePath) ?? '' },
  );

  return { ...index, documents };
}
