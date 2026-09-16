import type { SymbolInfo } from './schemas/api.schema.js';
import type { CodeNode } from './types/graph.js';

/**
 * Reads a node's free-form `metadata` bag into the named fields the inspector
 * prints.
 *
 * Every value here is copied, never inferred. A property no analyzer recorded
 * comes back `null`, which is the honest answer — the alternative is a panel
 * that quietly asserts a symbol is public, or belongs to Express, because those
 * are the usual cases. The one field that is *computed* is `module`, and only
 * from a fact the indexer already stored: the directory its file sits in.
 *
 * It lives in `@ckg/shared` because it is vocabulary — what `metadata.vendor`
 * means is the same question as what `ROUTES_TO` means, and both belong to the
 * one place that owns the graph's language.
 */

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The directory a file path sits in, or null for a path with no directory. */
function directoryOf(filePath: string | undefined): string | null {
  if (filePath === undefined) return null;
  const cut = filePath.lastIndexOf('/');
  return cut > 0 ? filePath.slice(0, cut) : null;
}

export interface SymbolEvidence {
  /**
   * Whether another module imports this symbol by name.
   *
   * `true` when an EXPORTS edge points at it. Never `false` from absence: a
   * project whose import analyzer found nothing would otherwise have every
   * symbol claiming to be private.
   */
  exported?: boolean | null;
}

export function symbolInfoOf(node: CodeNode, evidence: SymbolEvidence = {}): SymbolInfo {
  const metadata = node.metadata ?? {};

  const isApi = node.type === 'api';
  const isDataStore = node.type === 'table' || node.type === 'database';
  const isMessaging = node.type === 'queue' || node.type === 'event';

  return {
    name: node.name,
    qualifiedName: node.qualifiedName ?? null,
    type: node.type,
    language: text(metadata.language),
    filePath: node.filePath ?? null,
    startLine: node.startLine ?? null,
    startCharacter: node.startCharacter ?? null,
    endLine: node.endLine ?? null,
    endCharacter: node.endCharacter ?? null,
    exported: evidence.exported ?? null,
    // Nothing in the pipeline records visibility yet. The field exists so the
    // contract is stable when an indexer starts reporting it; until then it is
    // null rather than a guess from a naming convention.
    visibility: text(metadata.visibility),
    module: text(metadata.module) ?? directoryOf(node.filePath),
    framework: text(metadata.framework),
    apiRoute: isApi
      ? { method: text(metadata.httpMethod), path: text(metadata.path) }
      : null,
    databaseResource: isDataStore ? (node.qualifiedName ?? node.name) : null,
    externalService:
      node.type === 'external_service' ? (text(metadata.vendor) ?? node.name) : null,
    messagingResource: isMessaging
      ? (text(metadata.queue) ?? text(metadata.event) ?? node.name)
      : null,
    scipSymbol: text(metadata.scipSymbol),
    role: text(metadata.role),
  };
}
