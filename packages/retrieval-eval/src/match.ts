import type { CodeNode, CodeSearchMatch, GraphPath, SourceWindow } from '@ckg/shared';
import type {
  CheckResult,
  ExpectedPath,
  ExpectedRelationship,
  ExpectedSourceMatch,
} from './types.js';

/**
 * The comparisons, and nothing else.
 *
 * Every one of these is exact. Nothing here lower-cases, trims, fuzzy-matches,
 * scores similarity or asks anything whether two things are "close enough" — a
 * retrieval evaluator that guessed would be measuring its own guesses, and the
 * failures it hid would be exactly the ones worth seeing.
 *
 * The one normalisation is naming: a node is identified by its qualified name
 * where it has one and its plain name where it does not, because that is how
 * the graph itself names things and how a person would write the expectation.
 */

/** How a node is referred to in an expectation. */
export function nameOf(node: { name: string; qualifiedName?: string | undefined }): string {
  return node.qualifiedName ?? node.name;
}

/**
 * One expectation, compared.
 *
 * An *empty* expectation means "and nothing should have come back" rather than
 * "anything is fine". The other reading makes an empty list pass vacuously,
 * which would let a case asserting that a case-sensitive search finds nothing
 * pass while the search happily returned results — the exact failure it exists
 * to catch.
 */
function check(
  name: string,
  expected: string[],
  found: string[],
  matched: (value: string) => boolean,
): CheckResult {
  if (expected.length === 0) {
    return {
      name,
      status: found.length === 0 ? 'pass' : 'fail',
      expected: [],
      found,
      missing: found.length === 0 ? [] : [`nothing, but ${String(found.length)} result(s) came back`],
    };
  }

  const missing = expected.filter((value) => !matched(value));
  return {
    name,
    status: missing.length === 0 ? 'pass' : 'fail',
    expected,
    found,
    missing,
  };
}

/**
 * Files, compared as whole repository-relative paths.
 *
 * Not by suffix: `user.repository.ts` appears in three fixtures, and a check
 * that accepted any of them would pass for the wrong project.
 */
export function checkFiles(expected: string[], matches: CodeSearchMatch[]): CheckResult {
  const found = [...new Set(matches.map((match) => match.filePath))].sort();
  return check('files', expected, found, (file) => found.includes(file));
}

/** Node names, compared exactly against whatever the retrieval produced. */
export function checkNodes(expected: string[], nodes: CodeNode[]): CheckResult {
  const found = [...new Set(nodes.map(nameOf))].sort();
  return check('nodes', expected, found, (name) => found.includes(name));
}

/** A neighbour of the inspected node, flattened to `TYPE → name`. */
export interface Neighbour {
  relationship: string;
  name: string;
}

/**
 * Relationships, compared on all three parts.
 *
 * A relationship is only retrieved if the *type* and *both endpoints* came
 * back. Accepting two of the three would let "UserRepository is connected to
 * postgresql.users somehow" pass for "UserRepository READS_FROM
 * postgresql.users", and the difference between those is the whole value of
 * having a graph.
 */
export function checkRelationships(
  expected: ExpectedRelationship[],
  subject: string,
  neighbours: Neighbour[],
): CheckResult {
  const found = neighbours.map((n) => `${subject} ${n.relationship} ${n.name}`).sort();
  const wanted = expected.map((r) => `${r.from} ${r.type} ${r.to}`);

  // The node detail is one node's neighbourhood, so an expectation about a
  // different subject cannot be satisfied by it, whichever way round it reads.
  const has = (r: ExpectedRelationship): boolean =>
    (r.from === subject && neighbours.some((n) => n.relationship === r.type && n.name === r.to)) ||
    (r.to === subject && neighbours.some((n) => n.relationship === r.type && n.name === r.from));

  const missing = expected.filter((r) => !has(r)).map((r) => `${r.from} ${r.type} ${r.to}`);

  return {
    name: 'relationships',
    status: missing.length === 0 ? 'pass' : 'fail',
    expected: wanted,
    found,
    missing,
  };
}

/**
 * A route, compared as the exact sequence of nodes.
 *
 * Exact and ordered: "it passes through these three somewhere" is a different
 * and much weaker claim than "the route is this". A path that reaches the right
 * destination through the wrong middle is a wrong answer about the
 * architecture, and it should read as one.
 */
