import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listAnalyses, listProjects } from '../api/index.js';
import { EmptyState, Spinner } from '../components/index.js';
import { navigate } from '../hooks/useHashRoute.js';
import { useAsync } from '../hooks/useAsync.js';
import { useLocalStorage } from '../hooks/useLocalStorage.js';
import { LabPane } from '../features/retrieval/components/LabPane.js';
import { NodeInspector } from '../features/retrieval/components/NodeInspector.js';
import { RequestInspector } from '../features/retrieval/components/RequestInspector.js';
import { SourceWindowView } from '../features/retrieval/components/SourceWindowView.js';
import { TracePanel } from '../features/retrieval/components/TracePanel.js';
import {
  useRetrievalLab,
  type SearchMode,
  type Slot,
} from '../features/retrieval/hooks/useRetrievalLab.js';
import {
  codeSearchSummary,
  codeSearchWarnings,
  graphRetrievalEnabled,
  groupMatchesByFile,
  indexCaveat,
  INDEX_STATE_LABEL,
  matchKey,
  matchSegments,
  projectOptions,
  readIndexStatus,
  relationshipSections,
  sourceRangeAround,
  splitPath,
} from '../features/retrieval/model/retrieval.js';
import type { CodeNode, CodeSearchMatch } from '../types/index.js';

/**
 * The Retrieval Lab: the retrieval pipeline, made visible.
 *
 * Not a product surface. It exists so that the deterministic half of CodeRAG —
 * code search, graph search, node detail, evidence, paths, source — can be
 * driven by hand and judged before anything is built on top of it.
 *
 * That purpose decides the shape: one console row that holds every input, then
 * three panes that each scroll on their own — what was found, the code it
 * points at, and what the graph says about it. Three columns rather than two
 * because the alternative stacks source, node and path in one scrolling
 * column, where acting on a node scrolls the answer off the screen.
 *
 * Nothing is fetched until it is asked for. A search returns a small page; a
 * result loads source only when selected; a node loads only when inspected.
 * That is the same bounded-retrieval discipline an agent will follow, so the
 * page is also a demonstration of it.
 */

const LIMITS = [10, 20, 50, 100];

/** Which half of the inspector column is showing. */
type InspectorTab = 'node' | 'path';

export interface RetrievalLabPageProps {
  /** From the URL. Null means "whichever project this browser used last". */
  projectId: string | null;
}

