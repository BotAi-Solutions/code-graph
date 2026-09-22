import { describe, expect, it } from 'vitest';
import type { CodeNode, CodeSearchMatch, GraphPath, NodeDetail, SourceWindow } from '@ckg/shared';
import type { ResolvedProject, RetrievalClient } from '../src/client.js';
import {
  checkFiles,
  checkNodes,
  checkNoPath,
  checkPath,
  checkRelationships,
  checkSourceMatches,
  verdict,
} from '../src/match.js';
import { runEvaluation, summariseByCategory } from '../src/run.js';
import { formatReport } from '../src/report.js';
import { RETRIEVAL_CASES } from '../src/cases.js';
import type { RetrievalEvaluationCase, RetrievalEvaluationResult } from '../src/types.js';

/**
 * The evaluator, checked the way it checks retrieval: exactly.
 *
 * An evaluator that is wrong in the lenient direction is worse than none at
 * all — it reports that retrieval works and stops anyone looking. So the cases
 * that matter most here are the ones where something *nearly* matches: the
 * right relationship between the wrong nodes, the right nodes in the wrong
 * order, the right file in another project.
 */

// --- fixtures --------------------------------------------------------------

function node(name: string, overrides: Partial<CodeNode> = {}): CodeNode {
  return {
    id: `id-${name}`,
    projectId: 'p1',
    type: 'class',
    name: name.split('.').pop() ?? name,
    qualifiedName: name,
    ...overrides,
  };
}

function match(file: string, line = 1): CodeSearchMatch {
  return { filePath: file, line, column: 0, match: 'x', lineText: 'x', lineTruncated: false };
}

function path(nodes: string[], overrides: Partial<GraphPath> = {}): GraphPath {
  return {
    found: nodes.length > 0,
    from: nodes[0] ?? '',
    to: nodes[nodes.length - 1] ?? '',
    depth: Math.max(nodes.length - 1, 0),
    undirected: false,
    truncated: false,
    nodes: nodes.map((n) => node(n)),
    edges: [],
    steps: [],
    relationships: ['CALLS'],
    ...overrides,
  } as GraphPath;
}

// --- files -----------------------------------------------------------------

describe('file matching', () => {
  it('passes when every expected file was retrieved', () => {
    const result = checkFiles(['src/a.ts'], [match('src/a.ts'), match('src/b.ts')]);
    expect(result.status).toBe('pass');
  });

  it('names the file that was not retrieved', () => {
    const result = checkFiles(['src/a.ts', 'src/missing.ts'], [match('src/a.ts')]);

    expect(result.status).toBe('fail');
    expect(result.missing).toEqual(['src/missing.ts']);
    expect(result.found).toEqual(['src/a.ts']);
  });

  it('compares whole paths, not suffixes', () => {
    // `user.repository.ts` exists in three fixtures; a suffix match would let
    // one project's file satisfy another's expectation.
    expect(
      checkFiles(['src/repositories/user.repository.ts'], [match('other/user.repository.ts')])
        .status,
    ).toBe('fail');
  });

  it('treats an empty expectation as "and nothing came back"', () => {
    expect(checkFiles([], []).status).toBe('pass');
    expect(checkFiles([], [match('src/a.ts')]).status).toBe('fail');
  });
});

// --- nodes -----------------------------------------------------------------

describe('node matching', () => {
  it('passes when the expected node is among the results', () => {
    expect(checkNodes(['UserService'], [node('UserService'), node('UserRepository')]).status).toBe(
      'pass',
    );
  });

  it('fails on a node that was not retrieved', () => {
    const result = checkNodes(['UserService'], [node('UserRepository')]);

    expect(result.status).toBe('fail');
    expect(result.missing).toEqual(['UserService']);
  });

  it('does not accept a member for its class', () => {
    // A search for `UserService` returns its methods too; accepting one would
    // let a case pass because something merely related came back.
    expect(checkNodes(['UserService'], [node('UserService.create')]).status).toBe('fail');
  });
});

// --- relationships ---------------------------------------------------------

