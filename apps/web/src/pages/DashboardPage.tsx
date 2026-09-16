import { useCallback, useMemo, useState } from 'react';
import {
  CompositionBar,
  Panel,
  Spinner,
  StatTile,
  StatusBadge,
} from '../components/index.js';
import { IndexingProgress, ProjectSelector, useProjectIntake } from '../features/codebase/index.js';
import {
  attachRepository,
  createProject,
  deleteProject,
  listProjects,
  startAnalysis,
} from '../api/projects.api.js';
import { errorMessage, navigate, useAsync, useInterval } from '../hooks/index.js';
import { formatCount, formatRelativeTime, shortenPath } from '../utils/format.js';
import type { ProjectSummary } from '../types/index.js';

const DEFAULT_REPOSITORY_PATH = 'test-repositories/typescript-sample';
const POLL_INTERVAL_MS = 1500;

/**
 * The dashboard: choose a codebase, and see every one already indexed.
 *
 * The listing arrives from one `GET /api/projects` call — the summaries are
 * assembled server side precisely so this page does not fan out one request per
 * card — and it carries each running job's progress with it, so a card can show
 * real indexing progress without a second request either.
 */
export function DashboardPage(): React.JSX.Element {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

  const projectsState = useAsync((signal) => listProjects(signal), []);
  const projects = useMemo(() => projectsState.data ?? [], [projectsState.data]);

  const anyRunning = projects.some(
    (project) =>
      project.latestAnalysis !== null &&
      project.latestAnalysis.status !== 'COMPLETED' &&
      project.latestAnalysis.status !== 'FAILED',
  );

  // While something is indexing the listing is live; otherwise it sits still.
  useInterval(projectsState.reload, anyRunning ? POLL_INTERVAL_MS : null);

  // Queuing a run takes you to that project, which is where its progress and
  // then its graph appear. The dashboard's job was to get you here.
  const intake = useProjectIntake(
    useCallback(({ projectId }) => {
      navigate({ name: 'project', projectId });
    }, []),
  );

  const totals = useMemo(
    () =>
      projects.reduce(
        (accumulator, project) => ({
          nodes: accumulator.nodes + project.nodeCount,
          edges: accumulator.edges + project.edgeCount,
          analysed: accumulator.analysed + (project.nodeCount > 0 ? 1 : 0),
        }),
        { nodes: 0, edges: 0, analysed: 0 },
      ),
    [projects],
  );

  const runAnalysis = useCallback(
    async (projectId: string) => {
      setBusyProjectId(projectId);
      setActionError(null);
      try {
        await startAnalysis(projectId);
        projectsState.reload();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusyProjectId(null);
      }
    },
    [projectsState],
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      setBusyProjectId(projectId);
      setActionError(null);
      try {
        await deleteProject(projectId);
        projectsState.reload();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusyProjectId(null);
      }
    },
    [projectsState],
  );

  const createFromPath = useCallback(
    async (name: string, sourcePath: string) => {
      setBusyProjectId('new');
      setActionError(null);
      try {
        const project = await createProject({ name });
        await attachRepository(project.id, { sourceType: 'local', sourcePath });
        await startAnalysis(project.id);
        projectsState.reload();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusyProjectId(null);
      }
    },
    [projectsState],
  );

  if (projectsState.loading && projects.length === 0) {
    return (
      <div className="dashboard">
        <Panel>
          <Spinner label="Loading projects" /> Loading projects…
        </Panel>
      </div>
    );
  }

  if (projectsState.error) {
    return (
      <div className="dashboard">
        <Panel tone="error" title="The API is not reachable">
          <p>{projectsState.error}</p>
          <p className="panel__hint">
            Start it with <code>pnpm dev</code>, and check that <code>PORT</code> in{' '}
            <code>.env</code> matches what the web server proxies to.
          </p>
          <button type="button" className="button" onClick={projectsState.reload}>
            Retry
          </button>
        </Panel>
      </div>
    );
  }

  const advancedForm = (
    <details className="disclosure disclosure--inline">
      <summary>Index a path or a git URL instead</summary>
      <ManualProjectForm busy={busyProjectId === 'new'} onCreate={createFromPath} />
    </details>
  );

  return (
    <div className="dashboard">
      {actionError && (
        <Panel tone="error">
          <p>{actionError}</p>
        </Panel>
      )}

      <ProjectSelector intake={intake} footer={advancedForm} />

      {projects.length > 0 && (
        <>
          <section className="kpis" aria-label="Totals across all projects">
            <StatTile label="Projects" value={projects.length} hero />
            <StatTile
              label="Analysed"
              value={totals.analysed}
              hint={
                projects.length > totals.analysed
                  ? `${String(projects.length - totals.analysed)} not yet indexed`
                  : undefined
              }
            />
            <StatTile label="Nodes indexed" value={totals.nodes} />
            <StatTile label="Relationships" value={totals.edges} />
          </section>

          <div className="section-heading">
            <h2>Indexed projects</h2>
            <span className="section-heading__count">{formatCount(projects.length)}</span>
            {projectsState.loading && <Spinner label="Refreshing" />}
          </div>

          <ul className="project-grid">
            {projects.map((project) => (
              <li key={project.id}>
                <ProjectCard
                  project={project}
                  busy={busyProjectId === project.id}
                  onRun={() => void runAnalysis(project.id)}
                  onDelete={() => void removeProject(project.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  busy,
  onRun,
  onDelete,
}: {
  project: ProjectSummary;
  busy: boolean;
  onRun: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);

  const analysis = project.latestAnalysis;
  const running =
    analysis !== null && analysis.status !== 'COMPLETED' && analysis.status !== 'FAILED';
  const analysed = project.nodeCount > 0;

  return (
    <article className={`card${running ? ' card--running' : ''}`}>
      <header className="card__header">
        <div className="card__identity">
          <h3 className="card__title">
            {analysed ? (
              <a
                href={`#/projects/${project.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate({ name: 'project', projectId: project.id });
                }}
              >
                {project.name}
              </a>
            ) : (
              project.name
            )}
          </h3>
          {project.repository && (
            <p className="card__path" title={project.repository.sourcePath}>
              <span className="card__source">{project.repository.sourceType}</span>
              {shortenPath(project.repository.sourcePath, 44)}
            </p>
          )}
        </div>
        {analysis && <StatusBadge status={analysis.status} />}
      </header>

      {/* The card shows the run's own report, the same one the project page
          shows, rather than a bar that advances one step per status change. */}
      {running && analysis && (
        <IndexingProgress status={analysis.status} progress={analysis.progress} compact />
      )}

      {analysis?.status === 'FAILED' && analysis.error && (
        <p className="card__error" title={analysis.error}>
          {analysis.error}
        </p>
      )}

      <dl className="card__stats">
        <div>
          <dt>Nodes</dt>
          <dd>{formatCount(project.nodeCount)}</dd>
        </div>
        <div>
          <dt>Edges</dt>
          <dd>{formatCount(project.edgeCount)}</dd>
        </div>
        <div>
          <dt>Language</dt>
          <dd>{analysis?.language ?? '—'}</dd>
        </div>
        <div>
          <dt>Analysed</dt>
          <dd>{formatRelativeTime(analysis?.completedAt ?? null)}</dd>
        </div>
      </dl>

      {analysed && <CompositionBar counts={project.nodeTypeCounts} />}

      {/* Confirmation replaces the footer rather than opening a dialog: the
          card is already the thing being deleted, so it is the right place to
          ask, and it says what will go. Deleting is irreversible, so it is
          never one click. */}
      {confirming ? (
        <footer className="card__footer card__footer--confirm">
          <p className="card__confirm">
            {analysed
              ? `Delete this project and its ${formatCount(project.nodeCount)}-node graph?`
              : 'Delete this project?'}
            {running && ' The analysis in progress will be discarded.'} The source on disk is
            not touched.
          </p>
          <div className="card__confirm-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={busy}
              onClick={onDelete}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </footer>
      ) : (
        <footer className="card__footer">
          {/* The primary action is whichever one is actually available: on a
              project that has never been indexed that is Analyse, not a dead
              Explore button wearing the accent colour. */}
          {analysed && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                navigate({ name: 'project', projectId: project.id });
              }}
            >
              Explore graph
            </button>
          )}
          <button
            type="button"
            className={`button${analysed ? '' : ' button--primary'}`}
            disabled={busy || running}
            onClick={onRun}
          >
            {busy ? 'Starting…' : running ? 'Running…' : analysed ? 'Re-analyse' : 'Analyse'}
          </button>
          <button
            type="button"
            className="button button--quiet card__delete"
            title="Delete this project and its graph"
            aria-label={`Delete ${project.name}`}
            disabled={busy}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Delete
          </button>
        </footer>
      )}
    </article>
  );
}

/**
 * The escape hatch: a path relative to the workspace root, or a git URL.
 *
 * Kept because the folder dialog cannot express either — the bundled samples
 * are relative paths, and a repository that is not on this machine yet has no
 * folder to choose. It is behind a disclosure because it is the exception now,
 * not the way in.
 */
function ManualProjectForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (name: string, sourcePath: string) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState('typescript-sample');
  const [sourcePath, setSourcePath] = useState(DEFAULT_REPOSITORY_PATH);

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate(name.trim(), sourcePath.trim());
      }}
    >
      <label className="field">
        <span className="field__label">Project name</span>
        <input
          className="field__control"
          value={name}
          required
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>

      <label className="field field--wide">
        <span className="field__label">Repository path or git URL</span>
        <input
          className="field__control"
          value={sourcePath}
          required
          placeholder={DEFAULT_REPOSITORY_PATH}
          onChange={(event) => {
            setSourcePath(event.target.value);
          }}
        />
      </label>

      <button type="submit" className="button button--primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create and analyse'}
      </button>

      <p className="form__hint">
        A relative path resolves against the repository root, so{' '}
        <code>{DEFAULT_REPOSITORY_PATH}</code> works as-is.
      </p>
    </form>
  );
}
