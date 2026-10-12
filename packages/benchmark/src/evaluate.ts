import {
  edgeEvidence,
  type CodeEdge,
  type CodeGraph,
  type CodeNode,
  type CodeNodeType,
  type CodeRelationship,
} from '@ckg/shared';
import { findGraphPath } from '@ckg/graph';
import { aggregate, scoreOf, type Counts, type Score } from './metrics.js';
import {
  edgeKey,
  nodeKey,
  type ExpectedEdge,
  type ExpectedEndpoint,
  type ExpectedNode,
  type ExpectedPath,
  type GroundTruth,
} from './ground-truth.js';

/**
 * Scoring a graph against what a human said should be in it.
 *
 * Four things are measured, and they are deliberately different questions:
 *
 *   nodes        did the pipeline find the entities?
 *   edges        did it find the relationships, with the right confidence?
 *   evidence     can every relationship say why it is believed?
 *   paths        can the graph actually be traversed the way it claims?
 *
 * The last two are the ones a precision/recall score would miss. A graph can
 * score perfectly on nodes and edges and still be useless if its edges point
 * the wrong way, so the path check walks the graph with the same breadth-first
 * search the database uses and asks whether the trace a reader would follow
 * exists.
 */

export interface Mismatch {
  /** What was expected, as it is written in the ground truth. */
  expected: string;
  /** Why it did not match: missing, or found but different. */
  reason: string;
}

export interface CategoryResult {
  category: string;
  score: Score;
  missing: string[];
  unexpected: string[];
  /** Found, but not as the ground truth described it. */
  mismatches: Mismatch[];
  /** Missing, and recorded in the ground truth as a known gap. Scored; not a failure. */
  knownMissing: string[];
  /** Unexpected, and recorded as a known false positive. Scored; not a failure. */
  knownUnexpected: string[];
  /**
   * Known gaps and known false positives the pipeline no longer exhibits. A
   * failure, so that a fix is noticed and the ground truth updated.
   */
  staleKnownGaps: string[];
}

/** What the build reported about what it could not represent. */
export interface GraphDiagnostics {
  /** References to symbols outside the repository, dropped by the builder. */
  unresolvedReferences: number;
  /** Edges an analyzer described whose endpoints were not both in the graph. */
  droppedEdges: number;
  failedAnalyzers: number;
  /** Files that could not be read or parsed. */
  readErrors: number;
  /** The source read stopped at a cap, so the graph may be incomplete. */
  truncated: boolean;
}

export interface DiagnosticsResult {
  observed: GraphDiagnostics | null;
  /** Where the observation disagrees with what the ground truth asserts. */
  problems: string[];
}

export interface EvidenceResult {
  /** Edges whose metadata parses as evidence from a known analyzer. */
  valid: number;
  invalid: number;
  total: number;
  /**
   * Of the edges whose evidence is not a compiler fact, how many name a file
   * and a line. A SCIP or graph-derived edge is located by its endpoints and is
   * excluded from the denominator rather than counted as a failure.
   */
  locatable: number;
  located: number;
  /** Edges whose recorded confidence is not the one the ground truth expects. */
  confidenceMismatches: Mismatch[];
  /** Edges carrying no evidence at all, by relationship. */
  unattributed: string[];
}

export interface PathResult {
  name: string;
  found: boolean;
  /** Hops taken, or null when no route was found. */
  depth: number | null;
  /** Relationships along the route, in order. */
  relationships: CodeRelationship[];
  problems: string[];
}

export interface EvaluationResult {
  fixture: string;
  nodeCategories: CategoryResult[];
  edgeCategories: CategoryResult[];
  nodes: Score;
  edges: Score;
  evidence: EvidenceResult;
  paths: PathResult[];
  diagnostics: DiagnosticsResult;
  /** True when every expectation held and no closed category leaked. */
  passed: boolean;
  graphNodeCount: number;
  graphEdgeCount: number;
}

/** The name a node is addressed by: its qualified name, or its plain one. */
export function addressOf(node: CodeNode): string {
  return node.qualifiedName ?? node.name;
}

export interface EvaluateOptions {
  /** The build's own report, when the graph came from the assembler. */
  diagnostics?: GraphDiagnostics;
}

