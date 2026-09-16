import { GRAPH_MODES, type GraphModeId } from '../model/graph-modes.js';

/**
 * Five questions, one graph.
 *
 * Switching mode changes the *query*, not just what is hidden: the server
 * returns a different slice and ranks it differently. That is why this is a
 * segmented control at the top of the workspace rather than another filter —
 * it is the first decision, and the filters narrow whatever it returns.
 */

export interface GraphModesProps {
  active: GraphModeId | null;
  /** True when the filters no longer match what the mode prescribes. */
  edited: boolean;
  onChange: (mode: GraphModeId) => void;
}

export function GraphModes({ active, edited, onChange }: GraphModesProps): React.JSX.Element {
  return (
    <div className="modes" role="group" aria-label="Graph mode">
      {GRAPH_MODES.map((mode) => {
        const selected = active === mode.id;

        return (
          <button
            key={mode.id}
            type="button"
            className={`modes__option${selected ? ' modes__option--active' : ''}`}
            title={mode.title}
            aria-pressed={selected}
            onClick={() => {
              onChange(mode.id);
            }}
          >
            {mode.label}
            {selected && edited && (
              <span className="modes__mark" title="Filters edited away from this mode" />
            )}
          </button>
        );
      })}
    </div>
  );
}
