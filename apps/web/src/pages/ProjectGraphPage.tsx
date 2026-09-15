import { useCallback, useState } from 'react';
import { Panel, Spinner, StatusBadge } from '../components/index.js';
import { CodeGraphPage } from '../features/code-graph/index.js';
import { fetchGraphSummary } from '../api/graph.api.js';
import { getProject } from '../api/projects.api.js';
import { useAnalysis, useAsync, navigate } from '../hooks/index.js';
import { formatCount } from '../utils/format.js';

/**
 * One project's graph workspace. The dashboard owns discovery; this page owns
 * exploration, and it is reachable by URL so a view can be shared.
 */
export function ProjectGraphPage({ projectId }: { projectId: string }): React.JSX.Element {
  const [refreshToken, setRefreshToken] = useState(0);

  const projectState = useAsync((signal) => getProject(projectId, signal), [projectId]);
  const summaryState = useAsync(
    (signal) => fetchGraphSummary(projectId, signal),
    [projectId, refreshToken],
  );

  const onCompleted = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  const analysis = useAnalysis(projectId, onCompleted);

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
          {analysis.job && <StatusBadge status={analysis.job.status} />}
          {summaryState.loading && <Spinner label="Refreshing graph" />}
          <button
            type="button"
            className="button"
            disabled={analysis.running || analysis.starting}
            onClick={() => {
              void analysis.start();
            }}
          >
            {analysis.running || analysis.starting ? 'Analysing…' : 'Re-analyse'}
          </button>
        </div>
      </header>

      {analysis.error && (
        <Panel tone="error">
          <p>{analysis.error}</p>
        </Panel>
      )}

      {analysis.job?.status === 'FAILED' && analysis.job.error && (
        <Panel tone="error" title="Analysis failed">
          <p>{analysis.job.error}</p>
        </Panel>
      )}

      {!hasGraph && !summaryState.loading ? (
        <Panel title="No graph yet">
          <p>
            This project has no analysed graph. Run an analysis to index the repository with SCIP
            and build the code knowledge graph.
          </p>
        </Panel>
      ) : (
        <CodeGraphPage projectId={projectId} refreshToken={refreshToken} />
      )}
    </div>
  );
}