export function evaluate(
  graph: CodeGraph,
  truth: GroundTruth,
  options: EvaluateOptions = {},
): EvaluationResult {
  const index = buildIndex(graph);

  const nodeCategories = evaluateNodes(graph, truth, index);
  const edgeCategories = evaluateEdges(graph, truth, index);
  const evidence = evaluateEvidence(graph, truth, index);
  const paths = truth.paths.map((expected) => evaluatePath(graph, index, expected));
  const diagnostics = evaluateDiagnostics(truth, options.diagnostics);

  const nodes = aggregate(nodeCategories.map((entry) => entry.score));
  const edges = aggregate(edgeCategories.map((entry) => entry.score));

  const clean = (categories: readonly CategoryResult[]): boolean =>
    categories.every(
      (entry) =>
        entry.missing.length === 0 &&
        entry.unexpected.length === 0 &&
        entry.mismatches.length === 0 &&
        entry.staleKnownGaps.length === 0,
    );

  return {
    fixture: truth.fixture,
    nodeCategories,
    edgeCategories,
    nodes,
    edges,
    evidence,
    paths,
    diagnostics,
    passed:
      diagnostics.problems.length === 0 &&
      clean(nodeCategories) &&
      clean(edgeCategories) &&
      evidence.invalid === 0 &&
      evidence.confidenceMismatches.length === 0 &&
      paths.every((entry) => entry.found && entry.problems.length === 0),
    graphNodeCount: graph.nodes.length,
    graphEdgeCount: graph.edges.length,
  };
}

// --- indexing --------------------------------------------------------------

interface GraphIndex {
  byAddress: Map<string, CodeNode[]>;
  byId: Map<string, CodeNode>;
  edgeKeys: Map<string, CodeEdge[]>;
}

function buildIndex(graph: CodeGraph): GraphIndex {
  const byAddress = new Map<string, CodeNode[]>();
  const byId = new Map<string, CodeNode>();

  for (const node of graph.nodes) {
    byId.set(node.id, node);
    const key = nodeKey({ type: node.type, name: addressOf(node) });
    const existing = byAddress.get(key);
    if (existing) existing.push(node);
    else byAddress.set(key, [node]);
  }

  const edgeKeys = new Map<string, CodeEdge[]>();
  for (const edge of graph.edges) {
    const source = byId.get(edge.sourceNodeId);
    const target = byId.get(edge.targetNodeId);
    if (!source || !target) continue;

    const key = `${nodeKey({ type: source.type, name: addressOf(source) })} -${edge.relationship}-> ${nodeKey({ type: target.type, name: addressOf(target) })}`;
    const existing = edgeKeys.get(key);
    if (existing) existing.push(edge);
    else edgeKeys.set(key, [edge]);
  }

  return { byAddress, byId, edgeKeys };
}

function resolve(
  index: GraphIndex,
  endpoint: ExpectedEndpoint & { file?: string },
): CodeNode | undefined {
  const candidates = index.byAddress.get(nodeKey(endpoint));
  // Two nodes can share an address (a name declared in two files). The one in
  // the expected file is the one meant; picking whichever came first would
  // report a file mismatch for a node that is actually there.
  if (endpoint.file !== undefined) {
    const inFile = candidates?.find((node) => node.filePath === endpoint.file);
    if (inFile) return inFile;
  }
  return candidates?.[0];
}

// --- scoring a category ----------------------------------------------------

interface Expectation {
  key: string;
  count: number;
  knownGap?: string;
}

interface CategoryCounts {
  counts: Counts;
  produced: number;
  missing: string[];
  unexpected: string[];
  knownMissing: string[];
  knownUnexpected: string[];
  staleKnownGaps: string[];
}

/**
 * Scores one category as multisets of addresses.
 *
 * Every produced item is counted exactly once: as a true positive while the
 * ground truth still expects another one at its address, otherwise as a
 * false positive. So for a closed category `truePositives + falsePositives`
 * is exactly what the pipeline produced, and precision is never computed over
 * a denominator that quietly lost duplicates.
 */
