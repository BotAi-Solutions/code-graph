import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_PHASE_BY_STATUS,
  ANALYSIS_PHASE_LABELS,
  ANALYSIS_PHASES,
  ANALYSIS_STATUSES,
  analysisProgressFraction,
  isTerminalAnalysisPhase,
  type AnalysisPhase,
  type AnalysisProgress,
} from '../src/index.js';

/**
 * The rules a progress bar has to obey to be worth showing.
 *
 * The percentage is the only derived number anywhere in the indexing UI, so it
 * is the only place something dishonest could get in. These tests are about
 * that: it never runs backwards, it never reaches the end before the run does,
 * and a phase that cannot count its work does not quietly acquire a
 * denominator.
 */

const at = (phase: AnalysisPhase, current = 0, total = 0): AnalysisProgress => ({
  phase,
  current,
  total,
  message: 'working',
});

describe('analysisProgressFraction', () => {
  it('starts at nothing and ends at everything', () => {
    expect(analysisProgressFraction(at('queued'))).toBe(0);
    expect(analysisProgressFraction(at('completed'))).toBe(1);
  });

  it('never runs backwards as the pipeline advances', () => {
    const walk: AnalysisPhase[] = [
      'queued',
      'scanning',
      'indexing',
      'parsing',
      'resolving',
      'building_graph',
      'persisting',
      'completed',
    ];

    const fractions = walk.map((phase) => analysisProgressFraction(at(phase)));
    expect([...fractions]).toEqual([...fractions].sort((a, b) => a - b));
  });

  it('advances within a phase in proportion to the phase’s own work', () => {
    const start = analysisProgressFraction(at('parsing', 0, 100));
    const half = analysisProgressFraction(at('parsing', 50, 100));
    const done = analysisProgressFraction(at('parsing', 100, 100));

    expect(half).toBeGreaterThan(start);
    expect(done).toBeGreaterThan(half);
    // A finished phase reaches exactly where the next one begins: there is no
    // gap for the bar to jump across.
    expect(done).toBeCloseTo(analysisProgressFraction(at('resolving', 0, 8)), 10);
  });

  it('holds still in a phase that cannot count its work', () => {
    // An external indexer reports nothing until it exits. The bar must not
    // creep forward on a denominator nobody has.
    expect(analysisProgressFraction(at('indexing', 0, 0))).toBe(
      analysisProgressFraction(at('indexing', 999, 0)),
    );
  });

  it('never exceeds 1, whatever the pipeline claims', () => {
    expect(analysisProgressFraction(at('parsing', 500, 100))).toBeLessThanOrEqual(1);
    expect(analysisProgressFraction(at('persisting', 10, 1))).toBeLessThanOrEqual(1);
  });

  it('is never complete before the run is', () => {
    for (const phase of ['scanning', 'indexing', 'parsing', 'resolving', 'building_graph'] as const) {
      expect(analysisProgressFraction(at(phase, 1_000_000, 1_000_000))).toBeLessThan(1);
    }
  });

  it('treats a failure as finished, because nothing more will happen', () => {
    expect(analysisProgressFraction(at('failed'))).toBe(1);
    expect(isTerminalAnalysisPhase('failed')).toBe(true);
    expect(isTerminalAnalysisPhase('completed')).toBe(true);
    expect(isTerminalAnalysisPhase('parsing')).toBe(false);
  });
});

describe('the phase vocabulary', () => {
  it('gives every status a phase, so a job without a report still reads', () => {
    for (const status of ANALYSIS_STATUSES) {
      const phase = ANALYSIS_PHASE_BY_STATUS[status];
      expect(ANALYSIS_PHASES).toContain(phase);
    }
  });

  it('labels every phase', () => {
    for (const phase of ANALYSIS_PHASES) {
      expect(ANALYSIS_PHASE_LABELS[phase]).toBeTruthy();
    }
  });
});
