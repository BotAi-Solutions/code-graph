import { useMemo, useState } from 'react';
import type { CodeGraphModel, GraphNode } from '../model/graph-types.js';
import type { PathResult } from '../utils/graph-traversal.js';
import { nodeTypeLabel } from '../model/node-types.js';
import { nodeColor } from '../utils/graph-colors.js';

/**
 * "Is there a route from here to there, and what is on it?"
 *
 * The search is breadth-first over the graph on screen, so the answer is the
 * shortest route *through what you are looking at*. Direction is tried first,
 * because "how does a request get from the controller to the repository" is a
 * question about flow; when no directed route exists the search is repeated
 * ignoring direction and the result says so, which is more useful than "no
 * path" — two components can be related without one reaching the other.
 *
 * Both endpoints are picked from the displayed graph rather than from the
 * project, because a path to a node that is not drawn could not be shown.
 */

export interface GraphPathFinderProps {
  model: CodeGraphModel;
  from: string | null;
  to: string | null;
  path: PathResult | null;
  selectedNodeId: string | null;
  onChangeFrom: (nodeId: string | null) => void;
  onChangeTo: (nodeId: string | null) => void;
  onSelectNode: (nodeId: string) => void;
  onClear: () => void;
}

export function GraphPathFinder({
  model,
  from,
  to,
  path,
  selectedNodeId,
  onChangeFrom,
  onChangeTo,
  onSelectNode,
  onClear,
}: GraphPathFinderProps): React.JSX.Element {
  const found = path && path.nodeIds.length > 0;

  return (
    <div className="pathfinder">
      <div className="pathfinder__row">
        <NodePicker
          label="From"
          model={model}
          value={from}
          selectedNodeId={selectedNodeId}
          onChange={onChangeFrom}
        />
        <NodePicker
          label="To"
          model={model}
          value={to}
          selectedNodeId={selectedNodeId}
          onChange={onChangeTo}
        />
        <button
          type="button"
          className="button"
          disabled={!from && !to}
          onClick={onClear}
        >
          Clear
        </button>
      </div>

      {from && to && !found && (
        <p className="pathfinder__empty">
          No route between these two in the current view. Try a mode with more relationships, or
          expand a node between them.
        </p>
      )}

      {found && path && (
        <>
          {path.undirected && (
            <p className="pathfinder__note">
              No directed route exists; this is the shortest one ignoring direction.
            </p>
          )}
          <ol className="pathfinder__steps">
            {path.nodeIds.map((id, index) => {
              const node = model.nodesById.get(id);
              if (!node) return null;

              return (
                <li key={id}>
                  <button
                    type="button"
                    className="pathfinder__step"
                    onClick={() => {
                      onSelectNode(id);
                    }}
                  >
                    <span className="swatch" style={{ background: nodeColor(node.type) }} />
                    <span className="pathfinder__step-name">{node.label}</span>
                    <span className="pathfinder__step-type">{nodeTypeLabel(node.type)}</span>
                  </button>
                  {index < path.nodeIds.length - 1 && (
                    <span className="pathfinder__arrow" aria-hidden="true">
                      ↓
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

/**
 * A typeahead over the nodes on screen.
 *
 * Deliberately not the project-wide search: choosing a node the canvas does not
 * hold would produce a path that could not be drawn.
 */
function NodePicker({
  label,
  model,
  value,
  selectedNodeId,
  onChange,
}: {
  label: string;
  model: CodeGraphModel;
  value: string | null;
  selectedNodeId: string | null;
  onChange: (nodeId: string | null) => void;
}): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);

  const chosen = value ? model.nodesById.get(value) : undefined;

  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (needle.length === 0) {
      // With no term, offer the nodes most worth connecting.
      return [...model.nodes]
        .sort((a, b) => b.metrics.importance - a.metrics.importance)
        .slice(0, PICKER_LIMIT);
    }

    const hits: GraphNode[] = [];
    for (const node of model.nodes) {
      if (
        node.fullLabel.toLowerCase().includes(needle) ||
        (node.file?.toLowerCase().includes(needle) ?? false)
      ) {
        hits.push(node);
        if (hits.length >= PICKER_LIMIT * 3) break;
      }
    }

    return hits
      .sort((a, b) => b.metrics.importance - a.metrics.importance)
      .slice(0, PICKER_LIMIT);
  }, [model, term]);

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
      ) : (
        <div className="picker__field">
          <input
            className="picker__input"
            type="text"
            value={term}
            placeholder="node on canvas…"
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
                    title={node.fullLabel}
                    onClick={() => {
                      onChange(node.id);
                      setOpen(false);
                      setTerm('');
                    }}
                  >
                    <span className="swatch" style={{ background: nodeColor(node.type) }} />
                    <span className="picker__result-name">{node.label}</span>
                    <span className="picker__result-type">{nodeTypeLabel(node.type)}</span>
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