function scoreCategory(
  expected: readonly Expectation[],
  produced: ReadonlyMap<string, number>,
  closed: boolean,
  knownFalsePositives: ReadonlyMap<string, string>,
): CategoryCounts {
  const counts: Counts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
  const missing: string[] = [];
  const unexpected: string[] = [];
  const knownMissing: string[] = [];
  const knownUnexpected: string[] = [];
  const staleKnownGaps: string[] = [];

  const expectedCount = new Map<string, number>();

  for (const entry of expected) {
    expectedCount.set(entry.key, entry.count);
    const found = Math.min(entry.count, produced.get(entry.key) ?? 0);

    counts.truePositives += found;
    counts.falseNegatives += entry.count - found;

    const label = entry.count > 1 ? `${entry.key} (${String(found)} of ${String(entry.count)})` : entry.key;

    if (found < entry.count) {
      (entry.knownGap === undefined ? missing : knownMissing).push(label);
    } else if (entry.knownGap !== undefined) {
      staleKnownGaps.push(`${label} is now produced; remove its knownGap`);
    }
  }

  let total = 0;
  for (const [key, count] of produced) {
    total += count;
    if (!closed) continue;

    const extra = count - (expectedCount.get(key) ?? 0);
    if (extra <= 0) continue;

    counts.falsePositives += extra;
    const label = extra > 1 ? `${key} (x${String(extra)})` : key;
    (knownFalsePositives.has(key) ? knownUnexpected : unexpected).push(label);
  }

  for (const key of knownFalsePositives.keys()) {
    if ((produced.get(key) ?? 0) <= (expectedCount.get(key) ?? 0)) {
      staleKnownGaps.push(`${key} is no longer produced; remove it from knownFalsePositives`);
    }
  }

  return {
    counts,
    produced: total,
    missing: missing.sort(),
    unexpected: unexpected.sort(),
    knownMissing: knownMissing.sort(),
    knownUnexpected: knownUnexpected.sort(),
    staleKnownGaps: staleKnownGaps.sort(),
  };
}

