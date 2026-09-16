import { useEffect, useMemo, useState } from 'react';
import { searchNodes } from '../../../api/graph.api.js';
import { shortenPath } from '../../../utils/format.js';
import type { CodeNode, GraphPath } from '../../../types/index.js';
import type { CodeGraphModel } from '../model/graph-types.js';
import { nodeFullName, nodeTypeLabel } from '../model/node-types.js';
import { pathRows, pathSummary } from '../model/navigation.js';
import { relationshipColor } from '../model/edge-types.js';
import { nodeColor } from '../utils/graph-colors.js';

/**
 * "Is there a route from here to there, and what is on it?"
 *
 * The search runs on the server, over the whole repository, and that is the
 * point: a route from a controller to a table runs through a service and a
 * repository that the current projection very likely is not drawing, and a
 * search restricted to the canvas would answer "no route" about a route that
 * plainly exists.
 *
 * So both endpoints are picked from the *project* — the same search the top bar
 * uses — and the found route is merged onto the canvas by the workspace, which
 * is why choosing two nodes you cannot currently see still draws you a path.
 *
 * Direction is tried first, because "how does a request get from the controller
 * to the repository" is a question about flow. When no directed route exists
 * the server repeats the search ignoring direction and says so, which is more
 * useful than "no path": two components can be related without one reaching
 * the other.
 */

export interface GraphPathFinderProps {
  projectId: string;
  model: CodeGraphModel;
  from: string | null;
  to: string | null;
  path: GraphPath | null;
  loading: boolean;
  error: string | null;
  selectedNodeId: string | null;
  onChangeFrom: (nodeId: string | null) => void;
  onChangeTo: (nodeId: string | null) => void;
  onSelectNode: (nodeId: string) => void;
  onOpenSource: (nodeId: string) => void;
  onClear: () => void;
}

