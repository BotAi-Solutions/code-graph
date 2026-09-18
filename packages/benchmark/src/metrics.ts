/**
 * Precision, recall and F1 — and the one decision that makes them mean
 * anything on a knowledge graph.
 *
 * ## Closed and open categories
 *
 * Recall is easy: of the things the ground truth says should be in the graph,
 * how many are? Precision is the hard one, because it needs the denominator to
 * be *everything the extractor produced*, and that is only comparable to ground
 * truth if the ground truth enumerates every correct answer.
 *
 * For some categories it does. Every `api_endpoint`, every `container`, every
 * `table` in the fixture is written down, so anything else the pipeline
 * produces in those categories is by definition a false positive and precision
 * is a real measurement. Those categories are **closed**.
 *
 * For others it does not, and could not usefully: nobody is going to enumerate
 * every `REFERENCES` edge a compiler emits, and a ground truth that tried would
 * be wrong within a week. Those categories are **open**, and for them this
 * module reports recall and *declines to report precision* rather than
 * computing a number whose denominator is a list of examples.
 *
 * A benchmark that prints 34% precision because its ground truth is a sample is
 * worse than one that prints "open set": the first number will be quoted.
 */

export interface Counts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface Score extends Counts {
  /** Null for an open category, where the denominator is not enumerable. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** True when precision was measurable, i.e. the category is closed. */
  closed: boolean;
  /** Expected entries: true positives plus false negatives. */
  expected: number;
  /** Entries the pipeline produced in this category. */
  produced: number;
}

export function precisionOf(counts: Counts): number | null {
  const denominator = counts.truePositives + counts.falsePositives;
  return denominator === 0 ? null : counts.truePositives / denominator;
}

export function recallOf(counts: Counts): number | null {
  const denominator = counts.truePositives + counts.falseNegatives;
  return denominator === 0 ? null : counts.truePositives / denominator;
}

export function f1Of(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Scores one category.
 *
 * `produced` is the count the extractor emitted in this category, which for a
 * closed category is `truePositives + falsePositives` and for an open one is
 * only reported, never divided by.
 */
export function scoreOf(counts: Counts, options: { closed: boolean; produced: number }): Score {
  const precision = options.closed ? precisionOf(counts) : null;
  const recall = recallOf(counts);

  return {
    ...counts,
    precision,
    recall,
    f1: f1Of(precision, recall),
    closed: options.closed,
    expected: counts.truePositives + counts.falseNegatives,
    produced: options.produced,
  };
}

/**
 * Sums several categories into one score.
 *
 * Micro-averaged — the counts are added and the ratio taken once — rather than
 * averaging the per-category ratios, because a category with three entries
 * should not weigh as much as one with three hundred.
 *
 * Only closed categories contribute to the aggregate precision. Including an
 * open category's true positives without its unenumerated ones would inflate
 * it, which is the exact failure this module exists to avoid.
 */
export function aggregate(scores: readonly Score[]): Score {
  const total: Counts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
  const closedOnly: Counts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };

  let produced = 0;
  let anyClosed = false;

  for (const score of scores) {
    total.truePositives += score.truePositives;
    total.falsePositives += score.falsePositives;
    total.falseNegatives += score.falseNegatives;
    produced += score.produced;

    if (!score.closed) continue;
    anyClosed = true;
    closedOnly.truePositives += score.truePositives;
    closedOnly.falsePositives += score.falsePositives;
    closedOnly.falseNegatives += score.falseNegatives;
  }

  const precision = anyClosed ? precisionOf(closedOnly) : null;
  const recall = recallOf(total);

  return {
    ...total,
    precision,
    recall,
    f1: f1Of(precision, recall),
    closed: anyClosed,
    expected: total.truePositives + total.falseNegatives,
    produced,
  };
}

/** `98.1%`, or `n/a` for a ratio that was not measurable. */
export function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}
