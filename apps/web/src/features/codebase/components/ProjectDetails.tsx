import type { AnalysisJob, Repository } from '../../../types/index.js';
import { formatDuration, formatRelativeTime } from '../../../utils/format.js';
import { LANGUAGE_LABELS } from '../model/languages.js';

/**
 * What this project is, as opposed to what is in it.
 *
 * Where the source lives, which language was indexed, when it last ran and how
 * long that took. Facts about the *run*, kept apart from the statistics, which
 * are facts about the code — they answer different questions and someone
 * scanning for one should not have to read past the other.
 *
 * Every field is omitted when it is not known, rather than shown as a dash.
 * This panel is short enough that an absent row reads as "not applicable"; the
 * statistics panel, where the fields are a fixed set people compare across
 * projects, holds its shape instead.
 */

export interface ProjectDetailsProps {
  repository: Repository | null;
  analysis: AnalysisJob | null;
}

export function ProjectDetails({
  repository,
  analysis,
}: ProjectDetailsProps): React.JSX.Element | null {
  const rows: Array<[string, React.ReactNode]> = [];

  if (repository) {
    rows.push([
      'Source',
      <span className="project-details__path" title={repository.sourcePath}>
        {repository.sourcePath}
      </span>,
    ]);
    if (repository.sourceType !== 'local') rows.push(['Type', repository.sourceType]);
    if (repository.commitHash) {
      rows.push(['Commit', <code>{repository.commitHash.slice(0, 12)}</code>]);
    }
  }

  if (analysis?.language) rows.push(['Language', LANGUAGE_LABELS[analysis.language]]);
  if (analysis?.completedAt) rows.push(['Indexed', formatRelativeTime(analysis.completedAt)]);
  if (analysis?.stats) rows.push(['Took', formatDuration(analysis.stats.durationMs)]);

  if (rows.length === 0) return null;

  return (
    <dl className="project-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
