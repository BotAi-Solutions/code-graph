import {
  ANALYSIS_PHASE_BY_STATUS,
  ANALYSIS_PHASE_LABELS,
  analysisProgressFraction,
  type AnalysisPhase,
  type AnalysisProgress,
  type AnalysisStatus,
} from '../../../types/index.js';
import { formatCount } from '../../../utils/format.js';

/**
 * What the indexer is doing, while it does it.
 *
 * Two rules, and both of them are about not lying:
 *
 * - **A phase that cannot count its work says so.** Scanning does not know how
 *   many files it will find; an external indexer is one opaque subprocess. Both
 *   report `total: 0`, and both are drawn here as an indeterminate bar rather
 *   than a percentage invented to fill the space.
 * - **Every number is one the pipeline measured.** Files, symbols and
 *   relationships are counts of things that exist, not projections of things
 *   that might. A counter with nothing behind it yet is simply absent.
 *
 * The overall percentage is a weighted sum over phases, with the current phase
 * scaled by its own real position. It is approximate — a percentage always is —
 * but it is approximate in proportion to the work, which "one sixth per status
 * change" was not.
 */

/** The phases a run passes through, in the order the checklist shows them. */
const CHECKLIST: AnalysisPhase[] = [
  'scanning',
  'indexing',
  'parsing',
  'resolving',
  'building_graph',
  'persisting',
];

/**
 * The two fields a run's progress is drawn from — not the whole job.
 *
 * The dashboard listing carries exactly this much about each running project,
 * and asking for a whole `AnalysisJob` would have meant manufacturing the
 * fields the listing does not ship. A component should ask for what it reads.
 */
export interface IndexingProgressProps {
  status: AnalysisStatus;
  progress: AnalysisProgress | null;
  /** Compact form for a dashboard card; full form for the project page. */
  compact?: boolean;
}

export function IndexingProgress({
  status,
  progress: reported,
  compact = false,
}: IndexingProgressProps): React.JSX.Element {
  // A job the worker has not yet reported on still has a status, which is
  // coarse but true. Better that than an empty panel.
  const progress: AnalysisProgress = reported ?? {
    phase: ANALYSIS_PHASE_BY_STATUS[status],
    current: 0,
    total: 0,
    message: `${ANALYSIS_PHASE_LABELS[ANALYSIS_PHASE_BY_STATUS[status]]}…`,
  };

  const fraction = analysisProgressFraction(progress);
  const percent = Math.round(fraction * 100);
  const indeterminate = progress.total === 0 && progress.phase !== 'completed';
  const currentIndex = CHECKLIST.indexOf(progress.phase);

  return (
    <section className={`indexing${compact ? ' indexing--compact' : ''}`}>
      <div className="indexing__headline">
        <span className="indexing__title">
          {progress.phase === 'completed' ? 'Indexed' : 'Indexing project'}
        </span>
        <span className="indexing__percent">{percent}%</span>
      </div>

      <div
        className={`progress${indeterminate ? ' progress--indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // An indeterminate bar reports no value, which is what tells a screen
        // reader it is busy rather than 0% done.
        {...(indeterminate ? {} : { 'aria-valuenow': percent })}
        aria-label={progress.message}
      >
        <span className="progress__fill" style={{ width: `${String(percent)}%` }} />
      </div>

      <p className="indexing__message">{progress.message}</p>

      {!compact && (
        <>
          <dl className="indexing__counters">
            <Counter
              label="Files"
              value={
                progress.total > 0 && isFileCounted(progress.phase)
                  ? `${formatCount(progress.current)} / ${formatCount(progress.total)}`
                  : progress.files !== undefined
                    ? formatCount(progress.files)
                    : null
              }
            />
            <Counter
              label="Symbols"
              value={progress.symbols !== undefined ? formatCount(progress.symbols) : null}
            />
            <Counter
              label="Relationships"
              value={
                progress.relationships !== undefined
                  ? formatCount(progress.relationships)
                  : null
              }
            />
          </dl>

          <ol className="indexing__steps">
            {CHECKLIST.map((phase, index) => (
              <li
                key={phase}
                className={`indexing__step indexing__step--${stepState(index, currentIndex, progress.phase)}`}
              >
                <span className="indexing__step-mark" aria-hidden="true" />
                {ANALYSIS_PHASE_LABELS[phase]}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function Counter({ label, value }: { label: string; value: string | null }): React.JSX.Element {
  return (
    <div className="indexing__counter">
      <dt>{label}</dt>
      {/* `—` rather than 0: nothing has been counted yet is not the same fact
          as nothing was found. */}
      <dd>{value ?? '—'}</dd>
    </div>
  );
}

/** Phases whose current/total is a file count rather than something else. */
function isFileCounted(phase: AnalysisPhase): boolean {
  return phase === 'parsing';
}

function stepState(
  index: number,
  currentIndex: number,
  phase: AnalysisPhase,
): 'done' | 'active' | 'pending' {
  if (phase === 'completed') return 'done';
  if (currentIndex < 0) return 'pending';
  if (index < currentIndex) return 'done';
  if (index === currentIndex) return 'active';
  return 'pending';
}
