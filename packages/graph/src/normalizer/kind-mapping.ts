import type { CodeNodeType } from '@ckg/shared';
import type { ScipSymbolKind } from '@ckg/scip';

/**
 * SCIP symbol kind -> graph node type.
 *
 * This table is the *only* place where the analysis vocabulary meets the graph
 * vocabulary. Because `@ckg/scip` already normalises every language's kinds
 * into one neutral set, nothing language-specific appears here — which is what
 * keeps the builder itself language agnostic.
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

  enum: 'type',
  type: 'type',
  'enum-member': 'variable',

  function: 'function',
  method: 'method',
  constructor: 'method',
  accessor: 'method',

  property: 'variable',
  field: 'variable',
  constant: 'variable',
  variable: 'variable',

  // Excluded from the graph: they multiply node counts without adding
  // navigational value, and none of them can be the target of a call.
  parameter: null,
  'type-parameter': null,
  macro: null,
  unknown: null,
};

export function nodeTypeForSymbolKind(kind: ScipSymbolKind): CodeNodeType | null {
  return NODE_TYPE_BY_KIND[kind];
}

/** Node types that can be the source of a CALLS edge. */
const CALLABLE_NODE_TYPES: ReadonlySet<CodeNodeType> = new Set<CodeNodeType>(['function', 'method']);

export function isCallableNodeType(type: CodeNodeType): boolean {
  return CALLABLE_NODE_TYPES.has(type);
}

/**
 * Node types that can own other symbols. Used to lift member-level edges to
 * their containers so the graph reads at an architectural level too.
 */
const CONTAINER_NODE_TYPES: ReadonlySet<CodeNodeType> = new Set<CodeNodeType>([
  'class',
  'interface',
  'type',
  'module',
  'file',
]);

export function isContainerNodeType(type: CodeNodeType): boolean {
  return CONTAINER_NODE_TYPES.has(type);
}
