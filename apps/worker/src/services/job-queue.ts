import type { AnalysisJob } from '@ckg/shared';
import type { AnalysisJobRepository } from '@ckg/database';

/**
 * The queue seam.
 *
 * The MVP claims jobs straight from PostgreSQL with `FOR UPDATE SKIP LOCKED`,
 * which is already safe for several worker processes. Introducing BullMQ later
 * means writing one more implementation of this interface — the processor and
 * the job itself do not change.
 */
export interface AnalysisJobQueue {
  /** Takes the next job, marking it in progress, or returns null when idle. */
  claim(): Promise<AnalysisJob | null>;
}

export class PostgresAnalysisJobQueue implements AnalysisJobQueue {
  constructor(private readonly analysisJobs: AnalysisJobRepository) {}

  async claim(): Promise<AnalysisJob | null> {
    return this.analysisJobs.claimNextQueued();
  }
}
