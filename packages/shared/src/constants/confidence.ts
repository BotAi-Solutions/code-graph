import type { ConfidenceLevel, EdgeEvidence, EvidenceMethod, EvidenceSource } from '../types/graph.js';

/**
 * The confidence policy, in one place.
 *
 * Before this existed every analyzer picked a level per call site, which meant
 * "medium" could mean three different things depending on which file you read.
 * It now means exactly one thing: *a resolution step stood between the
 * observation and the claim, and that step could in principle be wrong.*
 *
 * A producer names the **kind of observation** it made and gets the level back.
 * It never writes a level, and it never writes a number.
 */

/**
 * Kinds of observation the pipeline can make, and what each is worth.
 *
 * Grouped by what the observation rests on rather than by which analyzer makes
 * it, because two analyzers making the same kind of observation must produce
 * the same confidence.
 */
export const CONFIDENCE_POLICY = {
  // --- high: the artefact says so, and says so unambiguously ---------------
  /** SCIP reported the symbol relationship. The compiler's own view. */
  scipSymbol: 'high',
  /** An unambiguous syntactic fact: a decorator argument, an import specifier. */
  astDirect: 'high',
  /** A key in a specification or manifest: `paths./users.post`, a dependency. */
  declaredInSpec: 'high',
  /** A SQL statement written as a literal, naming its table outright. */
  sqlLiteral: 'high',
  /** Structure the parser observed directly: a heading's place in a document. */
  parsedStructure: 'high',
  /** A declared route and a declared operation agree on method and path. */
  exactRouteMatch: 'high',
  /** A document link resolving to a file that exists in the repository. */
  resolvedLink: 'high',

  // --- medium: real, but one resolution step could be wrong ----------------
  /** A member's finding lifted to the class or file that owns it. */
  derivedFromContainer: 'medium',
  /** A statement assembled from a template literal rather than written out. */
  interpolatedStatement: 'medium',
  /** A package imported but not declared in the manifest. */
  undeclaredDependency: 'medium',
  /** A distinctive name in prose matched to the one declaration that carries it. */
  uniqueNameMatch: 'medium',

  // --- low: not emitted ----------------------------------------------------
  /**
   * A name that matches more than one declaration, or matches nothing
   * distinctive. Present so the policy can *name* the case it refuses; nothing
   * in the pipeline emits an edge at this level.
   */
  ambiguousNameMatch: 'low',
} as const satisfies Record<string, ConfidenceLevel>;

export type ConfidenceBasis = keyof typeof CONFIDENCE_POLICY;

/**
 * Numeric equivalents, for callers that need to rank or average.
 *
 * Three values rather than a continuum, because the pipeline can genuinely
 * distinguish three cases and no more. A producer emitting 0.83 would be
 * asserting a precision it does not have.
 */
export const CONFIDENCE_SCORES: Record<ConfidenceLevel, number> = {
  high: 0.95,
  medium: 0.8,
  low: 0.5,
};

export function confidenceOf(basis: ConfidenceBasis): ConfidenceLevel {
  return CONFIDENCE_POLICY[basis];
}

export function confidenceScore(level: ConfidenceLevel): number {
  return CONFIDENCE_SCORES[level];
}

/** True when the policy says an observation of this kind must not be emitted. */
export function isEmittable(basis: ConfidenceBasis): boolean {
  return CONFIDENCE_POLICY[basis] !== 'low';
}

export interface EvidenceInput {
  source: EvidenceSource;
  basis: ConfidenceBasis;
  method?: EvidenceMethod;
  file?: string;
  line?: number;
  column?: number;
  matched?: string;
}

/**
 * Builds an edge's evidence from the policy.
 *
 * The only supported way for an analyzer to produce evidence: it says what it
 * saw and where, and the level follows from the policy rather than from the
 * analyzer's opinion of its own work.
 */
export function evidence(input: EvidenceInput): EdgeEvidence {
  const result: EdgeEvidence = {
    source: input.source,
    confidence: CONFIDENCE_POLICY[input.basis],
  };
  if (input.method !== undefined) result.method = input.method;
  if (input.file !== undefined) result.file = input.file;
  if (input.line !== undefined) result.line = input.line;
  if (input.column !== undefined) result.column = input.column;
  if (input.matched !== undefined) result.matched = input.matched;
  return result;
}
