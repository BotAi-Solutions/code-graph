import type { EvaluationRun, RetrievalEvaluationResult } from './types.js';

/**
 * Turning a run into something a person reads and something a machine reads.
 *
 * The report leads with the failures, not the totals. A percentage tells you
 * the mood; "READS_FROM → postgresql.users was not retrieved" tells you what to
 * build next, and that is the only reason this package exists.
 */

const RULE = '─'.repeat(64);

function bar(summary: { passed: number; partial: number; failed: number; total: number }): string {
  return `${String(summary.passed)}/${String(summary.total)}${
    summary.partial > 0 ? `  (${String(summary.partial)} partial)` : ''
  }${summary.failed > 0 ? `  (${String(summary.failed)} failed)` : ''}`;
}

/** The failures, each one naming the evidence that was not retrieved. */
function renderFailure(result: RetrievalEvaluationResult): string[] {
  const mark = result.status === 'partial' ? '~' : '✗';
  const lines = [`${mark} ${result.caseId}  [${result.category}]`, `  ${result.question}`];

  if (result.error) lines.push(`  error: ${result.error}`);

  for (const check of result.checks) {
    if (check.status === 'pass') {
      lines.push(`  ${check.name}: ok`);
      continue;
    }

    lines.push(`  ${check.name}: missing`);
    for (const missing of check.missing) lines.push(`     - ${missing}`);
    if (check.error) lines.push(`     (${check.error})`);
    if (check.found.length > 0) {
      const shown = check.found.slice(0, 6);
      lines.push(`     retrieved: ${shown.join(', ')}${check.found.length > 6 ? ' …' : ''}`);
    } else {
      lines.push('     retrieved: nothing');
    }
  }

  if (result.knownGap) lines.push(`  known: ${result.knownGap}`);

  return lines;
}

export function formatReport(run: EvaluationRun): string {
  const lines: string[] = ['CodeRAG Retrieval Evaluation', RULE, ''];

  for (const project of run.projects) {
    lines.push(
      `${project.repository}  →  ${project.name} (${project.projectId.slice(0, 8)}…, ${String(project.nodeCount)} nodes)`,
    );
  }

  lines.push('');
  lines.push(
    `Cases: ${String(run.totals.total)}    Pass: ${String(run.totals.passed)}    Partial: ${String(run.totals.partial)}    Fail: ${String(run.totals.failed)}`,
  );
  lines.push('');
  lines.push('By category:');

  const width = Math.max(...run.byCategory.map((summary) => summary.category.length), 0);
  for (const summary of run.byCategory) {
    lines.push(`  ${summary.category.padEnd(width)}  ${bar(summary)}`);
  }

  const failures = run.results.filter((result) => result.status !== 'pass');

  if (failures.length === 0) {
    lines.push('', RULE, '', 'Every case retrieved the evidence it expected.');
    return lines.join('\n');
  }

  lines.push('', 'Failures', RULE, '');
  for (const failure of failures) {
    lines.push(...renderFailure(failure), '');
  }

  return lines.join('\n').trimEnd();
}

/**
 * The machine-readable form.
 *
 * The whole run, not a summary of it: the point of writing a file is that
 * something later can diff two of them, and a diff of two percentages says
 * nothing about which case changed.
 */
export function toMachineReport(run: EvaluationRun): unknown {
  return {
    generatedAt: new Date().toISOString(),
    projects: run.projects,
    totals: run.totals,
    byCategory: run.byCategory,
    results: run.results,
  };
}