describe('relationship matching', () => {
  const neighbours = [
    { relationship: 'CALLS', name: 'UserRepository' },
    { relationship: 'READS_FROM', name: 'postgresql.users' },
  ];

  it('passes on the right type between the right endpoints', () => {
    expect(
      checkRelationships(
        [{ from: 'UserService', type: 'CALLS', to: 'UserRepository' }],
        'UserService',
        neighbours,
      ).status,
    ).toBe('pass');
  });

  it('fails on the right type to the wrong endpoint', () => {
    const result = checkRelationships(
      [{ from: 'UserService', type: 'CALLS', to: 'EmailService' }],
      'UserService',
      neighbours,
    );

    expect(result.status).toBe('fail');
    expect(result.missing).toEqual(['UserService CALLS EmailService']);
  });

  it('fails on the wrong type between the right endpoints', () => {
    // "Connected somehow" is not the claim; the type is the claim.
    expect(
      checkRelationships(
        [{ from: 'UserService', type: 'WRITES_TO', to: 'postgresql.users' }],
        'UserService',
        neighbours,
      ).status,
    ).toBe('fail');
  });

  it('matches an incoming relationship stated the other way round', () => {
    expect(
      checkRelationships(
        [{ from: 'UserController', type: 'CALLS', to: 'UserService' }],
        'UserService',
        [{ relationship: 'CALLS', name: 'UserController' }],
      ).status,
    ).toBe('pass');
  });

  it('cannot be satisfied by a relationship about a different subject', () => {
    expect(
      checkRelationships(
        [{ from: 'SomethingElse', type: 'CALLS', to: 'AnotherThing' }],
        'UserService',
        neighbours,
      ).status,
    ).toBe('fail');
  });
});

// --- paths -----------------------------------------------------------------

describe('path matching', () => {
  const expected = {
    from: 'A',
    to: 'C',
    nodes: ['A', 'B', 'C'],
  };

  it('passes on the exact sequence', () => {
    expect(checkPath(expected, path(['A', 'B', 'C'])).status).toBe('pass');
  });

  it('fails on the right endpoints through a different middle', () => {
    const result = checkPath(expected, path(['A', 'X', 'C']));

    expect(result.status).toBe('fail');
    expect(result.found).toEqual(['A → X → C']);
  });

  it('fails when no route was found', () => {
    expect(checkPath(expected, path([], { found: false })).status).toBe('fail');
  });

  it('distinguishes an exhausted search from a missing route', () => {
    const result = checkPath(expected, path([], { found: false, truncated: true }));

    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/node budget/);
  });

  it('checks the relationship sequence when one is expected', () => {
    expect(
      checkPath(
        { ...expected, relationships: ['CALLS', 'READS_FROM'] },
        path(['A', 'B', 'C'], { relationships: ['CALLS'] }),
      ).status,
    ).toBe('fail');
  });
});

describe('negative path assertions', () => {
  it('passes when a bounded search found nothing', () => {
    expect(checkNoPath('A', 'C', 1, path([], { found: false })).status).toBe('pass');
  });

  it('fails when a route came back anyway', () => {
    const result = checkNoPath('A', 'C', 1, path(['A', 'B', 'C']));

    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/2-hop route was returned for a 1-hop search/);
  });

  it('does not credit the bound when the search was truncated', () => {
    // "Could not tell" is not "there is no route".
    const result = checkNoPath('A', 'C', 1, path([], { found: false, truncated: true }));

    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/never proven/);
  });
});

// --- source ----------------------------------------------------------------

describe('source matching', () => {
  const window: SourceWindow = {
    file: 'src/a.ts',
    language: 'typescript',
    startLine: 5,
    endLine: 10,
    totalLines: 50,
    truncated: false,
    highlight: null,
    lines: [
      { line: 5, text: 'const before = 1;' },
      { line: 8, text: 'export class UserRepository {' },
    ],
  };

  it('passes when the line falls inside the retrieved window', () => {
    expect(
      checkSourceMatches([{ file: 'src/a.ts', line: 8 }], [], window).status,
    ).toBe('pass');
  });

  it('fails when the line falls outside it', () => {
    expect(checkSourceMatches([{ file: 'src/a.ts', line: 40 }], [], window).status).toBe('fail');
  });

  it('fails when the window is in the right place but does not contain the answer', () => {
    // The window found the line and still could not show what was asked about.
    const result = checkSourceMatches(
      [{ file: 'src/a.ts', line: 8, contains: 'INSERT INTO users' }],
      [],
      window,
    );

    expect(result.status).toBe('fail');
    expect(result.missing[0]).toMatch(/containing "INSERT INTO users"/);
  });

  it('accepts a code-search hit as the locating evidence', () => {
    expect(
      checkSourceMatches([{ file: 'src/b.ts', line: 3 }], [match('src/b.ts', 3)], null).status,
    ).toBe('pass');
  });
});

// --- verdicts and aggregation ----------------------------------------------

