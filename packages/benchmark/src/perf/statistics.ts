/**
 * Summaries of repeated measurements.
 *
 * Deliberately modest. With five warm runs there is a minimum, a maximum and
 * a median worth reading; a 95th percentile of five numbers is the largest of
 * them under another name, so it is not reported until there are enough
 * observations for the tail to be a tail.
 */

/** Observations needed before a p95 is reported at all. */
export const MIN_SAMPLES_FOR_P95 = 20;

export interface Summary {
  count: number;
  min: number | null;
  median: number | null;
  max: number | null;
  /** Null below `MIN_SAMPLES_FOR_P95` observations; `p95Note` says why. */
  p95: number | null;
  p95Note?: string;
}

/**
 * Min, median, max and (with enough samples) the nearest-rank 95th
 * percentile. Null and non-finite values are left out and not counted: a
 * missing measurement is not an observation of zero.
 */
export function summarize(values: ReadonlyArray<number | null | undefined>): Summary {
  const observed = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);

  if (observed.length === 0) {
    return { count: 0, min: null, median: null, max: null, p95: null, p95Note: 'no observations' };
  }

  const middle = Math.floor(observed.length / 2);
  const median =
    observed.length % 2 === 1
      ? (observed[middle] as number)
      : ((observed[middle - 1] as number) + (observed[middle] as number)) / 2;

  const summary: Summary = {
    count: observed.length,
    min: observed[0] as number,
    median,
    max: observed[observed.length - 1] as number,
    p95: null,
  };

  if (observed.length < MIN_SAMPLES_FOR_P95) {
    summary.p95Note = `not reported below ${String(MIN_SAMPLES_FOR_P95)} observations (have ${String(observed.length)})`;
  } else {
    summary.p95 = nearestRank(observed, 0.95);
  }
  return summary;
}

/** The nearest-rank percentile of an ascending list: the smallest value with at least p of the data at or below it. */
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('no values');
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] as number;
}
