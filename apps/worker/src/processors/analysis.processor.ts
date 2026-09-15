import type { AnalysisJob } from '@ckg/shared';
import type { Logger } from '@ckg/shared/logger';
import type { AnalysisJobRepository } from '@ckg/database';
import type { AnalysisJobQueue } from '../services/job-queue.js';
import type { AnalyzeRepositoryJob } from '../jobs/analyze-repository.job.js';

/**
 * Polls the queue and runs one job at a time per loop.
 *
 * Deliberately boring: the interesting work lives in `AnalyzeRepositoryJob`,
 * and the claiming strategy lives behind `AnalysisJobQueue`. Swapping the poll
 * loop for BullMQ event handling touches only this file.
 */

export interface AnalysisProcessorOptions {
  queue: AnalysisJobQueue;
  job: AnalyzeRepositoryJob;
  analysisJobs: AnalysisJobRepository;
  logger: Logger;
  pollIntervalMs: number;
}

export class AnalysisProcessor {
  private running = false;
  private stopped = false;
  private sleepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AnalysisProcessorOptions) {}

  /** Processes at most one job. Returns true when a job was handled. */
  async tick(): Promise<boolean> {
    const job = await this.options.queue.claim();
    if (!job) return false;

    await this.process(job);
    return true;
  }

  private async process(job: AnalysisJob): Promise<void> {
    const log = this.options.logger.child({ jobId: job.id, projectId: job.projectId });
    log.info('analysis job claimed');

    try {
      await this.options.job.run(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // The failure is recorded on the job so the API can report it; the
      // stack goes to stderr for the operator, never to the client.
      log.error({ err: error }, `analysis job failed: ${message}`);

      await this.options.analysisJobs.update(job.id, {
        status: 'FAILED',
        completedAt: new Date(),
        error: message,
      });
    }
  }

  /** Runs until `stop()` is called. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    this.options.logger.info(
      { pollIntervalMs: this.options.pollIntervalMs },
      'analysis processor started',
    );

    while (!this.stopped) {
      let handled = false;
      try {
        handled = await this.tick();
      } catch (error) {
        // Claiming failed (for example the database is briefly unavailable).
        // Back off and keep the worker alive.
        this.options.logger.error({ err: error }, 'failed to claim an analysis job');
      }

      if (!handled && !this.stopped) {
        await this.sleep(this.options.pollIntervalMs);
      }
    }

    this.running = false;
    this.options.logger.info('analysis processor stopped');
  }

  stop(): void {
    this.stopped = true;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepTimer = setTimeout(resolve, ms);
    });
  }
}
