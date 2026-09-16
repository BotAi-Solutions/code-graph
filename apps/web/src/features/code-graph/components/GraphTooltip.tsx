import type { GraphNode } from '../model/graph-types.js';
import { nodeTypeLabel } from '../model/node-types.js';
import { nodeColor } from '../utils/graph-colors.js';
import { shortenPath } from '../../../utils/format.js';

/**
 * What the cursor is over.
 *
 * Six facts and no controls. Hovering is a glance, so the tooltip answers what
 * a glance asks — what is this, where does it live, how connected is it — and
 * leaves everything else to the inspector, which is one click away and does not
 * move when the mouse does.
 */

export interface GraphTooltipProps {
  node: GraphNode;
  /** Viewport coordinates of the node, from the engine. */
  x: number;
  y: number;
}

export function GraphTooltip({ node, x, y }: GraphTooltipProps): React.JSX.Element {
  return (
    <div
      className="graph-tooltip"
      style={{ transform: `translate3d(${String(Math.round(x))}px, ${String(Math.round(y))}px, 0)` }}
      role="tooltip"
    >
      <div className="graph-tooltip__head">
        <span className="swatch" style={{ background: nodeColor(node.type) }} />
        <span className="graph-tooltip__name">{node.fullLabel}</span>
      </div>

      <dl className="graph-tooltip__facts">
        <dt>Type</dt>
        <dd>
          {nodeTypeLabel(node.type)}
          {node.role && <span className="graph-tooltip__role">{node.role}</span>}
        </dd>

        {node.file && (
          <>
            <dt>File</dt>
            <dd className="graph-tooltip__mono">{shortenPath(node.file, 34)}</dd>
          </>
        )}

        <dt>Module</dt>
        <dd>{node.moduleLabel}</dd>

        <dt>In</dt>
        <dd>{node.metrics.inDegree}</dd>

        <dt>Out</dt>
        <dd>{node.metrics.outDegree}</dd>
      </dl>

      <p className="graph-tooltip__hint">Click to inspect · double-click to expand</p>
    </div>
  );
}
