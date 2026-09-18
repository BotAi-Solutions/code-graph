import { formatRatio, type Score } from './metrics.js';
import type { CategoryResult, EvaluationResult } from './evaluate.js';

/**
 * Two renderings of one result: one for a person reading a terminal, one for a
 * machine deciding whether something regressed.
 *
 * The human report prints every failure in full rather than a count, because a
 * benchmark that says "3 missing" and makes you re-run it with a flag to find
 * out which three is a benchmark nobody runs.
 */

export interface MachineReport {
  /** Bumped when the shape changes, so a consumer can refuse an old one. */
  schema: 1;
  generatedAt: string;
  fixtures: Array<{
    fixture: string;
    passed: boolean;
    graph: { nodes: number; edges: number };
    nodes: MachineScore;
    edges: MachineScore;
    nodeCategories: Record<string, MachineScore>;
    edgeCategories: Record<string, MachineScore>;
    evidence: {
      valid: number;
      invalid: number;
      total: number;
      validRatio: number | null;
      locatable: number;
      located: number;
      locatedRatio: number | null;
      confidenceMismatches: number;
    };
    paths: {
      total: number;
      correct: number;
      ratio: number | null;
      failures: Array<{ name: string; problems: string[] }>;
    };
    failures: {
      missingNodes: string[];
      unexpectedNodes: string[];
      missingEdges: string[];
      unexpectedEdges: string[];
      mismatches: string[];
    };
  }>;
  totals: {
    fixtures: number;
    passed: number;
  };
}