describe('verdicts', () => {
  const pass = { name: 'a', status: 'pass' as const, expected: [], found: [], missing: [] };
  const fail = { name: 'b', status: 'fail' as const, expected: [], found: [], missing: ['x'] };

  it('passes only when every check passed', () => {
    expect(verdict([pass, pass])).toBe('pass');
  });

  it('is partial when some evidence was found and some was not', () => {
    expect(verdict([pass, fail])).toBe('partial');
  });

  it('fails when nothing was found', () => {
    expect(verdict([fail, fail])).toBe('fail');
  });

  it('fails a case with no checks at all', () => {
    expect(verdict([])).toBe('fail');
  });
});

describe('aggregation', () => {
  const result = (
    caseId: string,
    category: RetrievalEvaluationResult['category'],
    status: RetrievalEvaluationResult['status'],
  ): RetrievalEvaluationResult => ({
    caseId,
    category,
    question: 'q',
    repository: 'r',
    status,
    checks: [],
  });

  it('counts by category, in the vocabulary’s own order', () => {
    const summary = summariseByCategory([
      result('a', 'trace_path', 'pass'),
      result('b', 'symbol_lookup', 'pass'),
      result('c', 'symbol_lookup', 'fail'),
      result('d', 'symbol_lookup', 'partial'),
    ]);

    // symbol_lookup precedes trace_path in RETRIEVAL_CATEGORIES, so two runs of
    // the same dataset print their rows the same way round.
    expect(summary.map((s) => s.category)).toEqual(['symbol_lookup', 'trace_path']);
    expect(summary[0]).toMatchObject({ total: 3, passed: 1, partial: 1, failed: 1 });
  });

  it('omits categories with no cases', () => {
    expect(summariseByCategory([result('a', 'symbol_lookup', 'pass')])).toHaveLength(1);
  });
});

// --- the runner ------------------------------------------------------------

/** A client that answers from a fixed, per-project world. */
function fakeClient(world: {
  projects: Record<string, ResolvedProject>;
  nodes?: Record<string, CodeNode[]>;
  detail?: Record<string, NodeDetail>;
  code?: Record<string, CodeSearchMatch[]>;
}): RetrievalClient & { asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    async resolveProject(repositoryPath) {
      const name = repositoryPath.split('/').pop() ?? '';
      return world.projects[name] ?? null;
    },
    async searchCode(projectId, query) {
      asked.push(`code:${projectId}:${query}`);
      return world.code?.[projectId] ?? [];
    },
    async searchGraph(projectId, query) {
      asked.push(`graph:${projectId}:${query}`);
      return world.nodes?.[projectId] ?? [];
    },
    async nodeDetail(projectId, nodeId) {
      asked.push(`node:${projectId}:${nodeId}`);
      const found = world.detail?.[projectId];
      if (!found) throw new Error('no detail');
      return found;
    },
    async findPath(projectId, from, to) {
      asked.push(`path:${projectId}:${from}->${to}`);
      return path([]);
    },
    async source(projectId, file) {
      asked.push(`source:${projectId}:${file}`);
      return {
        file,
        language: null,
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
        highlight: null,
        lines: [],
      };
    },
  };
}

