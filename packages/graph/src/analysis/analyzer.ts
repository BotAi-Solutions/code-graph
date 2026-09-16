import type {
  CodeGraph,
  CodeNodeType,
  CodeRelationship,
  EdgeEvidence,
  SupportedLanguage,
} from '@ckg/shared';
import type { GraphIdentityContext } from '../model/identity.js';
import type { SymbolIndex } from './symbol-index.js';

/**
 * The seam between "a thing that knows something about this repository" and the
 * graph.
 *
 * SCIP is one such thing, and the most authoritative — it is the compiler's
 * view. But a compiler has no opinion about which function is an HTTP route or
 * which string is a table name, and those facts are what turn a symbol graph
 * into a knowledge graph. An analyzer is how a second, third or fourth source
 * of facts joins without the graph model changing shape.
 *
 * Analyzers never mutate the graph. They return a description of what they
 * observed, together with the evidence for it, and `CodeGraphAssembler` decides
 * how that merges. An analyzer that finds nothing returns an empty result; an
 * analyzer whose evidence is weak returns nothing at all rather than a guess.
 */

/**
 * When an analyzer runs.
 *
 * Code intelligence comes first because everything else resolves its findings
 * *against* the symbols the compiler found: a route handler is only interesting
 * if we can point at the method it routes to. Classification comes last because
 * it reasons about the graph the earlier stages built — a class is a repository
 * because something showed it writing to a table, not because of its name.
 */
export const ANALYSIS_STAGES = ['code-intelligence', 'source', 'classification'] as const;

export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** One source file, already read. */
export interface SourceFile {
  /** Repository-relative POSIX path, matching `CodeNode.filePath`. */
  relativePath: string;
  text: string;
}

/**
 * Read-only access to the repository's source, read once and shared by every
 * analyzer so a ten-analyzer pipeline is still one pass over the disk.
 *
 * Declared here as an interface and implemented in `@ckg/analysis`: the domain
 * layer describes what it needs, it does not do I/O.
 */
export interface SourceFileSet {
  all(): readonly SourceFile[];
  byPath(relativePath: string): SourceFile | undefined;
  /** Files whose path ends with any of the given suffixes, in path order. */
  matching(...suffixes: string[]): readonly SourceFile[];
  /** True when the walk stopped at its file cap; findings may be incomplete. */
  readonly truncated: boolean;
}

export interface AnalysisContext {
  identity: GraphIdentityContext;
  /** Absolute path of the working tree under analysis. */
  repositoryPath: string;
  repositoryName: string;
  language: SupportedLanguage | null;
  sources: SourceFileSet;
  /**
   * Lookup into the graph as previous stages left it. Empty during the
   * code-intelligence stage.
   */
  symbols: SymbolIndex;
}

/** A node an analyzer declares. The assembler assigns its stable identity. */
export interface AnalyzerNodeDraft {
  type: CodeNodeType;
  name: string;
  /**
   * What distinguishes this node from every other of its type in the same
   * file. Must be derived from the repository, never from a counter or a
   * timestamp, or the graph stops being reproducible.
   */
  symbolKey: string;
  qualifiedName?: string | undefined;
  filePath?: string | undefined;
  startLine?: number | undefined;
  startCharacter?: number | undefined;
  endLine?: number | undefined;
  endCharacter?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * An edge endpoint: either a node that already exists (usually SCIP-derived,
 * found through the symbol index) or one this same result declares.
 */
export type NodeReference =
  | { kind: 'node'; id: string }
  | { kind: 'draft'; draft: AnalyzerNodeDraft };

export function nodeRef(id: string): NodeReference {
  return { kind: 'node', id };
}

export function draftRef(draft: AnalyzerNodeDraft): NodeReference {
  return { kind: 'draft', draft };
}

export interface AnalyzerEdgeDraft {
  from: NodeReference;
  to: NodeReference;
  relationship: CodeRelationship;
  evidence: EdgeEvidence;
  metadata?: Record<string, unknown> | undefined;
}

/** Extra metadata for a node another stage owns. */
export interface AnalyzerEnrichment {
  nodeId: string;
  metadata: Record<string, unknown>;
}

export interface AnalysisResult {
  /** Nodes this analyzer declares; identity is assigned by the assembler. */
  nodes?: AnalyzerNodeDraft[];
  edges?: AnalyzerEdgeDraft[];
  /**
   * Nodes and edges that already carry their final identity. Used by the SCIP
   * stage, which builds a complete graph of its own.
   */
  graph?: CodeGraph;
  enrichments?: AnalyzerEnrichment[];
  /** Counters merged into the build stats, prefixed with the analyzer name. */
  stats?: Record<string, number>;
  /** Operator-facing notes. Never source code. */
  diagnostics?: string[];
}

export interface CodeAnalyzer {
  readonly name: string;
  readonly stage: AnalysisStage;
  /** Cheap check: does this analyzer have anything to say about this repository? */
  supports(context: AnalysisContext): boolean;
  analyze(context: AnalysisContext): Promise<AnalysisResult>;
}

export const EMPTY_ANALYSIS_RESULT: AnalysisResult = Object.freeze({});
