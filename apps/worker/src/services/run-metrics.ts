import type { AnalysisPhaseTiming, AnalysisResources, AnalysisTimings } from '@ckg/shared';

/**
 * Times the phases of one analysis run, and samples what the worker used.
 *
 * Every phase is timed around exactly one call, with the monotonic clock
 * (`performance.now()`), so phases never overlap and `unattributedMs` is
 * simply what lies between them. A phase that never ran is absent from the
 * result rather than zero: a missing measurement and a fast one must not look
 * alike.
 *
 * Resident memory is sampled at each phase boundary, which costs one syscall
 * per phase. The peak it reports is therefore a lower bound on the true peak.
 * The SCIP indexer runs in its own process and is invisible to all of this.
 */
export class RunMetrics {
  private readonly startedAt: number;
  private readonly cpuAtStart: NodeJS.CpuUsage;
  private readonly phases: Partial<Record<AnalysisPhaseTiming, number>> = {};
  private peakRss = 0;
  private rssSamples = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.startedAt = this.clock();
    this.cpuAtStart = process.cpuUsage();
    this.sample();
  }

  /** Runs `work` as `phase`. Recorded even when it throws, then rethrown. */
  async time<T>(phase: AnalysisPhaseTiming, work: () => Promise<T> | T): Promise<T> {
    const started = this.clock();
    try {
      return await work();
    } finally {
      this.phases[phase] = (this.phases[phase] ?? 0) + (this.clock() - started);
      this.sample();
    }
  }

  /** The timings so far, ending now. */
  timings(extra: {
    analyzers: AnalysisTimings['analyzers'];
    scipIndexerReportedMs?: number | undefined;
  }): AnalysisTimings {
    const totalMs = this.clock() - this.startedAt;
    const phases: AnalysisTimings['phases'] = {};
    let attributed = 0;
    for (const [phase, duration] of Object.entries(this.phases) as Array<[AnalysisPhaseTiming, number]>) {
      phases[phase] = round(duration);
      attributed += duration;
    }

    return {
      totalMs: round(totalMs),
      phases,
      analyzers: extra.analyzers.map((entry) => ({ ...entry, durationMs: round(entry.durationMs) })),
      ...(extra.scipIndexerReportedMs !== undefined
        ? { scipIndexerReportedMs: round(Math.max(0, extra.scipIndexerReportedMs)) }
        : {}),
      // Never negative: the phases are disjoint sub-intervals of the total.
      // Rounding is the only way it could dip below zero, so clamp that away.
      unattributedMs: round(Math.max(0, totalMs - attributed)),
    };
  }

  /**
   * What the worker process used since the run started, and the indexer's own
   * measurement when there is one. Kept separate, never summed.
   */
  resources(indexer?: AnalysisResources['indexer']): AnalysisResources {
    this.sample();
    const cpu = process.cpuUsage(this.cpuAtStart);
    return {
      workerCpuUserMs: round(cpu.user / 1000),
      workerCpuSystemMs: round(cpu.system / 1000),
      workerSampledPeakRssBytes: this.peakRss,
      rssSamples: this.rssSamples,
      // Kilobytes on every platform Node supports.
      workerLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      indexerMeasured: indexer !== undefined,
      ...(indexer ? { indexer: { ...indexer } } : {}),
    };
  }

  private sample(): void {
    this.peakRss = Math.max(this.peakRss, process.memoryUsage.rss());
    this.rssSamples += 1;
  }
}

function round(milliseconds: number): number {
  return Math.round(milliseconds * 100) / 100;
}
