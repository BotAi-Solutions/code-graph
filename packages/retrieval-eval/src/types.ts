import type { CodeNode, CodeRelationship, GraphPath, SourceWindow } from '@ckg/shared';
import type { CodeSearchMatch } from '@ckg/shared';

/**
 * What a retrieval evaluation case is, and what running one produces.
 *
 * The model is deliberately narrow: a question, the evidence answering it
 * requires, and the retrieval calls that ought to find that evidence. Nothing
 * here describes a *good answer* in prose — the thing under test is whether the
 * public retrieval interface can put the right facts in front of a caller, and
 * that is checkable by identity rather than by judgement.
 */

export const RETRIEVAL_CATEGORIES = [
  /** "Where is X defined?" — the graph knows the name. */
  'symbol_lookup',
  /** "Where does the text X appear?" — the files contain the string. */
  'code_lookup',
  /** "Who calls X?" / "What does X call?" */
  'call_relationship',
  /** "What does X depend on?" — packages, services, interfaces. */
  'dependency',
  /** "Where does X touch the database?" */
  'database_access',
  /** "What implements X?" */
  'implementation',
  /** "How does a request get from A to B?" — more than one hop, more than one file. */
  'cross_file_flow',
  /** Routes, queues, events, containers, specifications. */
  'architecture',
  /** "Show me the code at this location." */
  'source_context',
  /** An explicit shortest-path query between two named nodes. */
  'trace_path',
  /** "What does the repository say about X?" — prose and contracts. */
  'documentation',
] as const;

export type RetrievalCategory = (typeof RETRIEVAL_CATEGORIES)[number];

/** A relationship, named by the qualified names of its endpoints. */
export interface ExpectedRelationship {
  from: string;
  type: CodeRelationship;
  to: string;
}

/**
 * A route, as the sequence of nodes it must run through.
 *
 * Node *names* rather than ids: an id is a content hash that changes when the
 * fixture does, and a case that has to be regenerated after every re-index is a
 * case nobody maintains.
 */
export interface ExpectedPath {
  from: string;
  to: string;
  /** In order, `from` first and `to` last. */
  nodes: string[];
  /** Distinct relationships along the route, in order of first use. */
  relationships?: CodeRelationship[];
  maxDepth?: number;
}

/** A place in the source the answer depends on. */
export interface ExpectedSourceMatch {
  file: string;
  /** The line the match must be on, when the question is about a specific one. */
  line?: number;
  /** Text the retrieved source window must contain, verbatim. */
  contains?: string;
}

/**
 * The retrieval calls a case makes.
 *
 * Explicit rather than a workflow language. Each field is one call against the
 * public API, and the runner makes exactly the calls a case names — so reading
 * a case tells you precisely what was asked of the system, which is the point
 * of the exercise.
 */
export interface RetrievalProbe {
  /** `GET /code/search?q=…` — passed through verbatim; the search is literal. */
  codeSearch?: string;
  /** `GET /graph/search?q=…` */
  graphSearch?: string;
  /** `GET /graph/nodes/:id` for the node with this qualified name. */
  node?: string;
  /** `POST /graph/path` between two named nodes. */
  trace?: { from: string; to: string; maxDepth?: number };
  /** `GET /source` — a window around a line, or an explicit range. */
  source?: { file: string; startLine?: number; endLine?: number; aroundLine?: number };
  /** Results per search. Left off, the API's own default applies. */
  limit?: number;
}

export interface RetrievalEvaluationCase {
  id: string;
  category: RetrievalCategory;
  /** The question a person would actually ask. Documentation, never matched on. */
  question: string;
  /**
   * The fixture this case is about, by directory name under
   * `test-repositories/`. Never a project id: those differ per database.
   */
  repository: string;
  probe: RetrievalProbe;
  expected: {
    /** Repository-relative paths that must appear among the results. */
    files?: string[];
    /** Qualified names that must appear among the retrieved nodes. */
    nodes?: string[];
    relationships?: ExpectedRelationship[];
    path?: ExpectedPath;
    /**
     * The negative: these two must NOT be connected within the traced depth.
     *
     * Its own field rather than an unreachable `path`, so correct behaviour
     * reports as a pass. A report that prints a failure mark beside the system
     * doing the right thing trains its reader to ignore failure marks.
     */
    noPath?: boolean;
    sourceMatches?: ExpectedSourceMatch[];
  };
  /**
   * A known gap, recorded rather than hidden.
   *
   * A case marked this way still runs and still reports honestly; the note
   * explains what is already understood to be missing, so a failure that is old
   * news reads differently from one that is new.
   */
  knownGap?: string;
}

// --- results ---------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail';

/** One expectation, and what retrieval actually produced for it. */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  expected: string[];
  found: string[];
  missing: string[];
  /** Why the check could not run at all, when retrieval itself failed. */
  error?: string;
}

export type CaseStatus = 'pass' | 'partial' | 'fail';

export interface RetrievalEvaluationResult {
  caseId: string;
  category: RetrievalCategory;
  question: string;
  repository: string;
  status: CaseStatus;
  checks: CheckResult[];
  /** Present when the case could not be run — an unresolvable project, say. */
  error?: string;
  knownGap?: string;
}

/** What retrieval actually returned, kept for diagnosis. */
export interface RetrievalEvidence {
  codeSearch?: CodeSearchMatch[];
  graphSearch?: CodeNode[];
  node?: { node: CodeNode; neighbours: { relationship: string; name: string }[] };
  path?: GraphPath;
  source?: SourceWindow;
}

export interface CategorySummary {
  category: RetrievalCategory;
  total: number;
  passed: number;
  partial: number;
  failed: number;
}

export interface EvaluationRun {
  /** Which project each repository resolved to, so a report says what it scored. */
  projects: { repository: string; projectId: string; name: string; nodeCount: number }[];
  results: RetrievalEvaluationResult[];
  totals: { total: number; passed: number; partial: number; failed: number };
  byCategory: CategorySummary[];
}
