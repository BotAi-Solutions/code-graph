import { describe, expect, it } from 'vitest';
import {
  aggregate,
  f1Of,
  formatRatio,
  precisionOf,
  recallOf,
  scoreOf,
  type Score,
} from '../src/metrics.js';

/**
 * The arithmetic, on its own.
 *
 * Worth testing directly because a benchmark's numbers are the only thing
 * anyone quotes from it, and the one failure mode that matters is a plausible
 * number computed from the wrong denominator.
 */

describe('precision, recall and F1', () => {
  it('computes the textbook values', () => {
    const counts = { truePositives: 8, falsePositives: 2, falseNegatives: 4 };

    expect(precisionOf(counts)).toBeCloseTo(0.8);
    expect(recallOf(counts)).toBeCloseTo(2 / 3);
    expect(f1Of(0.8, 2 / 3)).toBeCloseTo(0.7272, 3);
  });

  it('returns null rather than dividing by zero', () => {
    const empty = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };

    expect(precisionOf(empty)).toBeNull();
    expect(recallOf(empty)).toBeNull();
    expect(f1Of(null, 1)).toBeNull();
    expect(f1Of(1, null)).toBeNull();
  });

  it('reports zero, not null, when both are zero but something was expected', () => {
    expect(f1Of(0, 0)).toBe(0);
    expect(recallOf({ truePositives: 0, falsePositives: 0, falseNegatives: 3 })).toBe(0);
  });
});

describe('open and closed categories', () => {
  const counts = { truePositives: 5, falsePositives: 3, falseNegatives: 1 };

  it('measures precision for a closed category', () => {
    const score = scoreOf(counts, { closed: true, produced: 8 });

    expect(score.precision).toBeCloseTo(5 / 8);
    expect(score.recall).toBeCloseTo(5 / 6);
    expect(score.f1).not.toBeNull();
  });

  it('refuses to measure precision for an open one', () => {
    // The ground truth lists examples, not every correct answer, so the
    // denominator does not exist and a number here would be a fabrication.
    const score = scoreOf(counts, { closed: false, produced: 400 });

    expect(score.precision).toBeNull();
    expect(score.f1).toBeNull();
    expect(score.recall).toBeCloseTo(5 / 6);
    expect(score.produced).toBe(400);
  });

  it('reports how many were expected and how many were produced either way', () => {
    const score = scoreOf(counts, { closed: false, produced: 400 });
    expect(score.expected).toBe(6);
  });
});

describe('aggregating categories', () => {
  const closed = (tp: number, fp: number, fn: number, produced: number): Score =>
    scoreOf({ truePositives: tp, falsePositives: fp, falseNegatives: fn }, { closed: true, produced });

  const open = (tp: number, fn: number, produced: number): Score =>
    scoreOf({ truePositives: tp, falsePositives: 0, falseNegatives: fn }, { closed: false, produced });

  it('micro-averages, so a large category weighs more than a small one', () => {
    const total = aggregate([closed(90, 10, 0, 100), closed(1, 0, 1, 1)]);

    // Macro-averaging would give (0.9 + 1.0) / 2 = 0.95; the right answer is
    // 91 correct out of 101 produced.
    expect(total.precision).toBeCloseTo(91 / 101);
    expect(total.truePositives).toBe(91);
  });

  it('keeps an open category out of the aggregate precision', () => {
    const total = aggregate([closed(8, 2, 0, 10), open(5, 0, 500)]);

    // The open category's 5 hits would otherwise be counted as 5 correct out of
    // 5 produced, hiding the 495 the ground truth says nothing about.
    expect(total.precision).toBeCloseTo(0.8);
    // Recall spans everything, because every expected entry was enumerable.
    expect(total.recall).toBe(1);
  });

  it('reports null precision when every category is open', () => {
    expect(aggregate([open(3, 1, 50)]).precision).toBeNull();
  });

  it('handles an empty list without throwing', () => {
    expect(aggregate([])).toMatchObject({ precision: null, recall: null, expected: 0 });
  });
});

describe('formatting', () => {
  it('prints a percentage to one decimal place', () => {
    expect(formatRatio(0.9814)).toBe('98.1%');
    expect(formatRatio(1)).toBe('100.0%');
    expect(formatRatio(0)).toBe('0.0%');
  });

  it('prints `n/a` for a ratio that was not measurable', () => {
    expect(formatRatio(null)).toBe('n/a');
  });
});
