import { evaluate, type EvaluationResult } from './evaluate.js';
import { BENCHMARK_FIXTURES, buildFixtureGraph, type FixtureDefinition } from './graph-source.js';
import { loadGroundTruth, type GroundTruth } from './ground-truth.js';

/**
 * Running the benchmark: build each fixture's graph, score it, return the
 * results. No printing, no process exit, no file writing — those belong to the
 * CLI, and keeping them out of here is what lets the tests run the real thing.
 */

export interface BenchmarkRun {
  results: EvaluationResult[];
  /** Per fixture, how long assembling its graph took. */
  timings: Array<{ fixture: string; durationMs: number }>;
  passed: boolean;
}

export interface RunOptions {
  fixtures?: readonly FixtureDefinition[];
  /** Overrides where ground truth is read from. For tests. */
  groundTruthDirectory?: string;
}

export async function runBenchmark(options: RunOptions = {}): Promise<BenchmarkRun> {
  const fixtures = options.fixtures ?? BENCHMARK_FIXTURES;

  const results: EvaluationResult[] = [];
  const timings: BenchmarkRun['timings'] = [];

  for (const fixture of fixtures) {
    const truth: GroundTruth = await loadGroundTruth(
      fixture.name,
      options.groundTruthDirectory,
    );
    const built = await buildFixtureGraph(fixture);

    results.push(evaluate(built.graph, truth));
    timings.push({ fixture: fixture.name, durationMs: built.durationMs });
  }

  return { results, timings, passed: results.every((result) => result.passed) };
}
