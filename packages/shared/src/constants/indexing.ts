import type { AnalysisStatus } from '../types/domain.js';

/**
 * The phases an indexing run moves through, and how much of the run each one
 * is worth.
 *
 * `AnalysisStatus` is the *state* of a job — what the database stores, what the
 * API returns, what decides whether a job is claimable. A phase is finer than
 * that: it also carries how far through its own work the pipeline is. The two
 * are kept in step by `ANALYSIS_PHASE_BY_STATUS` rather than by convention.
 */
export const ANALYSIS_PHASES = [
  'queued',
  'scanning',
  'indexing',
  'parsing',
  'resolving',
  'building_graph',
  'persisting',
  'completed',
  'failed',
] as const;

export type AnalysisPhase = (typeof ANALYSIS_PHASES)[number];

/**
 * Share of the whole run each phase accounts for, so a percentage means
 * something rather than being one-sixth per status transition.
 *
 * The weights are measured, not invented: on both bundled samples the SCIP
 * subprocess dominates, parsing and resolving are comparable, and persistence
 * is a single bulk insert. They are approximate — a percentage always is — but
 * they are approximate in the right proportion, which a linear step count is
 * not.
 */
const PHASE_WEIGHT: Record<AnalysisPhase, number> = {
  queued: 0,
  scanning: 4,
  indexing: 45,
  parsing: 15,
  resolving: 22,
  building_graph: 8,
  persisting: 6,
  completed: 0,
  failed: 0,
};

const PROGRESS_ORDER: AnalysisPhase[] = [
  'queued',
  'scanning',
  'indexing',
  'parsing',
  'resolving',
  'building_graph',
  'persisting',
];

const TOTAL_WEIGHT = PROGRESS_ORDER.reduce((sum, phase) => sum + PHASE_WEIGHT[phase], 0);

/** The phase a status implies when a job carries no finer progress record. */
export const ANALYSIS_PHASE_BY_STATUS: Record<AnalysisStatus, AnalysisPhase> = {
  QUEUED: 'queued',
  INDEXING: 'indexing',
  PARSING: 'parsing',
  BUILDING_GRAPH: 'building_graph',
  PERSISTING: 'persisting',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/** Human-readable phase names, shared by the checklist and the status line. */
export const ANALYSIS_PHASE_LABELS: Record<AnalysisPhase, string> = {
  queued: 'Queued',
  scanning: 'Scanning files',
  indexing: 'Indexing source',
  parsing: 'Parsing source',
  resolving: 'Resolving relationships',
  building_graph: 'Building graph',
  persisting: 'Storing graph',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * Where the run is, reported by the pipeline itself.
 *
 * `total` is 0 when the work cannot be counted in advance — a filesystem walk
 * does not know how many files it will find, and an external indexer is one
 * opaque subprocess. Callers must render that as indeterminate rather than
 * inventing a denominator: a progress bar that is lying is worse than one that
 * admits it does not know.
 */
export interface AnalysisProgress {
  phase: AnalysisPhase;
  current: number;
  /** 0 means indeterminate. */
  total: number;
  message: string;
  /** Source files seen so far. Real counts only, never projections. */
  files?: number;
  symbols?: number;
  relationships?: number;
  /** Files that could not be read or parsed so far. */
  errors?: number;
}

/**
 * Fraction of the whole run that is done, 0–1.
 *
 * Completed phases contribute their full weight; the current phase contributes
 * its weight scaled by its own `current / total`, or nothing at all when it
 * cannot count its work. So the bar advances during a long phase where there is
 * something real to advance on, and holds still where there is not.
 */
export function analysisProgressFraction(progress: AnalysisProgress): number {
  if (progress.phase === 'completed') return 1;
  if (progress.phase === 'failed') return 1;

  const index = PROGRESS_ORDER.indexOf(progress.phase);
  if (index < 0) return 0;

  let done = 0;
  for (let i = 0; i < index; i += 1) {
    const phase = PROGRESS_ORDER[i];
    if (phase) done += PHASE_WEIGHT[phase];
  }

  const within =
    progress.total > 0 ? Math.min(1, Math.max(0, progress.current / progress.total)) : 0;
  done += PHASE_WEIGHT[progress.phase] * within;

  return Math.min(1, done / TOTAL_WEIGHT);
}

/** True once the phase can no longer advance. */
export function isTerminalAnalysisPhase(phase: AnalysisPhase): boolean {
  return phase === 'completed' || phase === 'failed';
}