function tally(keys: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

// --- nodes -----------------------------------------------------------------

function evaluateNodes(
  graph: CodeGraph,
  truth: GroundTruth,
  index: GraphIndex,
): CategoryResult[] {
  const expectedByType = new Map<CodeNodeType, ExpectedNode[]>();
  for (const entry of truth.nodes) {
    const existing = expectedByType.get(entry.type);
    if (existing) existing.push(entry);
    else expectedByType.set(entry.type, [entry]);
  }

  const producedByType = new Map<CodeNodeType, CodeNode[]>();
  for (const node of graph.nodes) {
    const existing = producedByType.get(node.type);
    if (existing) existing.push(node);
    else producedByType.set(node.type, [node]);
  }

  const closed = new Set(truth.closedNodeTypes);
  const types = [...new Set([...expectedByType.keys(), ...closed])].sort();

  return types.map((type) => {
    const expected = expectedByType.get(type) ?? [];
    const produced = producedByType.get(type) ?? [];
    const isClosed = closed.has(type);

    const known = new Map(
      (truth.knownFalsePositiveNodes ?? [])
        .filter((entry) => entry.type === type)
        .map((entry) => [nodeKey(entry), entry.reason] as const),
    );

    const scored = scoreCategory(
      expected.map((entry) => ({
        key: nodeKey(entry),
        count: entry.count ?? 1,
        ...(entry.knownGap !== undefined ? { knownGap: entry.knownGap } : {}),
      })),
      tally(produced.map((node) => nodeKey({ type: node.type, name: addressOf(node) }))),
      isClosed,
      known,
    );

    const mismatches: Mismatch[] = [];
    for (const entry of expected) {
      if (entry.file === undefined) continue;
      const match = resolve(index, entry);
      // A node found under the right name but in the wrong file is not the
      // node that was expected, and saying so is more useful than a silent pass.
      if (match && match.filePath !== entry.file) {
        mismatches.push({
          expected: nodeKey(entry),
          reason: `expected file ${entry.file}, found ${match.filePath ?? 'none'}`,
        });
      }
    }

    // Unexpected nodes are reported by address alone: the category already
    // names the type, and this is the format the report has always used.
    const withoutType = (label: string): string => label.slice(type.length + 1);

    return {
      category: type,
      score: scoreOf(scored.counts, { closed: isClosed, produced: scored.produced }),
      missing: scored.missing,
      unexpected: scored.unexpected.map(withoutType),
      mismatches,
      knownMissing: scored.knownMissing,
      knownUnexpected: scored.knownUnexpected.map(withoutType),
      staleKnownGaps: scored.staleKnownGaps,
    };
  });
}

// --- edges -----------------------------------------------------------------

function evaluateEdges(
  graph: CodeGraph,
  truth: GroundTruth,
  index: GraphIndex,
): CategoryResult[] {
  const expectedByRelationship = new Map<CodeRelationship, ExpectedEdge[]>();
  for (const entry of truth.edges) {
    const existing = expectedByRelationship.get(entry.relationship);
    if (existing) existing.push(entry);
    else expectedByRelationship.set(entry.relationship, [entry]);
  }

  const producedByRelationship = new Map<CodeRelationship, CodeEdge[]>();
  for (const edge of graph.edges) {
    const existing = producedByRelationship.get(edge.relationship);
    if (existing) existing.push(edge);
    else producedByRelationship.set(edge.relationship, [edge]);
  }

  const closed = new Set(truth.closedRelationships);
  const relationships = [
    ...new Set([...expectedByRelationship.keys(), ...closed]),
  ].sort();

  return relationships.map((relationship) => {
    const expected = expectedByRelationship.get(relationship) ?? [];
    const produced = producedByRelationship.get(relationship) ?? [];
    const isClosed = closed.has(relationship);

    const known = new Map(
      (truth.knownFalsePositiveEdges ?? [])
        .filter((entry) => entry.relationship === relationship)
        .map((entry) => [edgeKey(entry), entry.reason] as const),
    );

    const scored = scoreCategory(
      expected.map((entry) => ({
        key: edgeKey(entry),
        count: entry.count ?? 1,
        ...(entry.knownGap !== undefined ? { knownGap: entry.knownGap } : {}),
      })),
      tally(
        produced
          .map((edge) => describeEdge(index, edge))
          .filter((key): key is string => key !== null),
      ),
      isClosed,
      known,
    );

    const mismatches: Mismatch[] = [];
    for (const entry of expected) {
      const matches = index.edgeKeys.get(edgeKey(entry));
      if (!matches || matches.length === 0) continue;
      mismatches.push(...checkEdgeDetail(entry, matches[0] as CodeEdge));
    }

    return {
      category: relationship,
      score: scoreOf(scored.counts, { closed: isClosed, produced: scored.produced }),
      missing: scored.missing,
      unexpected: scored.unexpected,
      mismatches,
      knownMissing: scored.knownMissing,
      knownUnexpected: scored.knownUnexpected,
      staleKnownGaps: scored.staleKnownGaps,
    };
  });
}

function describeEdge(index: GraphIndex, edge: CodeEdge): string | null {
  const source = index.byId.get(edge.sourceNodeId);
  const target = index.byId.get(edge.targetNodeId);
  if (!source || !target) return null;

  return `${nodeKey({ type: source.type, name: addressOf(source) })} -${edge.relationship}-> ${nodeKey({ type: target.type, name: addressOf(target) })}`;
}

/** Checks the parts of an expectation that are about *how* the edge was made. */
function checkEdgeDetail(expected: ExpectedEdge, edge: CodeEdge): Mismatch[] {
  const problems: Mismatch[] = [];
  const found = edgeEvidence(edge);
  const key = edgeKey(expected);

  if (expected.confidence !== undefined && found?.confidence !== expected.confidence) {
    problems.push({
      expected: key,
      reason: `expected confidence ${expected.confidence}, found ${found?.confidence ?? 'none'}`,
    });
  }

  const wanted = expected.evidence;
  if (!wanted) return problems;

  if (wanted.source !== undefined && found?.source !== wanted.source) {
    problems.push({
      expected: key,
      reason: `expected evidence source ${wanted.source}, found ${found?.source ?? 'none'}`,
    });
  }
  if (wanted.method !== undefined && found?.method !== wanted.method) {
    problems.push({
      expected: key,
      reason: `expected evidence method ${wanted.method}, found ${found?.method ?? 'none'}`,
    });
  }
  if (wanted.file !== undefined && found?.file !== wanted.file) {
    problems.push({
      expected: key,
      reason: `expected evidence file ${wanted.file}, found ${found?.file ?? 'none'}`,
    });
  }
  if (wanted.located === true && found?.line === undefined) {
    problems.push({ expected: key, reason: 'expected a line number in the evidence, found none' });
  }

  return problems;
}

// --- evidence --------------------------------------------------------------

/**
 * Evidence methods for which a file and a line are not meaningful.
 *
 * A SCIP-derived `CALLS` edge is located by the two symbols it joins, both of
 * which carry their own range; demanding a line on the edge as well would be
 * asking the graph to record something it does not know and does not need.
 */
const UNLOCATABLE_METHODS = new Set(['scip', 'graph']);

function evaluateEvidence(
  graph: CodeGraph,
  truth: GroundTruth,
  index: GraphIndex,
): EvidenceResult {
  let valid = 0;
  let invalid = 0;
  let locatable = 0;
  let located = 0;

  const unattributed = new Set<string>();

  for (const edge of graph.edges) {
    const found = edgeEvidence(edge);

    if (!found) {
      invalid += 1;
      unattributed.add(describeEdge(index, edge) ?? edge.relationship);
      continue;
    }
    valid += 1;

    // An edge with no recorded method predates the method field or is
    // SCIP-derived; either way it is not something to demand a line from.
    if (found.method === undefined || UNLOCATABLE_METHODS.has(found.method)) continue;

    locatable += 1;
    if (found.file !== undefined && found.line !== undefined) located += 1;
  }

  const confidenceMismatches: Mismatch[] = [];
  for (const entry of truth.edges) {
    if (entry.confidence === undefined && entry.evidence === undefined) continue;
    const matches = index.edgeKeys.get(edgeKey(entry));
    if (!matches || matches.length === 0) continue;
    confidenceMismatches.push(...checkEdgeDetail(entry, matches[0] as CodeEdge));
  }

  return {
    valid,
    invalid,
    total: graph.edges.length,
    locatable,
    located,
    confidenceMismatches,
    unattributed: [...unattributed].sort(),
  };
}

// --- diagnostics -----------------------------------------------------------

function evaluateDiagnostics(
  truth: GroundTruth,
  observed: GraphDiagnostics | undefined,
): DiagnosticsResult {
  const asserted = truth.diagnostics;
  if (!observed) {
    return {
      observed: null,
      problems: asserted ? ['the ground truth asserts diagnostics, but none were supplied'] : [],
    };
  }
  if (!asserted) return { observed, problems: [] };

  const problems: string[] = [];
  const check = (name: string, expected: number | boolean | undefined, actual: number | boolean): void => {
    if (expected !== undefined && expected !== actual) {
      problems.push(`expected ${name} ${String(expected)}, found ${String(actual)}`);
    }
  };
  check('droppedEdges', asserted.droppedEdges, observed.droppedEdges);
  check('failedAnalyzers', asserted.failedAnalyzers, observed.failedAnalyzers);
  check('readErrors', asserted.readErrors, observed.readErrors);
  check('truncated', asserted.truncated, observed.truncated);

  return { observed, problems };
}

// --- paths -----------------------------------------------------------------

function evaluatePath(
  graph: CodeGraph,
  index: GraphIndex,
  expected: ExpectedPath,
): PathResult {
  const problems: string[] = [];

  const from = resolve(index, expected.from);
  const to = resolve(index, expected.to);

  if (!from) problems.push(`no node for ${nodeKey(expected.from)}`);
  if (!to) problems.push(`no node for ${nodeKey(expected.to)}`);
  if (!from || !to) {
    return { name: expected.name, found: false, depth: null, relationships: [], problems };
  }

  const result = findGraphPath(graph, from.id, to.id, {
    maxDepth: expected.maxDepth,
    // Directed: the whole point of the trace is that a request *flows* this
    // way. A route that only exists backwards is not the answer to the question.
    directed: true,
    // `viaRelationships` constrains the *search*, it does not merely check the
    // answer. Checking would be weaker and would fail for the wrong reason: a
    // graph usually holds several correct routes between two nodes, and the
    // breadth-first search is entitled to return whichever is shortest. What
    // the expectation is actually asserting is "a route made only of these
    // relationships exists", and this is how that question is asked. It is
    // also the question the graph API answers when a projection is applied, so
    // a benchmark pass means the product feature works.
    ...(expected.viaRelationships ? { relationships: expected.viaRelationships } : {}),
  });

  if (!result.found) {
    return {
      name: expected.name,
      found: false,
      depth: null,
      relationships: [],
      problems: [
        ...problems,
        `no directed route within ${String(expected.maxDepth)} hops${result.truncated ? ' (search hit its node budget)' : ''}`,
      ],
    };
  }

  const relationships = result.hops.map((hop) => hop.relationship);

  if (expected.through) {
    const visited = result.nodeIds
      .map((id) => index.byId.get(id))
      .filter((node): node is CodeNode => node !== undefined)
      .map((node) => nodeKey({ type: node.type, name: addressOf(node) }));

    // Ordered containment: the route must pass through these in this sequence,
    // and may pass through other things between them.
    let cursor = 0;
    for (const step of expected.through) {
      const wanted = nodeKey(step);
      const at = visited.indexOf(wanted, cursor);
      if (at === -1) {
        problems.push(`route did not pass through ${wanted} in order`);
        break;
      }
      cursor = at;
    }
  }

  return {
    name: expected.name,
    found: true,
    depth: result.hops.length,
    relationships,
    problems,
  };
}
