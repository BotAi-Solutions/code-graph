import { Spinner } from '../../../components/index.js';
import { formatCount } from '../../../utils/format.js';
import type { ProjectMetadata } from '../../../types/index.js';
import { LANGUAGE_LABELS, rankLanguages } from '../model/languages.js';
import type { ProjectIntake } from '../hooks/useProjectIntake.js';

/**
 * The folder you chose, and what is actually in it.
 *
 * The numbers arrive from a real walk of the directory before anything is
 * created or parsed, which is the point: picking the wrong folder should cost a
 * second and be obvious from the counts, not cost three minutes and be obvious
 * from an empty graph.
 *
 * Until the walk returns, the fields read `—`. They are never filled with a
 * guess or a spinner pretending to be a number.
 */

export function SelectedProject({ intake }: { intake: ProjectIntake }): React.JSX.Element | null {
  const { directory, metadata, status, error } = intake;
  if (!directory) return null;

  const scanning = status === 'inspecting';
  const indexable = metadata !== null && metadata.sourceFiles > 0;

  return (
    <article className="selected">
      <header className="selected__header">
        <h2 className="selected__title">Selected project</h2>
        <button
          type="button"
          className="button button--quiet"
          disabled={intake.busy}
          onClick={() => {
            void intake.choose();
          }}
        >
          Change folder
        </button>
      </header>

      <div className="selected__identity">
        <span className="selected__name">
          <span aria-hidden="true">📁</span>
          {directory.name}
        </span>
        <span className="selected__path" title={directory.path}>
          {directory.path}
        </span>
      </div>

      <dl className="selected__facts">
        <div>
          <dt>Files</dt>
          <dd>{metadata ? formatCount(metadata.totalFiles) : '—'}</dd>
        </div>
        <div>
          <dt>Source files</dt>
          <dd>{metadata ? formatCount(metadata.sourceFiles) : '—'}</dd>
        </div>
        <div>
          <dt>Directories</dt>
          <dd>{metadata ? formatCount(metadata.directories) : '—'}</dd>
        </div>
        <div className="selected__facts-wide">
          <dt>Languages</dt>
          <dd>{metadata ? <LanguageList metadata={metadata} /> : '—'}</dd>
        </div>
      </dl>

      {scanning && (
        <p className="selected__status">
          <Spinner label="Scanning the project" />
          Scanning the project…
        </p>
      )}

      {metadata?.truncated && (
        <p className="selected__warning">
          This project is very large, so the scan stopped early. The counts above are a lower
          bound; indexing will still cover what it can reach.
        </p>
      )}

      {error && <p className="selected__error">{error}</p>}

      <footer className="selected__footer">
        <button
          type="button"
          className="button button--primary"
          disabled={!indexable || intake.busy}
          onClick={() => {
            void intake.index();
          }}
        >
          {status === 'starting' ? 'Starting…' : 'Index project'}
        </button>
        {!indexable && !scanning && !error && (
          <span className="selected__hint">Nothing to index in this folder.</span>
        )}
      </footer>
    </article>
  );
}

/** Languages present, most source files first. */
function LanguageList({ metadata }: { metadata: ProjectMetadata }): React.JSX.Element {
  const entries = rankLanguages(metadata.languages);

  if (entries.length === 0) return <span className="selected__muted">none detected</span>;

  return (
    <ul className="language-list">
      {entries.map((entry) => (
        <li key={entry.language} className="language-list__item">
          <span className="language-list__name">{LANGUAGE_LABELS[entry.language]}</span>
          <span className="language-list__count">{formatCount(entry.files)}</span>
        </li>
      ))}
    </ul>
  );
}