export function GraphPathFinder({
  projectId,
  model,
  from,
  to,
  path,
  loading,
  error,
  selectedNodeId,
  onChangeFrom,
  onChangeTo,
  onSelectNode,
  onOpenSource,
  onClear,
}: GraphPathFinderProps): React.JSX.Element {
  const found = path?.found === true;

  return (
    <div className="pathfinder">
      <div className="pathfinder__row">
        <NodePicker
          label="From"
          projectId={projectId}
          model={model}
          value={from}
          selectedNodeId={selectedNodeId}
          onChange={onChangeFrom}
        />
        <NodePicker
          label="To"
          projectId={projectId}
          model={model}
          value={to}
          selectedNodeId={selectedNodeId}
          onChange={onChangeTo}
        />
        <button type="button" className="button" disabled={!from && !to} onClick={onClear}>
          Clear
        </button>
      </div>

      {error && <p className="pathfinder__empty">{error}</p>}

      {loading && <p className="pathfinder__note">Searching the graph…</p>}

      {from && to && !loading && !error && path && !found && (
        <p className="pathfinder__empty">
          {path.truncated
            ? 'The search reached its limit before finding a route. Try two nodes closer together.'
            : 'No route between these two, in either direction, within the search depth.'}
        </p>
      )}

      {found && path && (
        <>
          {path.undirected && (
            <p className="pathfinder__note">
              No directed route exists; this is the shortest one ignoring direction.
            </p>
          )}

          <p className="pathfinder__summary">{pathSummary(path)}</p>

          <ol className="pathfinder__steps">
            {pathRows(path).map(({ node, step }) => {
              return (
                <li key={node.id}>
                  <div className="pathfinder__step-row">
                    <button
                      type="button"
                      className="pathfinder__step"
                      title={nodeFullName(node)}
                      onClick={() => {
                        onSelectNode(node.id);
                      }}
                    >
                      <span className="swatch" style={{ background: nodeColor(node.type) }} />
                      <span className="pathfinder__step-name">{nodeFullName(node)}</span>
                      <span className="pathfinder__step-type">{nodeTypeLabel(node.type)}</span>
                    </button>

                    {node.filePath && (
                      <button
                        type="button"
                        className="pathfinder__step-source"
                        title={`Open ${node.filePath}`}
                        onClick={() => {
                          onOpenSource(node.id);
                        }}
                      >
                        source
                      </button>
                    )}
                  </div>

                  {step && (
                    <span className="pathfinder__arrow">
                      <span aria-hidden="true">↓</span>
                      <span
                        className="pathfinder__relationship"
                        style={{ color: relationshipColor(step.relationship) }}
                      >
                        {step.relationship}
                      </span>
                      {step.reversed && (
                        <span className="pathfinder__reversed" title="Crossed against its direction">
                          reversed
                        </span>
                      )}
                      {step.evidenceSource && (
                        <span className="pathfinder__evidence" title="How this relationship was found">
                          {step.evidenceSource}
                          {step.confidence && step.confidence !== 'high'
                            ? ` · ${step.confidence}`
                            : ''}
                        </span>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

const PICKER_LIMIT = 12;
const DEBOUNCE_MS = 180;

/**
 * A typeahead over the whole project.
 *
 * With no term it offers the nodes on screen, ranked by importance, because
 * "connect these two things I am looking at" is the common case. Typing hands
 * the question to the server, so a node that is not drawn is still reachable.
 */
function NodePicker({
  label,
  projectId,
  model,
  value,
  selectedNodeId,
  onChange,
}: {
  label: string;
  projectId: string;
  model: CodeGraphModel;
  value: string | null;
  selectedNodeId: string | null;
  onChange: (nodeId: string | null) => void;
}): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CodeNode[]>([]);

  const chosen = value ? model.nodesById.get(value) : undefined;

  const onCanvas = useMemo(
    () =>
      [...model.nodes]
        .sort((a, b) => b.metrics.importance - a.metrics.importance)
        .slice(0, PICKER_LIMIT)
        .map((node) => node.source),
    [model],
  );

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length === 0) {
      setResults([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchNodes(projectId, trimmed, { limit: PICKER_LIMIT }, controller.signal)
        .then((page) => {
          if (!controller.signal.aborted) setResults(page.nodes);
        })
        .catch(() => {
          // A failed lookup leaves the last results in place; the picker is a
          // convenience and an error toast here would be noise.
        });
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, term]);

  const matches = term.trim().length === 0 ? onCanvas : results;

  return (
    <div className="picker">
      <span className="picker__label">{label}</span>

      {chosen ? (
        <button
          type="button"
          className="picker__chosen"
          title={chosen.fullLabel}
          onClick={() => {
            onChange(null);
            setTerm('');
          }}
        >
          <span className="swatch" style={{ background: nodeColor(chosen.type) }} />
          {chosen.label}
          <span className="picker__clear" aria-hidden="true">
            ×
          </span>
        </button>
      ) : value ? (
        // Chosen, but not on the canvas: the server found it and the workspace
        // has not merged it yet, or a filter is hiding it.
        <button
          type="button"
          className="picker__chosen"
          title="Chosen from search"
          onClick={() => {
            onChange(null);
            setTerm('');
          }}
        >
          <span className="picker__chosen-offscreen">selected</span>
          <span className="picker__clear" aria-hidden="true">
            ×
          </span>
        </button>
      ) : (
        <div className="picker__field">
          <input
            className="picker__input"
            type="text"
            value={term}
            placeholder="search the project…"
            aria-label={`${label} node`}
            onChange={(event) => {
              setTerm(event.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
            }}
            onBlur={() => {
              // Let a click on a result land before the list closes.
              window.setTimeout(() => {
                setOpen(false);
              }, 140);
            }}
          />

          {selectedNodeId && (
            <button
              type="button"
              className="picker__use"
              title="Use the selected node"
              onClick={() => {
                onChange(selectedNodeId);
              }}
            >
              use selection
            </button>
          )}

          {open && matches.length > 0 && (
            <ul className="picker__results" role="listbox">
              {matches.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    className="picker__result"
                    title={nodeFullName(node)}
                    onClick={() => {
                      onChange(node.id);
                      setOpen(false);
                      setTerm('');
                    }}
                  >
                    <span className="swatch" style={{ background: nodeColor(node.type) }} />
                    <span className="picker__result-name">{nodeFullName(node)}</span>
                    <span className="picker__result-type">
                      {node.filePath ? shortenPath(node.filePath, 22) : nodeTypeLabel(node.type)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
