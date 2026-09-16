import { useCallback, useEffect, useState } from 'react';
import { Panel, SidebarSection, Spinner, StatusBadge } from '../components/index.js';
import { GraphWorkspace } from '../features/code-graph/index.js';
import { IndexingProgress, ProjectDetails, ProjectStats } from '../features/codebase/index.js';
import { fetchGraphSummary } from '../api/graph.api.js';
import { getProject, getRepository, listAnalyses } from '../api/projects.api.js';
import { useAnalysis, useAsync, navigate } from '../hooks/index.js';
import { formatCount } from '../utils/format.js';

/**
 * One project's graph workspace.
 *
 * The graph is the page, not a section of it. Everything that is not the canvas
 * is either one slim row above it or a band in the sidebar beside it: the
 * statistics used to be a full-width panel stacked on top, which cost the
 * canvas a third of its height to show six numbers nobody was reading while
 * they explored.
 *
 * The exceptions are deliberate and both transient — a run in progress, and a
 * run that failed. Those are the two moments when the graph is not the thing
 * you need, so they are allowed to take the room.
 */
export function ProjectGraphPage({ projectId }: { projectId: string }): React.JSX.Element {
  const [refreshToken, setRefreshToken] = useState(0);

  const projectState = useAsync((signal) => getProject(projectId, signal), [projectId]);
  const summaryState = useAsync(
    (signal) => fetchGraphSummary(projectId, signal),
    [projectId, refreshToken],
  );

  /**
   * The repository behind this project, for the inspector's "Open source".
   * A project without one is normal — it simply has no graph yet — so a failure
   * here is not surfaced as an error.
   */
  const repositoryState = useAsync((signal) => getRepository(projectId, signal), [projectId]);

  const onCompleted = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  const analysis = useAnalysis(projectId, onCompleted);

  /**
   * The most recent run, whether or not this page started it.
   *
   * Arriving from "Index project" — or reloading mid-run — means there is a job
   * in flight that this page's own polling knows nothing about, because it only
   * follows runs it launched. Adopting the latest one is what makes the
   * progress panel appear on arrival rather than after the next click.
   */
  const latestState = useAsync(
    (signal) => listAnalyses(projectId, signal),
    [projectId, refreshToken],
  );
  const latest = latestState.data?.[0] ?? null;
  const adopt = analysis.setJob;

  useEffect(() => {
    if (!latest) return;
    if (latest.status === 'COMPLETED' || latest.status === 'FAILED') return;
    adopt((current) => (current ? current : latest));
  }, [latest, adopt]);

  if (projectState.error) {
    return (
      <Panel tone="error" title="Project not found">
        <p>{projectState.error}</p>
        <button
          type="button"
          className="button"
          onClick={() => {
            navigate({ name: 'dashboard' });
          }}
        >
          Back to dashboard
        </button>
      </Panel>
    );
  }

  const summary = summaryState.data;
  const hasGraph = (summary?.nodeCount ?? 0) > 0;
  // The run this page is following, or the newest one if it is following none.
  const job = analysis.job ?? latest;
  const running = job !== null && job.status !== 'COMPLETED' && job.status !== 'FAILED';

  /**
   * The project half of the sidebar.
   *
   * Composed here rather than inside the workspace: what a project *is* belongs
   * to the codebase feature, and the graph feature should not learn about
   * analysis runs in order to draw a panel.
   */
  const projectPanel = (
    <>
      {job?.status === 'COMPLETED' && job.stats && (
        <SidebarSection
          title="Statistics"
          storageKey="stats"
          defaultOpen
          meta={
            job.errors.length > 0
              ? `${formatCount(job.errors.length)} warning${job.errors.length === 1 ? '' : 's'}`
              : undefined
          }
        >
          <ProjectStats stats={job.stats} errors={job.errors} />
        </SidebarSection>
      )}

      <SidebarSection title="Details" storageKey="details">
        <ProjectDetails repository={repositoryState.data} analysis={job} />
      </SidebarSection>
    </>
  );

  return (
    <div className="project-page">
      <header className="project-header">
        <nav className="breadcrumb">
          <a
            href="#/"
            onClick={(event) => {
              event.preventDefault();
              navigate({ name: 'dashboard' });
            }}
          >
            Projects
          </a>
          <span aria-hidden="true">/</span>
          <span className="breadcrumb__current">{projectState.data?.name ?? '…'}</span>
        </nav>

        <div className="project-header__meta">
          {summary && (
            <span className="project-header__counts">
              {formatCount(summary.nodeCount)} nodes · {formatCount(summary.edgeCount)} edges
            </span>
          )}
          {job && <StatusBadge status={job.status} />}
          {summaryState.loading && <Spinner label="Refreshing graph" />}
          <button
            type="button"
            className="button"
            disabled={running || analysis.starting}
            onClick={() => {
              void analysis.start();
            }}
          >
            {running || analysis.starting ? 'Analysing…' : 'Re-analyse'}
          </button>
        </div>
      </header>

      {analysis.error && (
        <Panel tone="error">
          <p>{analysis.error}</p>
        </Panel>
      )}

      {job?.status === 'FAILED' && job.error && (
        <Panel tone="error" title="Analysis failed">
          <p>{job.error}</p>
        </Panel>
      )}

      {running && job && (
        <Panel>
          <IndexingProgress status={job.status} progress={job.progress} />
        </Panel>
      )}

      {!hasGraph && !summaryState.loading && !running ? (
        <Panel title="No graph yet">
          <p>
            This project has no analysed graph. Run an analysis to index the repository with SCIP
            and build the code knowledge graph.
          </p>
        </Panel>
      ) : hasGraph ? (
        <GraphWorkspace
          /* Keyed by project: the workspace holds a root node, a mode and a
             filter set that belong to *this* project, and moving to another one
             without remounting would ask the new project about the old one's
             nodes. */
          key={projectId}
          projectId={projectId}
          refreshToken={refreshToken}
          summary={summaryState.data}
          repositoryPath={repositoryState.data?.sourcePath ?? null}
          commitHash={repositoryState.data?.commitHash ?? null}
          projectPanel={projectPanel}
        />
      ) : null}
    </div>
  );
}