export function RetrievalLabPage({ projectId: routed }: RetrievalLabPageProps): React.JSX.Element {
  // The URL leads; local storage is the fallback so returning to `#/retrieval`
  // lands back on the project this browser was last using rather than on a
  // chooser. A lab session is long and usually about one project.
  const [remembered, remember] = useLocalStorage('ckg.lab.project', null);
  const projectId = routed ?? remembered;

  useEffect(() => {
    if (routed !== null && routed !== remembered) remember(routed);
  }, [routed, remembered, remember]);

  const setProjectId = useCallback(
    (next: string | null) => {
      remember(next);
      navigate({ name: 'retrieval', projectId: next });
    },
    [remember],
  );
  const [mode, setMode] = useState<SearchMode>('code');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const [traceTo, setTraceTo] = useState<{ id: string; label: string } | null>(null);
  const [maxDepth, setMaxDepth] = useState(6);
  const [tab, setTab] = useState<InspectorTab>('node');

  const queryInput = useRef<HTMLInputElement | null>(null);

  const lab = useRetrievalLab();

  const projects = useAsync((signal) => listProjects(signal), []);
  const options = useMemo(() => projectOptions(projects.data ?? []), [projects.data]);

  const selected = projectId !== null && options.some((option) => option.id === projectId)
    ? projectId
    : null;

  const analyses = useAsync((signal) => listAnalyses(selected as string, signal), [selected], {
    enabled: selected !== null,
  });

  const status = analyses.data ? readIndexStatus(analyses.data) : null;
  const graphEnabled = graphRetrievalEnabled(status);

  // Graph search is only offered where a graph exists, so a project without one
  // must not leave the page stuck on a tab that cannot run.
  useEffect(() => {
    if (!graphEnabled) setMode('code');
  }, [graphEnabled]);

  /**
   * `/` focuses the query, the way every search-shaped tool behaves — but only
   * when nothing else is taking keystrokes, or it would swallow a slash typed
   * into the query itself.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
      if (active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      queryInput.current?.focus();
      queryInput.current?.select();
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const activeNodeId =
    lab.target?.kind === 'node' ? lab.target.node.id : (lab.node.data?.node.id ?? null);

  const traceFrom = useMemo(
    () =>
      lab.node.data
        ? {
            id: lab.node.data.node.id,
            label: lab.node.data.node.qualifiedName ?? lab.node.data.node.name,
          }
        : null,
    [lab.node.data],
  );

  const relationshipCount = useMemo(
    () =>
      lab.node.data
        ? relationshipSections(lab.node.data).reduce(
            (total, section) => total + section.nodes.length,
            0,
          )
        : null,
    [lab.node.data],
  );

  const searching = lab.codeResults.loading || lab.graphResults.loading;

  const search = useCallback(() => {
    if (!selected || query === '') return;
    setTab('node');
    void (mode === 'code'
      ? lab.runCodeSearch(selected, query, limit)
      : lab.runGraphSearch(selected, query, limit));
  }, [lab, limit, mode, query, selected]);

  const selectMatch = useCallback(
    (match: CodeSearchMatch) => {
      if (!selected) return;
      lab.select({ kind: 'match', match });
      void lab.loadSource(selected, match.filePath, sourceRangeAround(match.line));
    },
    [lab, selected],
  );

  const selectNode = useCallback(
    (node: CodeNode) => {
      if (!selected) return;
      setTab('node');
      lab.select({ kind: 'node', node });
      void lab.loadNode(selected, node.id);
      if (node.filePath && node.startLine !== undefined) {
        void lab.loadSource(selected, node.filePath, sourceRangeAround(node.startLine));
      }
    },
    [lab, selected],
  );

  // Following a relationship is the same move as picking a graph result, so it
  // behaves the same way: the node opens and the source follows it.
  const inspectNode = useCallback(
    (node: CodeNode) => {
      selectNode(node);
    },
    [selectNode],
  );

  const traceTarget = useCallback((node: { id: string; label: string }) => {
    setTraceTo(node);
    // The panel that just took this input is in the other tab; leaving the page
    // where it was would hide the effect of the click.
    setTab('path');
  }, []);

  if (projects.loading) {
    return (
      <div className="lab lab--centred">
        <Spinner label="Loading projects" />
      </div>
    );
  }

  if (projects.error) {
    return (
      <div className="lab lab--centred">
        <EmptyState title="Unable to load projects" body={<p>{projects.error}</p>} />
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="lab lab--centred">
        <EmptyState
          title="No projects yet"
          body={<p>Index a repository from the dashboard, then come back to test retrieval against it.</p>}
          action={
            <a className="button button--primary" href="#/">
              Go to dashboard
            </a>
          }
        />
      </div>
    );
  }

  const caveat = status ? indexCaveat(status) : null;

  return (
    <div className="lab">
      <header className="lab__bar">
        <div className="lab__identity">
          <h1 className="lab__title">Retrieval Lab</h1>
          <p className="lab__subtitle">What retrieval actually returns, one call at a time</p>
        </div>

        <div className="lab__project">
          <label className="field field--inline">
            <span className="field__label">Project</span>
            <select
              className="field__control lab__project-select"
              value={selected ?? ''}
              onChange={(event) => {
                setProjectId(event.target.value === '' ? null : event.target.value);
                lab.reset();
                setTraceTo(null);
                setTab('node');
              }}
            >
              <option value="">Select a project…</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                  {option.detail ? ` — ${option.detail}` : ''}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <IndexStatusChip loading={analyses.loading} error={analyses.error} status={status} />
          )}
        </div>
      </header>

      {selected === null ? (
        <div className="lab__blank">
          <EmptyState
            title="Select a project"
            body={<p>Retrieval is always scoped to one project. Choose one to begin.</p>}
          />
        </div>
      ) : (
        <>
          <form
            className="lab__console"
            onSubmit={(event) => {
              event.preventDefault();
              search();
            }}
          >
            <div className="segmented lab__modes" role="tablist" aria-label="Retrieval mode">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'code'}
                className={`segmented__option${mode === 'code' ? ' segmented__option--active' : ''}`}
                onClick={() => {
                  setMode('code');
                }}
              >
                Code
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'graph'}
                disabled={!graphEnabled}
                title={graphEnabled ? undefined : 'No stored graph for this project'}
                className={`segmented__option${mode === 'graph' ? ' segmented__option--active' : ''}`}
                onClick={() => {
                  setMode('graph');
                }}
              >
                Graph
              </button>
            </div>

            <div className="lab__query-field">
              <span className="lab__query-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                ref={queryInput}
                className="field__control lab__query"
                placeholder={
                  mode === 'code'
                    ? 'Literal text in files — case-sensitive, not a pattern'
                    : 'An indexed name — symbol, file, route or table'
                }
                value={query}
                // Bound verbatim: the backend search is literal and
                // case-sensitive, so trimming or folding here would search for
                // something other than what was typed.
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                aria-label="Search query"
              />
              {query === '' && (
                <kbd className="lab__query-key" aria-hidden="true">
                  /
                </kbd>
              )}
            </div>

            <label className="field field--inline">
              <span className="field__label">Limit</span>
              <select
                className="field__control field__control--tiny"
                value={limit}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                }}
              >
                {LIMITS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <button type="submit" className="button button--primary" disabled={query === '' || searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>

          {status && caveat && (
            <p className={`lab-note${status.usable ? '' : ' lab-note--warn'}`}>{caveat}</p>
          )}

          <div className="lab__grid">
            <LabPane
              modifier="lab-pane--results"
              title={mode === 'code' ? 'Code matches' : 'Graph nodes'}
              meta={
                mode === 'code'
                  ? lab.codeResults.data
                    ? codeSearchSummary(lab.codeResults.data.meta, lab.codeResults.data.matches.length)
                    : 'literal text in files'
                  : lab.graphResults.data
                    ? `${String(lab.graphResults.data.length)} node${lab.graphResults.data.length === 1 ? '' : 's'}`
                    : 'names the indexer recorded'
              }
            >
              {mode === 'code' ? (
                <CodeResults
                  slot={lab.codeResults}
                  activeKey={lab.target?.kind === 'match' ? matchKey(lab.target.match) : null}
                  onSelect={selectMatch}
                />
              ) : (
                <GraphResults slot={lab.graphResults} activeId={activeNodeId} onSelect={selectNode} />
              )}
            </LabPane>

            <LabPane
              modifier="lab-pane--source"
              title="Source"
              meta={
                lab.source.data ? (
                  <span className="lab-pane__path" title={lab.source.data.file}>
                    {lab.source.data.file}
                    <span className="lab-pane__range">
                      {' '}
                      {lab.source.data.startLine}–{lab.source.data.endLine} of{' '}
                      {lab.source.data.totalLines}
                      {lab.source.data.language ? ` · ${lab.source.data.language}` : ''}
                    </span>
                  </span>
                ) : null
              }
              actions={
                lab.source.data && (
                  <button
                    type="button"
                    className="button button--quiet button--small"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        (lab.source.data?.lines ?? []).map((line) => line.text).join('\n'),
                      );
                    }}
                  >
                    Copy
                  </button>
                )
              }
              flush
            >
              {lab.source.loading ? (
                <PaneBusy label="Loading source" />
              ) : lab.source.error ? (
                <PaneError title="Unable to load source" body={lab.source.error} code={lab.source.code} />
              ) : lab.source.data ? (
                <SourceWindowView
                  source={lab.source.data}
                  activeLine={
                    lab.target?.kind === 'match'
                      ? lab.target.match.line
                      : (lab.target?.node.startLine ?? null)
                  }
                />
              ) : (
                <PaneHint>Select a result to read the code around it.</PaneHint>
              )}
            </LabPane>

            <LabPane
              modifier="lab-pane--inspect"
              tabs={{
                label: 'Inspector',
                active: tab,
                onSelect: (next) => {
                  setTab(next as InspectorTab);
                },
                items: [
                  { id: 'node', label: 'Node', badge: relationshipCount },
                  { id: 'path', label: 'Path', dot: lab.trace.data !== null },
                ],
              }}
            >
              {tab === 'node' ? (
                lab.node.loading ? (
                  <PaneBusy label="Loading node" />
                ) : lab.node.error ? (
                  <PaneError title="Unable to inspect node" body={lab.node.error} code={lab.node.code} />
                ) : lab.node.data ? (
                  <NodeInspector
                    detail={lab.node.data}
                    onInspect={inspectNode}
                    onTraceTo={traceTarget}
                  />
                ) : (
                  <PaneHint>
                    {mode === 'graph'
                      ? 'Select a graph result to inspect its relationships.'
                      : 'Code matches are text, not graph nodes. Switch to Graph to inspect one.'}
                  </PaneHint>
                )
              ) : (
                <TracePanel
                  from={traceFrom}
                  to={traceTo}
                  maxDepth={maxDepth}
                  onMaxDepth={setMaxDepth}
                  onSwap={() => {
                    if (traceFrom && traceTo) {
                      setTraceTo(traceFrom);
                      void lab.loadNode(selected, traceTo.id);
                    }
                  }}
                  onTrace={() => {
                    if (traceFrom && traceTo) {
                      void lab.runTrace(selected, traceFrom.id, traceTo.id, maxDepth);
                    }
                  }}
                  loading={lab.trace.loading}
                  error={lab.trace.error}
                  code={lab.trace.code}
                  path={lab.trace.data}
                />
              )}
            </LabPane>
          </div>

          <RequestInspector calls={lab.calls} onClear={lab.clearCalls} />
        </>
      )}
    </div>
  );
}

// --- small shared pieces ---------------------------------------------------

function PaneBusy({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="lab-pane__state">
      <Spinner label={label} />
    </div>
  );
}

function PaneHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="lab-pane__state">
      <p className="lab-muted">{children}</p>
    </div>
  );
}

function PaneError({
  title,
  body,
  code,
}: {
  title: string;
  body: string;
  code: string | null;
}): React.JSX.Element {
  return (
    <div className="lab-error">
      <p className="lab-error__title">{title}</p>
      <p className="lab-error__body">{body}</p>
      {code !== null && <code className="lab-error__code">{code}</code>}
    </div>
  );
}

function IndexStatusChip({
  loading,
  error,
  status,
}: {
  loading: boolean;
  error: string | null;
  status: ReturnType<typeof readIndexStatus> | null;
}): React.JSX.Element {
  if (loading) return <span className="lab-status lab-muted">Checking index…</span>;
  if (error) return <span className="lab-status lab-status--failed">Index unknown</span>;
  if (!status) return <span className="lab-status lab-muted">—</span>;

  return (
    <span className={`lab-status lab-status--${status.state}`}>
      <span className="lab-status__dot" aria-hidden="true" />
      {INDEX_STATE_LABEL[status.state]}
      {status.nodeCount !== null && (
        <span className="lab-status__counts">
          {status.nodeCount.toLocaleString()} nodes · {(status.edgeCount ?? 0).toLocaleString()} edges
        </span>
      )}
    </span>
  );
}

function CodeResults({
  slot,
  activeKey,
  onSelect,
}: {
  slot: Slot<import('../api/code-search.api.js').CodeSearchPage>;
  activeKey: string | null;
  onSelect: (match: CodeSearchMatch) => void;
}): React.JSX.Element {
  if (slot.loading) return <PaneBusy label="Searching" />;

  if (slot.error) {
    return <PaneError title="Unable to search code" body={slot.error} code={slot.code} />;
  }

  if (!slot.data) {
    return (
      <PaneHint>
        Search the source text of this project. Matching is literal and case-sensitive.
      </PaneHint>
    );
  }

  const { matches, meta } = slot.data;
  const warnings = codeSearchWarnings(meta);

  if (matches.length === 0) {
    return (
      <div className="lab-empty">
        <p className="lab-empty__title">No code matches</p>
        <p className="lab-muted">Matching is literal and case-sensitive. Try:</p>
        <ul className="lab-empty__hints">
          <li>a class or function name, spelled exactly</li>
          <li>part of a file name</li>
          <li>a string as it appears in the source</li>
        </ul>
        {warnings.map((warning) => (
          <p key={warning.title} className="lab-note lab-note--warn">
            <strong>{warning.title}.</strong> {warning.body}
          </p>
        ))}
      </div>
    );
  }

  return (
    <>
      {warnings.map((warning) => (
        <p key={warning.title} className="lab-note lab-note--warn lab-note--inset">
          <strong>{warning.title}.</strong> {warning.body}
        </p>
      ))}

      <ul className="lab-groups">
        {groupMatchesByFile(matches).map((group) => {
          const path = splitPath(group.filePath);
          return (
            <li key={group.filePath} className="lab-group">
              <p className="lab-group__file" title={group.filePath}>
                <span className="lab-group__dir">{path.directory}</span>
                <span className="lab-group__name">{path.name}</span>
                <span className="lab-group__count">{group.matches.length}</span>
              </p>

              <ul className="lab-hits">
                {group.matches.map((match) => {
                  const key = matchKey(match);
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className={`lab-hit${key === activeKey ? ' lab-hit--active' : ''}`}
                        onClick={() => {
                          onSelect(match);
                        }}
                      >
                        <span className="lab-hit__pos">
                          {match.line}:{match.column}
                        </span>
                        <code className="lab-hit__line">
                          {match.lineText.trim() === '' ? (
                            <span className="lab-hit__blank">(blank line)</span>
                          ) : (
                            matchSegments(match).map((segment, index) =>
                              segment.hit ? (
                                <mark key={index} className="lab-hit__mark">
                                  {segment.text}
                                </mark>
                              ) : (
                                <span key={index}>{segment.text}</span>
                              ),
                            )
                          )}
                          {match.lineTruncated && (
                            <span className="lab-hit__cut"> …line truncated</span>
                          )}
                        </code>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function GraphResults({
  slot,
  activeId,
  onSelect,
}: {
  slot: Slot<CodeNode[]>;
  activeId: string | null;
  onSelect: (node: CodeNode) => void;
}): React.JSX.Element {
  if (slot.loading) return <PaneBusy label="Searching" />;

  if (slot.error) {
    return <PaneError title="Unable to search the graph" body={slot.error} code={slot.code} />;
  }

  if (!slot.data) {
    return (
      <PaneHint>Search the names the indexer recorded: symbols, files, routes, tables.</PaneHint>
    );
  }

  if (slot.data.length === 0) {
    return (
      <div className="lab-empty">
        <p className="lab-empty__title">No graph nodes found</p>
        <p className="lab-muted">
          Only indexed names are matched. A string that appears in the source but is not a symbol
          will not be here — try Code search instead.
        </p>
      </div>
    );
  }

  return (
    <ul className="lab-hits">
      {slot.data.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            className={`lab-hit${node.id === activeId ? ' lab-hit--active' : ''}`}
            onClick={() => {
              onSelect(node);
            }}
          >
            <span className="lab-hit__where">
              <span className="lab-hit__name" title={node.qualifiedName ?? node.name}>
                {node.qualifiedName ?? node.name}
              </span>
              <span className="badge-type badge-type--small">{node.type}</span>
            </span>
            {node.filePath && (
              <code className="lab-hit__line lab-hit__line--quiet">
                {node.filePath}
                {node.startLine === undefined ? '' : `:${String(node.startLine)}`}
              </code>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
