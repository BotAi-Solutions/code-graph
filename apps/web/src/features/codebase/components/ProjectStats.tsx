import { formatCount } from '../../../utils/format.js';
import type { AnalysisStats, IndexingError } from '../../../types/index.js';
import { LANGUAGE_LABELS, rankLanguages } from '../model/languages.js';

/**
 * What the indexing run measured.
 *
 * Every figure here was counted by the pipeline and stored on the run: the file
 * and directory counts come from the scan, the class, function and interface
 * counts from the graph it built, the relationship count from its edges. A
 * figure the run did not record is not shown — there is no place in this
 * component where a number is derived, estimated or filled in.
 *
 * That matters more than it sounds. A statistics panel is the one screen people
 * quote from, so a single plausible-looking invented number costs more trust
 * than every honest one earns.
 */

export interface ProjectStatsProps {
  stats: AnalysisStats;
  errors: readonly IndexingError[];
}

export function ProjectStats({ stats, errors }: ProjectStatsProps): React.JSX.Element {
  const figures: Array<[string, number | undefined]> = [
    ['Files', stats.fileCount],
    ['Directories', stats.directoryCount],
    ['Classes', stats.classCount],
    ['Functions', stats.functionCount],
    ['Interfaces', stats.interfaceCount],
    ['Relationships', stats.edgeCount],
  ];

  const measured = figures.filter((entry): entry is [string, number] => entry[1] !== undefined);
  const languages = rankLanguages(stats.languages);

  return (
    <section className="project-stats">
      {/* No heading on the first group: whatever hosts this panel has already
          said what it is, and "Statistics / Project statistics" stacked one on
          top of the other is a label describing a label. Languages keeps its
          heading because it is a different measure of a different thing. */}
      <div className="project-stats__group">
        <dl className="project-stats__figures">
          {measured.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{formatCount(value)}</dd>
            </div>
          ))}
        </dl>
      </div>

      {languages.length > 0 && (
        <div className="project-stats__group">
          <h3 className="project-stats__heading">Languages</h3>
          <dl className="project-stats__figures">
            {languages.map((entry) => (
              <div key={entry.language}>
                <dt>{LANGUAGE_LABELS[entry.language]}</dt>
                <dd>{formatCount(entry.files)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {errors.length > 0 && <IndexingWarnings stats={stats} errors={errors} />}
    </section>
  );
}

/**
 * "Indexed with warnings".
 *
 * A run that could not parse two files out of a hundred and ten produced a
 * graph of a hundred and eight, which is worth having — so the run completed,
 * and the two files are named here rather than being quietly absent.
 */
function IndexingWarnings({
  stats,
  errors,
}: {
  stats: AnalysisStats;
  errors: readonly IndexingError[];
}): React.JSX.Element {
  const indexed =
    stats.sourceFileCount !== undefined ? stats.sourceFileCount - errors.length : null;

  return (
    <details className="project-stats__warnings">
      <summary>
        Indexed with warnings
        <span className="project-stats__warning-count">
          {indexed !== null && `${formatCount(indexed)} files indexed · `}
          {formatCount(errors.length)} could not be parsed
        </span>
      </summary>
      <ul className="project-stats__errors">
        {errors.map((entry) => (
          <li key={entry.file}>
            <code>{entry.file}</code>
            <span className="project-stats__error-reason">{entry.error}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
