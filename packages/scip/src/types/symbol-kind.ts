/**
 * Normalised symbol kinds.
 *
 * SCIP's `SymbolInformation.Kind` enum carries ~85 language-specific values.
 * We collapse them into a small, language-neutral vocabulary here so that the
 * graph builder never has to know that "SingletonMethod" and "StaticMethod"
 * came from different ecosystems.
 */
export const SCIP_SYMBOL_KINDS = [
  'namespace',
  'module',
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'enum-member',
  'type',
  'type-parameter',
  'function',
  'method',
  'constructor',
  'accessor',
  'property',
  'field',
  'constant',
  'variable',
  'parameter',
  'macro',
  'file',
  'package',
  'unknown',
] as const;

export type ScipSymbolKind = (typeof SCIP_SYMBOL_KINDS)[number];

/** Kinds that can appear as the source of a CALLS relationship. */
export const CALLABLE_KINDS: ReadonlySet<ScipSymbolKind> = new Set<ScipSymbolKind>([
  'function',
  'method',
  'constructor',
  'accessor',
]);

/** Kinds that own other symbols and can act as a containment scope. */
export const CONTAINER_KINDS: ReadonlySet<ScipSymbolKind> = new Set<ScipSymbolKind>([
  'namespace',
  'module',
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'package',
  'file',
]);
