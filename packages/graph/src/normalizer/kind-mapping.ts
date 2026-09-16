import type { CodeNodeType } from '@ckg/shared';
import type { ScipSymbolKind } from '@ckg/scip';

/**
 * SCIP symbol kind -> graph node type.
 *
 * This table is the *only* place where the analysis vocabulary meets the graph
 * vocabulary. Because `@ckg/scip` already normalises every language's kinds
 * into one neutral set, nothing language-specific appears here — which is what
 * keeps the builder itself language agnostic.
 *
 * Architectural node types (`api`, `table`, `queue`, ...) are absent by design:
 * no compiler emits them. They are produced by the analyzers in
 * `@ckg/analysis`, from syntax the compiler has no opinion about.
 */
const NODE_TYPE_BY_KIND: Record<ScipSymbolKind, CodeNodeType | null> = {
  namespace: 'module',
  module: 'module',
  package: 'module',
  file: 'file',

  class: 'class',
  struct: 'class',
  interface: 'interface',
  trait: 'interface',

  enum: 'enum',
  type: 'type',
  'enum-member': 'property',

  function: 'function',
  method: 'method',
  constructor: 'method',
  accessor: 'method',

  property: 'property',
  field: 'property',
  constant: 'variable',
  variable: 'variable',

  // Excluded from the graph: they multiply node counts without adding
  // navigational value, and none of them can be the target of a call. The
  // `parameter` node type exists in the model — a later analyzer may populate
  // it — but the SCIP layer does not, because scip-typescript emits one symbol
  // per parameter of every signature in the repository.
  parameter: null,
  'type-parameter': null,
  macro: null,
  unknown: null,
};

export function nodeTypeForSymbolKind(kind: ScipSymbolKind): CodeNodeType | null {
  return NODE_TYPE_BY_KIND[kind];
}

/** Node types that can be the source or target of a CALLS edge. */
const CALLABLE_NODE_TYPES: ReadonlySet<CodeNodeType> = new Set<CodeNodeType>(['function', 'method']);

export function isCallableNodeType(type: CodeNodeType): boolean {
  return CALLABLE_NODE_TYPES.has(type);
}

/**
 * Node types that own other symbols. Used to lift member-level edges to their
 * containers so the graph reads at an architectural level too.
 */
const CONTAINER_NODE_TYPES: ReadonlySet<CodeNodeType> = new Set<CodeNodeType>([
  'class',
  'interface',
  'type',
  'enum',
  'module',
  'file',
]);

export function isContainerNodeType(type: CodeNodeType): boolean {
  return CONTAINER_NODE_TYPES.has(type);
}
