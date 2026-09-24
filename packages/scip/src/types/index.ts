import type { SupportedLanguage } from '@ckg/shared';
import type { ScipSymbolKind } from './symbol-kind.js';

export * from './symbol-kind.js';

/**
 * The internal representation of a SCIP index.
 *
 * Everything downstream (`@ckg/graph`, the worker, the API) codes against these
 * types. Raw protobuf shapes never escape `packages/scip/src/parser`.
 */

/** A parsed SCIP symbol identifier, e.g. `scip-typescript npm foo 1.0 \`src/a.ts\`/Bar#baz().` */
export interface ScipSymbolDescriptor {
  name: string;
  suffix: ScipDescriptorSuffix;
  /** Present for method descriptors that carry an overload disambiguator. */
  disambiguator?: string;
}

export const SCIP_DESCRIPTOR_SUFFIXES = [
  'namespace',
  'type',
  'term',
  'method',
  'type-parameter',
  'parameter',
  'meta',
  'macro',
  'local',
] as const;

export type ScipDescriptorSuffix = (typeof SCIP_DESCRIPTOR_SUFFIXES)[number];

export interface ScipSymbolIdentity {
  /** The raw SCIP symbol string; stable across runs and the join key we use. */
  id: string;
  scheme: string;
  packageManager: string;
  packageName: string;
  packageVersion: string;
  descriptors: ScipSymbolDescriptor[];
  /**
   * The symbol string of the lexically owning symbol (the class for a method,
   * the file namespace for a class), or null at the top of the chain.
   */
  ownerId: string | null;
  /** Local symbols (`local 3`) are file-scoped and not globally addressable. */
  isLocal: boolean;
}

export interface ScipRelationship {
  symbolId: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipSymbol {
  id: string;
  name: string;
  kind: ScipSymbolKind;
  signature?: string;
  documentation?: string[];
  /** SCIP symbol id of the lexically enclosing symbol, when the indexer emits it. */
  enclosingSymbolId?: string;
  relationships: ScipRelationship[];
  identity: ScipSymbolIdentity;
  /**
   * Set when a variable is declared with a function as its value
   * (`const f = () => {}`, `const f = function () {}`), which a language
   * refiner recovers from syntax. Such a symbol has kind `function`. Only the
   * occurrences marked `isCall` invoke it. Every other occurrence is the
   * function being used as a value.
   */
  functionValue?: ScipFunctionValue;
}

/** How a function-valued variable was declared. */
export type ScipFunctionValue = 'arrow-function' | 'function-expression';

export interface ScipRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ScipOccurrence extends ScipRange {
  symbolId: string;
  isDefinition: boolean;
  isImport: boolean;
  isWriteAccess: boolean;
  isReadAccess: boolean;
  /**
   * Span of the whole definition body (not just its name), when the indexer
   * provides it. This is what lets the graph builder attribute a reference to
   * the function it appears inside.
   */
  enclosingRange?: ScipRange;
  /**
   * True when the occurrence is the callee of a call expression: `f()`,
   * `await f()`, `ns.f()`. SCIP has no such role, so this is set only by a
   * language refiner that read the syntax. Absent means unknown, not "no call".
   */
  isCall?: boolean;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  symbols: ScipSymbol[];
  occurrences: ScipOccurrence[];
}

export interface ScipToolInfo {
  name: string;
  version: string;
}

export interface ScipMetadata {
  projectRoot: string;
  toolInfo: ScipToolInfo;
  protocolVersion: number;
}

export interface ScipIndex {
  metadata: ScipMetadata;
  documents: ScipDocument[];
  /** Symbols defined outside the indexed project (dependencies, stdlib). */
  externalSymbols: ScipSymbol[];
}

// --- Indexer contract -----------------------------------------------------

export interface ScipIndexOptions {
  /** Directory the `index.scip` is written to. Defaults to the repository. */
  outputDirectory?: string;
  /** Hard ceiling on indexer runtime. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScipIndexResult {
  /** Absolute path of the produced `index.scip`. */
  indexPath: string;
  language: SupportedLanguage;
  indexerName: string;
  toolVersion: string | null;
  durationMs: number;
  /** Tail of the indexer's own diagnostics. Never contains source code. */
  diagnostics: string[];
}

/**
 * The seam between "we need a SCIP index" and "how that index gets produced".
 * Implementations wrap language-specific indexers; callers only ever see this.
 */
export interface ScipIndexer {
  readonly name: string;
  supports(language: SupportedLanguage): boolean;
  index(repositoryPath: string, options?: ScipIndexOptions): Promise<ScipIndexResult>;
}
