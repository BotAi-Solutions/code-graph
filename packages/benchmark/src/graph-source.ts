import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeGraphAssembler, ScipAnalyzer, type AssembledGraph } from '@ckg/graph';
import { createDefaultAnalyzers, loadSourceFiles } from '@ckg/analysis';
import { readScipIndexFile, TypeScriptSymbolRefiner } from '@ckg/scip';

/**
 * The graph the benchmark measures.
 *
 * Assembled from the checked-in SCIP fixture and the real analyzers, with no
 * database, no subprocess and no network. The indexer is the one genuinely
 * external step in the pipeline and it is already pinned as a binary fixture,
 * so everything the benchmark scores is code that ships.
 *
 * The identity scope is fixed rather than random, which matters twice: node ids
 * are content hashes of it, so a fixed scope makes a run byte-reproducible, and
 * a reproducible run is what lets two benchmark results be compared at all.
 */

const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));

export const BENCHMARK_IDENTITY = {
  projectId: '00000000-0000-4000-8000-000000000001',
  repositoryId: '00000000-0000-4000-8000-000000000002',
} as const;

export interface FixtureDefinition {
  /** Directory name under `test-repositories/`, and the ground-truth folder. */
  name: string;
  /** What the fixture is for, printed in the report header. */
  title: string;
}

export const BENCHMARK_FIXTURES: readonly FixtureDefinition[] = [
  {
    name: 'repository-knowledge-sample',
    title: 'TypeScript, Markdown, JSON, YAML, OpenAPI and SQL in one repository',
  },
];

export interface BuiltFixture {
  fixture: FixtureDefinition;
  repositoryPath: string;
  graph: AssembledGraph;
  durationMs: number;
}

export function fixturePathOf(name: string): string {
  return path.join(WORKSPACE, 'test-repositories', name);
}

export function scipFixturePathOf(name: string): string {
  return path.join(WORKSPACE, 'packages/scip/tests/fixtures', `${name}.scip`);
}

export async function buildFixtureGraph(fixture: FixtureDefinition): Promise<BuiltFixture> {
  const startedAt = Date.now();
  const repositoryPath = fixturePathOf(fixture.name);

  const index = await new TypeScriptSymbolRefiner().refine(
    await readScipIndexFile(scipFixturePathOf(fixture.name)),
    { repositoryPath },
  );

  const graph = await new CodeGraphAssembler({
    identity: BENCHMARK_IDENTITY,
    repositoryName: fixture.name,
    repositoryPath,
    language: 'typescript',
    sources: await loadSourceFiles(repositoryPath),
    analyzers: [new ScipAnalyzer({ index }), ...createDefaultAnalyzers()],
  }).assemble();

  return { fixture, repositoryPath, graph, durationMs: Date.now() - startedAt };
}