export function checkPath(expected: ExpectedPath, path: GraphPath | null): CheckResult {
  const wanted = [expected.nodes.join(' → ')];

  if (!path || !path.found) {
    return {
      name: 'path',
      status: 'fail',
      expected: wanted,
      found: [],
      missing: wanted,
      ...(path?.truncated === true
        ? { error: 'the search spent its node budget before it could conclude' }
        : {}),
    };
  }

  const actual = path.nodes.map(nameOf);
  const sequenceMatches =
    actual.length === expected.nodes.length &&
    actual.every((name, index) => name === expected.nodes[index]);

  const relationshipsMatch =
    expected.relationships === undefined ||
    (path.relationships.length === expected.relationships.length &&
      path.relationships.every((rel, index) => rel === expected.relationships?.[index]));

  const missing: string[] = [];
  if (!sequenceMatches) missing.push(`node sequence: ${expected.nodes.join(' → ')}`);
  if (!relationshipsMatch) {
    missing.push(`relationship sequence: ${(expected.relationships ?? []).join(' → ')}`);
  }

  return {
    name: 'path',
    status: missing.length === 0 ? 'pass' : 'fail',
    expected: wanted,
    found: [actual.join(' → ')],
    missing,
  };
}

/**
 * Source evidence, in the two forms a question needs it.
 *
 * A file and a line answer "where"; `contains` answers "and is the thing
 * actually there" — which is the check that catches a window centred on the
 * right line but too narrow to hold the answer.
 */
export function checkSourceMatches(
  expected: ExpectedSourceMatch[],
  matches: CodeSearchMatch[],
  window: SourceWindow | null,
): CheckResult {
  const found: string[] = matches.map((m) => `${m.filePath}:${String(m.line)}`);
  if (window) found.push(`${window.file}:${String(window.startLine)}-${String(window.endLine)}`);

  const text = window ? window.lines.map((line) => line.text).join('\n') : null;

  const missing = expected
    .filter((want) => {
      const inMatches = matches.some(
        (m) => m.filePath === want.file && (want.line === undefined || m.line === want.line),
      );
      const inWindow =
        window !== null &&
        window.file === want.file &&
        (want.line === undefined ||
          (want.line >= window.startLine && want.line <= window.endLine));

      const located = inMatches || inWindow;
      if (!located) return true;

      // `contains` is checked against the retrieved window only: it is an
      // assertion about what the caller can actually read.
      if (want.contains === undefined) return false;
      return text === null || !text.includes(want.contains);
    })
    .map(
      (want) =>
        `${want.file}${want.line === undefined ? '' : `:${String(want.line)}`}${
          want.contains === undefined ? '' : ` containing ${JSON.stringify(want.contains)}`
        }`,
    );

  return {
    name: 'source',
    status: missing.length === 0 ? 'pass' : 'fail',
    expected: expected.map(
      (want) => `${want.file}${want.line === undefined ? '' : `:${String(want.line)}`}`,
    ),
    found: [...new Set(found)],
    missing,
  };
}

/**
 * The negative assertion: these two must *not* be connected within the bound.
 *
 * Expressible on its own because the alternative — writing an unreachable
 * positive expectation and reading its failure as success — makes the report
 * lie. A run that prints `✗` beside correct behaviour trains its reader to
 * ignore the `✗` column, which is the only column that matters here.
 */
export function checkNoPath(
  from: string,
  to: string,
  maxDepth: number,
  path: GraphPath | null,
): CheckResult {
  const expected = [`no route from ${from} to ${to} within ${String(maxDepth)} hop(s)`];

  if (path === null) {
    return { name: 'no-path', status: 'fail', expected, found: [], missing: expected,
      error: 'the search did not run' };
  }

  if (path.truncated) {
    // "Could not tell" is not "there is no route", and scoring it as one would
    // credit the bound for something the search never established.
    return {
      name: 'no-path',
      status: 'fail',
      expected,
      found: ['search truncated before it could conclude'],
      missing: expected,
      error: 'the search spent its node budget, so the absence was never proven',
    };
  }

  if (!path.found) return { name: 'no-path', status: 'pass', expected, found: [], missing: [] };

  return {
    name: 'no-path',
    status: 'fail',
    expected,
    found: [path.nodes.map(nameOf).join(' → ')],
    missing: expected,
    error: `a ${String(path.depth)}-hop route was returned for a ${String(maxDepth)}-hop search`,
  };
}

/**
 * The case's verdict, from its checks.
 *
 * Three outcomes rather than a score, because they call for different
 * responses. `partial` is the interesting one: it means retrieval found some of
 * the evidence, so the capability exists and something specific is missing —
 * which is a far more actionable report than a number that went down.
 */
export function verdict(checks: CheckResult[]): 'pass' | 'partial' | 'fail' {
  if (checks.length === 0) return 'fail';
  const passed = checks.filter((c) => c.status === 'pass').length;
  if (passed === checks.length) return 'pass';
  if (passed === 0) return 'fail';
  return 'partial';
}
