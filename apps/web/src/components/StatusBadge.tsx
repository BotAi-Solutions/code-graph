import type { AnalysisStatus } from '../types/index.js';

/**
 * Analysis state. Status colours are reserved for state and never reused as a
 * series colour, and each badge carries its label, so state is never conveyed
 * by colour alone.
 */
const TONE: Record<AnalysisStatus, string> = {
  QUEUED: 'badge--pending',
  INDEXING: 'badge--running',
  PARSING: 'badge--running',
  BUILDING_GRAPH: 'badge--running',
  PERSISTING: 'badge--running',
  COMPLETED: 'badge--ok',
  FAILED: 'badge--error',
};

const RUNNING: ReadonlySet<AnalysisStatus> = new Set([
  'QUEUED',
  'INDEXING',
  'PARSING',
  'BUILDING_GRAPH',
  'PERSISTING',
]);

const LABEL: Record<AnalysisStatus, string> = {
  QUEUED: 'Queued',
  INDEXING: 'Indexing',
  PARSING: 'Parsing',
  BUILDING_GRAPH: 'Building graph',
  PERSISTING: 'Persisting',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export function StatusBadge({ status }: { status: AnalysisStatus }): React.JSX.Element {
  return (
    <span className={`badge ${TONE[status]}`}>
      {RUNNING.has(status) && <span className="badge__pulse" aria-hidden="true" />}
      {LABEL[status]}
    </span>
  );
}

/** Progress through the pipeline, 0–1, for the thin bar on a running card. */
const ORDER: AnalysisStatus[] = [
  'QUEUED',
  'INDEXING',
  'PARSING',
  'BUILDING_GRAPH',
  'PERSISTING',
  'COMPLETED',
];

export function analysisProgress(status: AnalysisStatus): number {
  if (status === 'FAILED') return 1;
  const index = ORDER.indexOf(status);
  return index < 0 ? 0 : (index + 1) / ORDER.length;
}
