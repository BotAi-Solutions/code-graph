import type { AnalysisPhase, AnalysisProgress } from '@ckg/shared';
import type { Logger } from '@ckg/shared/logger';

/**
 * Publishes where the pipeline has got to, without letting that get in the way
 * of the pipeline.
 *
 * Three properties, and each of them is the reason for a decision here:
 *
 * - **It never blocks.** `report()` returns immediately; the write happens
 *   behind it. Parsing a thousand files must not wait on a thousand `UPDATE`s.
 * - **It never fails a run.** A progress write that errors is logged at debug
 *   and dropped. Losing a progress bar is a nuisance; losing a graph because
 *   the progress bar could not be written would be absurd.
 * - **It is coalescing, not sampling.** Between writes only the latest report
 *   is kept, and a phase change always writes. So the UI sees every phase
 *   transition and a steady trickle within a phase, rather than every one of
 *   several thousand file-level ticks.
 *
 * The transport is the job row, polled by the UI, because that is the
 * mechanism this application already has: the dashboard was already polling
 * jobs before there was anything finer than a status to poll for. Moving to
 * server-sent events later means replacing this class and nothing else — the
 * pipeline knows only that it reports progress somewhere.
 */

export interface ProgressSink {
  setProgress(jobId: string, progress: AnalysisProgress): Promise<unknown>;
}

export interface AnalysisProgressReporterOptions {
  jobId: string;
  sink: ProgressSink;
  logger: Logger;
  /** Shortest gap between two writes within one phase. */
  minIntervalMs?: number;
  /** Injectable so a test need not wait in real time. */
  now?: () => number;
}

const DEFAULT_MIN_INTERVAL_MS = 400;

export class AnalysisProgressReporter {
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  private lastWriteAt = 0;
  private lastPhase: AnalysisPhase | null = null;
  private pending: AnalysisProgress | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  /** Counters that persist across reports, so each one need not restate them. */
  private carried: Pick<AnalysisProgress, 'files' | 'symbols' | 'relationships' | 'errors'> = {};

  constructor(private readonly options: AnalysisProgressReporterOptions) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Records counters that stay true for the rest of the run, so that a report
   * about parsing still carries the file count the scan established.
   */
  carry(counters: Partial<typeof this.carried>): void {
    this.carried = { ...this.carried, ...counters };
  }

  /** Reports a position. Written now on a phase change, coalesced otherwise. */
  report(progress: AnalysisProgress): void {
    const merged: AnalysisProgress = { ...this.carried, ...progress };
    const phaseChanged = merged.phase !== this.lastPhase;

    if (!phaseChanged) {
      if (this.now() - this.lastWriteAt < this.minIntervalMs) {
        this.pending = merged;
        return;
      }
      this.write(merged);
      return;
    }

    // A phase is ending. Write where it finished before moving on — otherwise
    // a phase that completed between two coalescing windows would be recorded
    // as having stopped wherever it happened to be at the last write, and a
    // fast run would never show a phase reaching its end at all.
    if (this.pending) this.write(this.pending);
    this.write(merged);
  }

  /** Writes whatever is outstanding. Awaited at the end of a phase or a run. */
  async flush(): Promise<void> {
    if (this.pending) this.write(this.pending);
    await this.inFlight;
  }

  private write(progress: AnalysisProgress): void {
    this.pending = null;
    this.lastPhase = progress.phase;
    this.lastWriteAt = this.now();

    // Chained rather than concurrent: two writes racing could leave the older
    // position as the one that lands.
    this.inFlight = this.inFlight
      .then(() => this.options.sink.setProgress(this.options.jobId, progress))
      .then(
        () => undefined,
        (error: unknown) => {
          this.options.logger.debug({ err: error }, 'progress update could not be written');
        },
      );
  }
}
