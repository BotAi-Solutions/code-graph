import type { CodeNode, GraphPath, NodeDetail, SourceWindow } from '@ckg/shared';
import type { CodeSearchMatch } from '@ckg/shared';
import type { RetrievalClient, ResolvedProject } from './client.js';
import {
  checkFiles,
  checkNodes,
  checkNoPath,
  checkPath,
  checkRelationships,
  checkSourceMatches,
  nameOf,
  verdict,
  type Neighbour,
} from './match.js';
import {
  RETRIEVAL_CATEGORIES,
  type CategorySummary,
  type CheckResult,
  type EvaluationRun,
  type RetrievalEvaluationCase,
  type RetrievalEvaluationResult,
} from './types.js';

/**
 * Running the evaluation: resolve each fixture, run each case's retrieval, score
 * it. No printing, no file writing, no process exit — those belong to the CLI,
 * and keeping them out of here is what lets the tests run the real thing.
 *
 * Every request is scoped to the project the case names. A case cannot search
 * across projects, and a node from another project cannot satisfy it, because
 * the only project id in play is the one its own repository resolved to.
 */

/** Lines of context fetched around a line a case points at. */
const SOURCE_CONTEXT = 6;

export interface RunOptions {
  /** Where fixture repositories live, relative to the workspace root. */
  repositoryRoot?: string;
  /** Run only these case ids. */
  only?: readonly string[];
}

/**
 * Names a node the way a case does, and finds its id.
 *
 * Exact on the qualified name: a search for `UserService` also returns
 * `UserService.create` and eleven other members, and picking the first result
 * would make a case pass because *something* matched. Where several nodes share
 * a name — a class and its file — the one whose name is exactly the expectation
 * wins, and among those, the first the API ranked.
 */
async function resolveNode(
  client: RetrievalClient,
  projectId: string,
  name: string,
): Promise<CodeNode | null> {
  const results = await client.searchGraph(projectId, name, 50);
  return results.find((node) => nameOf(node) === name) ?? null;
}

/** Every neighbour the node detail carries, flattened with its relationship. */
function neighboursOf(detail: NodeDetail): Neighbour[] {
  const named: [keyof NodeDetail, string | null][] = [
    ['callers', 'CALLS'],
    ['callees', 'CALLS'],
    ['references', 'REFERENCES'],
    ['dependencies', null],
    ['dependents', null],
    ['implementations', null],
    ['apis', null],
    ['databases', null],
    ['documentation', null],
    ['contracts', null],
    ['children', 'CONTAINS'],
  ];

  const neighbours: Neighbour[] = [];

  for (const [key, fallback] of named) {
    const nodes = detail[key] as
      | ({ name: string; qualifiedName?: string; relationship?: string }[])
      | undefined;
    if (!nodes) continue;

    for (const node of nodes) {
      // Sections that carry the relationship use it; the three plain-node
      // sections imply theirs, and the API's own description says which.
      const relationship = node.relationship ?? fallback;
      if (relationship === null) continue;
      neighbours.push({ relationship, name: nameOf(node) });
    }
  }

  if (detail.parent) neighbours.push({ relationship: 'CONTAINS', name: nameOf(detail.parent) });

  return neighbours;
}

interface Evidence {
  codeSearch: CodeSearchMatch[];
  graphSearch: CodeNode[];
  detail: NodeDetail | null;
  subject: string | null;
  path: GraphPath | null;
  source: SourceWindow | null;
}

/** Runs exactly the retrieval calls a case names, and nothing else. */
async function retrieve(
  client: RetrievalClient,
  projectId: string,
  testCase: RetrievalEvaluationCase,
): Promise<Evidence> {
  const { probe } = testCase;
  const evidence: Evidence = {
    codeSearch: [],
    graphSearch: [],
    detail: null,
    subject: null,
    path: null,
    source: null,
  };

  if (probe.codeSearch !== undefined) {
    evidence.codeSearch = await client.searchCode(projectId, probe.codeSearch, probe.limit);
  }

  if (probe.graphSearch !== undefined) {
    evidence.graphSearch = await client.searchGraph(projectId, probe.graphSearch, probe.limit);
  }

  if (probe.node !== undefined) {
    const node = await resolveNode(client, projectId, probe.node);
    if (node) {
      evidence.subject = probe.node;
      evidence.detail = await client.nodeDetail(projectId, node.id);
      // The inspected node counts as retrieved: a case that asks where
      // something is defined is answered by finding it.
      evidence.graphSearch = [...evidence.graphSearch, evidence.detail.node];
    }
  }

  if (probe.trace !== undefined) {
    const [from, to] = await Promise.all([
      resolveNode(client, projectId, probe.trace.from),
      resolveNode(client, projectId, probe.trace.to),
    ]);

    if (from && to) {
      evidence.path = await client.findPath(projectId, from.id, to.id, probe.trace.maxDepth);
      evidence.graphSearch = [...evidence.graphSearch, ...evidence.path.nodes];
    }
  }

  if (probe.source !== undefined) {
    const { file, aroundLine, startLine, endLine } = probe.source;
    const range =
      aroundLine === undefined
        ? { ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) }
        : { startLine: Math.max(1, aroundLine - SOURCE_CONTEXT), endLine: aroundLine + SOURCE_CONTEXT };

    evidence.source = await client.source(projectId, file, range);
  }

  return evidence;
}

