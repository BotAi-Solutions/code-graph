import { describe, expect, it } from 'vitest';
import { RunMetrics } from '../src/services/run-metrics.js';

/**
 * The phase timer, on a clock the test controls, so every number is exact.
 */
function steppingClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1000;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe('RunMetrics', () => {
  it('records each phase, the total, and what fell between phases', async () => {
    const clock = steppingClock();
    const metrics = new RunMetrics(clock.now);

    clock.advance(5); // before any phase: unattributed
    await metrics.time('scan', () => clock.advance(20));
    await metrics.time('persist', async () => clock.advance(12.345));
    clock.advance(3);

    const timings = metrics.timings({ analyzers: [{ analyzer: 'scip', durationMs: 1.234, outcome: 'completed' }] });

    expect(timings.phases).toEqual({ scan: 20, persist: 12.35 });
    expect(timings.totalMs).toBe(40.35);
    expect(timings.unattributedMs).toBe(8);
    expect(timings.analyzers).toEqual([{ analyzer: 'scip', durationMs: 1.23, outcome: 'completed' }]);
  });

  it('leaves a phase that never ran absent, rather than zero', () => {
    const metrics = new RunMetrics(steppingClock().now);
    const timings = metrics.timings({ analyzers: [] });

    expect(timings.phases).toEqual({});
    expect('scipIndexerReportedMs' in timings).toBe(false);
  });

  it('records a phase that throws, then rethrows', async () => {
    const clock = steppingClock();
    const metrics = new RunMetrics(clock.now);

    await expect(
      metrics.time('scipIndex', () => {
        clock.advance(7);
        throw new Error('indexer failed');
      }),
    ).rejects.toThrow('indexer failed');
    expect(metrics.timings({ analyzers: [] }).phases.scipIndex).toBe(7);
  });

  it('reports worker CPU and memory, and says the indexer was not measured', () => {
    const resources = new RunMetrics().resources();

    expect(resources.indexerMeasured).toBe(false);
    expect(resources.workerCpuUserMs).toBeGreaterThanOrEqual(0);
    expect(resources.workerSampledPeakRssBytes).toBeGreaterThan(0);
    expect(resources.rssSamples).toBeGreaterThanOrEqual(2);
  });
});
