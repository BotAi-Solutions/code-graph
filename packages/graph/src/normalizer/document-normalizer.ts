import type { CodeNodeType } from '@ckg/shared';
import type { ScipDocument, ScipOccurrence, ScipRange, ScipSymbol } from '@ckg/scip';
import { nodeTypeForSymbolKind } from './kind-mapping.js';
import { declaresForeignModule } from './qualified-name.js';
import { rangeContains, rangeSize } from './position.js';

/**
 * Turns one SCIP document into the flat, position-resolved shape the builder
 * consumes: which symbols this file defines, and — for every reference — which
 * definition it appears inside.
 *
 * Doing this per document keeps the builder free of position arithmetic and
 * makes the interesting logic (scope resolution) independently testable.
 */

export interface NormalizedDefinition {
  symbol: ScipSymbol;
  nodeType: CodeNodeType;
  /** Range of the name itself. */
  nameRange: ScipRange;
  /** Range of the whole declaration, when the indexer provides one. */
  enclosingRange: ScipRange | undefined;
}

export interface NormalizedReference {
  /** SCIP symbol being referenced. May be defined in another document. */
  targetSymbolId: string;
  /**
   * SCIP symbol of the definition this reference sits inside — the caller.
   * Falls back to the file's own symbol when the reference is at top level.
   */
  enclosingSymbolId: string | null;
  isWriteAccess: boolean;
}

export interface NormalizedDocument {
  relativePath: string;
  language: string;
  /** The symbol SCIP uses for the file scope itself, if the document has one. */
  fileSymbolId: string | null;
  definitions: NormalizedDefinition[];
  references: NormalizedReference[];
}

export interface NormalizeOptions {
  /** Overrides an empty `Document.language`; indexers often omit it. */
  language?: string | undefined;
}

export function normalizeDocument(
  document: ScipDocument,
  options: NormalizeOptions = {},
): NormalizedDocument {
  const definitionOccurrences = new Map<string, ScipOccurrence>();
  for (const occurrence of document.occurrences) {
    if (!occurrence.isDefinition) continue;
    if (!definitionOccurrences.has(occurrence.symbolId)) {
      definitionOccurrences.set(occurrence.symbolId, occurrence);
    }
  }

  let fileSymbolId: string | null = null;
  const definitions: NormalizedDefinition[] = [];

  for (const symbol of document.symbols) {
    if (symbol.identity.isLocal) continue;

    // `declare module 'pg'` describes another package, not this repository.
    if (declaresForeignModule(symbol.identity)) continue;

    if (symbol.kind === 'file') {
      // The file scope is represented by the `file` node the builder creates
      // from the path, so it is recorded but not emitted as a symbol node.
      fileSymbolId = symbol.id;
      continue;
    }

    const nodeType = nodeTypeForSymbolKind(symbol.kind);
    if (!nodeType) continue;

    const occurrence = definitionOccurrences.get(symbol.id);
    if (!occurrence) continue;

    definitions.push({
      symbol,
      nodeType,
      nameRange: {
        startLine: occurrence.startLine,
        startCharacter: occurrence.startCharacter,
        endLine: occurrence.endLine,
        endCharacter: occurrence.endCharacter,
      },
      enclosingRange: occurrence.enclosingRange,
    });
  }

  // Scopes we can attribute references to, innermost first.
  const scopes = definitions
    .filter((definition): definition is NormalizedDefinition & { enclosingRange: ScipRange } =>
      definition.enclosingRange !== undefined,
    )
    .sort((a, b) => rangeSize(a.enclosingRange) - rangeSize(b.enclosingRange));

  const references: NormalizedReference[] = [];

  for (const occurrence of document.occurrences) {
    if (occurrence.isDefinition) continue;
    if (occurrence.symbolId.startsWith('local ')) continue;

    const position = { line: occurrence.startLine, character: occurrence.startCharacter };
    const scope = scopes.find((candidate) => rangeContains(candidate.enclosingRange, position));

    references.push({
      targetSymbolId: occurrence.symbolId,
      enclosingSymbolId: scope?.symbol.id ?? fileSymbolId,
      isWriteAccess: occurrence.isWriteAccess,
    });
  }

  return {
    relativePath: document.relativePath,
    language: document.language || options.language || '',
    fileSymbolId,
    definitions,
    references,
  };
}