describe('the runner', () => {
  const testCase = (overrides: Partial<RetrievalEvaluationCase> = {}): RetrievalEvaluationCase => ({
    id: 'c1',
    category: 'symbol_lookup',
    question: 'q',
    repository: 'alpha',
    probe: { graphSearch: 'UserService' },
    expected: { nodes: ['UserService'] },
    ...overrides,
  });

  it('resolves the repository and scores the case', async () => {
    const client = fakeClient({
      projects: { alpha: { projectId: 'p-alpha', name: 'alpha', nodeCount: 10 } },
      nodes: { 'p-alpha': [node('UserService')] },
    });

    const run = await runEvaluation(client, [testCase()]);

    expect(run.totals).toEqual({ total: 1, passed: 1, partial: 0, failed: 0 });
    expect(run.projects).toEqual([
      { repository: 'alpha', projectId: 'p-alpha', name: 'alpha', nodeCount: 10 },
    ]);
  });

  it('never asks about a project other than the case’s own', async () => {
    // The isolation the whole retrieval design rests on: a case about `alpha`
    // must not be satisfiable by anything in `beta`.
    const client = fakeClient({
      projects: {
        alpha: { projectId: 'p-alpha', name: 'alpha', nodeCount: 10 },
        beta: { projectId: 'p-beta', name: 'beta', nodeCount: 10 },
      },
      // Only beta holds the node the case wants.
      nodes: { 'p-beta': [node('UserService')], 'p-alpha': [] },
    });

    const run = await runEvaluation(client, [testCase()]);

    expect(run.results[0]?.status).toBe('fail');
    for (const request of client.asked) expect(request).not.toContain('p-beta');
  });

  it('reports a repository that resolves to no project, without throwing', async () => {
    const run = await runEvaluation(fakeClient({ projects: {} }), [testCase()]);

    expect(run.results[0]).toMatchObject({ status: 'fail' });
    expect(run.results[0]?.error).toMatch(/no indexed project resolved/);
  });

  it('records a retrieval error against the case rather than aborting the run', async () => {
    const client = fakeClient({
      projects: { alpha: { projectId: 'p-alpha', name: 'alpha', nodeCount: 1 } },
      nodes: { 'p-alpha': [node('UserService')] },
    });

    const run = await runEvaluation(client, [
      testCase({ id: 'broken', probe: { node: 'UserService' }, expected: { nodes: ['X'] } }),
      testCase({ id: 'fine' }),
    ]);

    expect(run.results).toHaveLength(2);
    expect(run.results[1]?.status).toBe('pass');
  });

  it('runs only the retrieval a case names', async () => {
    const client = fakeClient({
      projects: { alpha: { projectId: 'p-alpha', name: 'alpha', nodeCount: 1 } },
      nodes: { 'p-alpha': [] },
    });

    await runEvaluation(client, [testCase({ probe: { graphSearch: 'X' }, expected: {} })]);

    // No source read, no node detail, no path search: nothing the case did not ask for.
    expect(client.asked).toEqual(['graph:p-alpha:X']);
  });

  it('honours a case filter', async () => {
    const client = fakeClient({
      projects: { alpha: { projectId: 'p-alpha', name: 'alpha', nodeCount: 1 } },
      nodes: { 'p-alpha': [node('UserService')] },
    });

    const run = await runEvaluation(client, [testCase({ id: 'a' }), testCase({ id: 'b' })], {
      only: ['b'],
    });

    expect(run.results.map((r) => r.caseId)).toEqual(['b']);
  });
});

// --- the dataset itself ----------------------------------------------------

describe('the dataset', () => {
  it('has a unique id for every case', () => {
    const ids = RETRIEVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names only fixtures that exist in the repository', () => {
    const known = new Set([
      'express-postgres-sample',
      'typescript-sample',
      'repository-knowledge-sample',
    ]);
    for (const testCase of RETRIEVAL_CASES) expect(known).toContain(testCase.repository);
  });

  it('gives every case something to retrieve and something to check', () => {
    for (const testCase of RETRIEVAL_CASES) {
      expect(Object.keys(testCase.probe).length, testCase.id).toBeGreaterThan(0);
      expect(Object.keys(testCase.expected).length, testCase.id).toBeGreaterThan(0);
    }
  });

  it('never hard-codes a project id', () => {
    // Project ids differ per database; a case carrying one would pass on one
    // machine and fail on every other.
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(uuid.test(JSON.stringify(RETRIEVAL_CASES))).toBe(false);
  });

  it('asks a real question of every case', () => {
    for (const testCase of RETRIEVAL_CASES) {
      expect(testCase.question.length, testCase.id).toBeGreaterThan(10);
    }
  });
});

// --- the report ------------------------------------------------------------

describe('the report', () => {
  it('leads with the failures and names the missing evidence', () => {
    const text = formatReport({
      projects: [{ repository: 'alpha', projectId: 'p-alpha', name: 'alpha', nodeCount: 10 }],
      results: [
        {
          caseId: 'db-read',
          category: 'database_access',
          question: 'What reads the users table?',
          repository: 'alpha',
          status: 'fail',
          checks: [
            {
              name: 'relationships',
              status: 'fail',
              expected: ['UserRepository READS_FROM postgresql.users'],
              found: [],
              missing: ['UserRepository READS_FROM postgresql.users'],
            },
          ],
        },
      ],
      totals: { total: 1, passed: 0, partial: 0, failed: 1 },
      byCategory: [
        { category: 'database_access', total: 1, passed: 0, partial: 0, failed: 1 },
      ],
    });

    expect(text).toContain('UserRepository READS_FROM postgresql.users');
    expect(text).toContain('retrieved: nothing');
    expect(text).toContain('alpha (p-alpha…, 10 nodes)');
  });

  it('says so plainly when everything passed', () => {
    const text = formatReport({
      projects: [],
      results: [],
      totals: { total: 0, passed: 0, partial: 0, failed: 0 },
      byCategory: [],
    });

    expect(text).toMatch(/Every case retrieved the evidence it expected/);
  });
});