/** Scores one case's evidence against its expectations. */
function score(testCase: RetrievalEvaluationCase, evidence: Evidence): CheckResult[] {
  const checks: CheckResult[] = [];
  const { expected } = testCase;

  if (expected.files) checks.push(checkFiles(expected.files, evidence.codeSearch));
  if (expected.nodes) checks.push(checkNodes(expected.nodes, evidence.graphSearch));

  if (expected.relationships) {
    checks.push(
      evidence.detail === null || evidence.subject === null
        ? {
            name: 'relationships',
            status: 'fail',
            expected: expected.relationships.map((r) => `${r.from} ${r.type} ${r.to}`),
            found: [],
            missing: expected.relationships.map((r) => `${r.from} ${r.type} ${r.to}`),
            error: `the node "${testCase.probe.node ?? '?'}" could not be found`,
          }
        : checkRelationships(expected.relationships, evidence.subject, neighboursOf(evidence.detail)),
    );
  }

  if (expected.path) checks.push(checkPath(expected.path, evidence.path));

  if (expected.noPath === true) {
    const trace = testCase.probe.trace;
    checks.push(
      checkNoPath(
        trace?.from ?? '?',
        trace?.to ?? '?',
        trace?.maxDepth ?? 6,
        evidence.path,
      ),
    );
  }
  if (expected.sourceMatches) {
    checks.push(checkSourceMatches(expected.sourceMatches, evidence.codeSearch, evidence.source));
  }

  return checks;
}

export async function runEvaluation(
  client: RetrievalClient,
  cases: readonly RetrievalEvaluationCase[],
  options: RunOptions = {},
): Promise<EvaluationRun> {
  const root = options.repositoryRoot ?? 'test-repositories';
  const selected = options.only
    ? cases.filter((testCase) => options.only?.includes(testCase.id))
    : cases;

  // One resolution per repository, reused by every case about it, so the report
  // can state exactly which project was scored.
  const projects = new Map<string, ResolvedProject | null>();
  for (const repository of new Set(selected.map((testCase) => testCase.repository))) {
    projects.set(repository, await client.resolveProject(`${root}/${repository}`));
  }

  const results: RetrievalEvaluationResult[] = [];

  for (const testCase of selected) {
    const project = projects.get(testCase.repository) ?? null;
    const base = {
      caseId: testCase.id,
      category: testCase.category,
      question: testCase.question,
      repository: testCase.repository,
      ...(testCase.knownGap === undefined ? {} : { knownGap: testCase.knownGap }),
    };

    if (!project) {
      results.push({
        ...base,
        status: 'fail',
        checks: [],
        error: `no indexed project resolved from ${root}/${testCase.repository}`,
      });
      continue;
    }

    try {
      const evidence = await retrieve(client, project.projectId, testCase);
      const checks = score(testCase, evidence);
      results.push({ ...base, status: verdict(checks), checks });
    } catch (error) {
      results.push({
        ...base,
        status: 'fail',
        checks: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    projects: [...projects.entries()].flatMap(([repository, project]) =>
      project ? [{ repository, ...project }] : [],
    ),
    results,
    totals: {
      total: results.length,
      passed: results.filter((r) => r.status === 'pass').length,
      partial: results.filter((r) => r.status === 'partial').length,
      failed: results.filter((r) => r.status === 'fail').length,
    },
    byCategory: summariseByCategory(results),
  };
}

export function summariseByCategory(
  results: readonly RetrievalEvaluationResult[],
): CategorySummary[] {
  // Every category the results use, in the vocabulary's own order, so two runs
  // of the same dataset print their rows the same way round.
  return RETRIEVAL_CATEGORIES.flatMap((category) => {
    const inCategory = results.filter((result) => result.category === category);
    if (inCategory.length === 0) return [];

    return [
      {
        category,
        total: inCategory.length,
        passed: inCategory.filter((r) => r.status === 'pass').length,
        partial: inCategory.filter((r) => r.status === 'partial').length,
        failed: inCategory.filter((r) => r.status === 'fail').length,
      },
    ];
  });
}