export interface MachineScore {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  closed: boolean;
  expected: number;
  produced: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

function machineScore(score: Score): MachineScore {
  return {
    precision: score.precision,
    recall: score.recall,
    f1: score.f1,
    closed: score.closed,
    expected: score.expected,
    produced: score.produced,
    truePositives: score.truePositives,
    falsePositives: score.falsePositives,
    falseNegatives: score.falseNegatives,
  };
}

export function toMachineReport(
  results: readonly EvaluationResult[],
  generatedAt: string = new Date().toISOString(),
): MachineReport {
  return {
    schema: 1,
    generatedAt,
    fixtures: results.map((result) => ({
      fixture: result.fixture,
      passed: result.passed,
      graph: { nodes: result.graphNodeCount, edges: result.graphEdgeCount },
      nodes: machineScore(result.nodes),
      edges: machineScore(result.edges),
      nodeCategories: categoryMap(result.nodeCategories),
      edgeCategories: categoryMap(result.edgeCategories),
      evidence: {
        valid: result.evidence.valid,
        invalid: result.evidence.invalid,
        total: result.evidence.total,
        validRatio: ratio(result.evidence.valid, result.evidence.total),
        locatable: result.evidence.locatable,
        located: result.evidence.located,
        locatedRatio: ratio(result.evidence.located, result.evidence.locatable),
        confidenceMismatches: result.evidence.confidenceMismatches.length,
      },
      paths: {
        total: result.paths.length,
        correct: result.paths.filter((path) => path.found && path.problems.length === 0).length,
        ratio: ratio(
          result.paths.filter((path) => path.found && path.problems.length === 0).length,
          result.paths.length,
        ),
        failures: result.paths
          .filter((path) => !path.found || path.problems.length > 0)
          .map((path) => ({
            name: path.name,
            problems: path.found ? path.problems : ['no route found', ...path.problems],
          })),
      },
      failures: {
        missingNodes: result.nodeCategories.flatMap((entry) => entry.missing),
        unexpectedNodes: result.nodeCategories.flatMap((entry) => entry.unexpected),
        missingEdges: result.edgeCategories.flatMap((entry) => entry.missing),
        unexpectedEdges: result.edgeCategories.flatMap((entry) => entry.unexpected),
        mismatches: [...result.nodeCategories, ...result.edgeCategories].flatMap((entry) =>
          entry.mismatches.map((mismatch) => `${mismatch.expected}: ${mismatch.reason}`),
        ),
      },
    })),
    totals: {
      fixtures: results.length,
      passed: results.filter((result) => result.passed).length,
    },
  };
}

function categoryMap(categories: readonly CategoryResult[]): Record<string, MachineScore> {
  const map: Record<string, MachineScore> = {};
  for (const entry of categories) map[entry.category] = machineScore(entry.score);
  return map;
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

// --- human report ----------------------------------------------------------

export function formatReport(results: readonly EvaluationResult[]): string {
  const lines: string[] = ['', 'Repository Knowledge Graph Benchmark', ''];

  for (const result of results) {
    lines.push(`Fixture: ${result.fixture}`);
    lines.push(
      `  graph: ${String(result.graphNodeCount)} nodes, ${String(result.graphEdgeCount)} edges`,
    );
    lines.push('');

    lines.push('Nodes');
    lines.push(...scoreLines(result.nodes, '  '));
    lines.push(...categoryLines(result.nodeCategories));
    lines.push('');

    lines.push('Relationships');
    lines.push(...scoreLines(result.edges, '  '));
    lines.push(...categoryLines(result.edgeCategories));
    lines.push('');

    const evidence = result.evidence;
    lines.push('Evidence');
    lines.push(
      `  Attributed:    ${formatRatio(ratio(evidence.valid, evidence.total))}  (${String(evidence.valid)}/${String(evidence.total)} edges name an analyzer and a confidence)`,
    );
    lines.push(
      `  Located:       ${formatRatio(ratio(evidence.located, evidence.locatable))}  (${String(evidence.located)}/${String(evidence.locatable)} non-compiler edges carry a file and a line)`,
    );
    lines.push(
      `  Confidence:    ${evidence.confidenceMismatches.length === 0 ? 'as the policy prescribes' : `${String(evidence.confidenceMismatches.length)} disagree with the expectation`}`,
    );
    for (const mismatch of evidence.confidenceMismatches) {
      lines.push(`    ! ${mismatch.expected} — ${mismatch.reason}`);
    }
    for (const edge of evidence.unattributed) lines.push(`    ! no evidence: ${edge}`);
    lines.push('');

    const correct = result.paths.filter((path) => path.found && path.problems.length === 0).length;
    lines.push('Paths');
    lines.push(
      `  Correct:       ${formatRatio(ratio(correct, result.paths.length))}  (${String(correct)}/${String(result.paths.length)})`,
    );
    for (const path of result.paths) {
      const ok = path.found && path.problems.length === 0;
      lines.push(
        `    ${ok ? 'ok  ' : 'FAIL'} ${path.name}${path.depth === null ? '' : `  (${String(path.depth)} hops: ${path.relationships.join(' -> ')})`}`,
      );
      for (const problem of path.problems) lines.push(`         ${problem}`);
      if (!path.found && path.problems.length === 0) lines.push('         no route found');
    }
    lines.push('');

    const failures = [
      ...result.nodeCategories.flatMap((entry) =>
        entry.missing.map((key) => `missing node   ${key}`),
      ),
      ...result.nodeCategories.flatMap((entry) =>
        entry.unexpected.map((key) => `unexpected node ${entry.category}|${key}`),
      ),
      ...result.edgeCategories.flatMap((entry) =>
        entry.missing.map((key) => `missing edge   ${key}`),
      ),
      ...result.edgeCategories.flatMap((entry) =>
        entry.unexpected.map((key) => `unexpected edge ${key}`),
      ),
      ...[...result.nodeCategories, ...result.edgeCategories].flatMap((entry) =>
        entry.mismatches.map((mismatch) => `mismatch       ${mismatch.expected} — ${mismatch.reason}`),
      ),
    ];

    if (failures.length > 0) {
      lines.push('Failures');
      for (const failure of failures) lines.push(`  ${failure}`);
      lines.push('');
    }

    lines.push(result.passed ? 'RESULT: pass' : 'RESULT: fail');
    lines.push('');
  }

  return lines.join('\n');
}

function scoreLines(score: Score, indent: string): string[] {
  return [
    `${indent}Precision:     ${formatRatio(score.precision)}${score.closed ? '' : '  (open set: ground truth does not enumerate every correct answer)'}`,
    `${indent}Recall:        ${formatRatio(score.recall)}`,
    `${indent}F1:            ${formatRatio(score.f1)}`,
    `${indent}Expected ${String(score.expected)}, found ${String(score.truePositives)}, produced ${String(score.produced)}`,
  ];
}

function categoryLines(categories: readonly CategoryResult[]): string[] {
  const lines: string[] = [];
  const width = Math.max(...categories.map((entry) => entry.category.length), 1);

  for (const entry of categories) {
    const score = entry.score;
    lines.push(
      `    ${entry.category.padEnd(width)}  P ${pad(formatRatio(score.precision))}  R ${pad(formatRatio(score.recall))}  F1 ${pad(formatRatio(score.f1))}  ${String(score.truePositives)}/${String(score.expected)} expected, ${String(score.produced)} produced${score.closed ? '' : '  [open]'}`,
    );
  }
  return lines;
}

function pad(value: string): string {
  return value.padStart(6);
}
