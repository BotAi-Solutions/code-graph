import {
  NODE_FAMILIES,
  NODE_FAMILY_BY_TYPE,
  NODE_FAMILY_LABELS,
  type CodeNodeType,
  type NodeFamily,
  type NodeTypeCounts,
} from '../types/index.js';
import { familyColor } from '../features/code-graph/index.js';
import { formatCount } from '../utils/format.js';

export interface CompositionBarProps {
  counts: NodeTypeCounts;
  /** Hides the labelled legend when several bars share one legend. */
  showLegend?: boolean;
}

/**
 * Part-to-whole: what kind of code this project is made of.
 *
 * A horizontal stacked bar, four segments, in the fixed order the palette was
 * validated in (types → callables → data → structure). Segments are separated
 * by a 2px surface gap and every one is direct-labelled with its count, so
 * identity never rests on colour alone.
 */
export function CompositionBar({
  counts,
  showLegend = true,
}: CompositionBarProps): React.JSX.Element | null {
  const byFamily = new Map<NodeFamily, number>(NODE_FAMILIES.map((family) => [family, 0]));

  for (const [type, count] of Object.entries(counts)) {
    const family = NODE_FAMILY_BY_TYPE[type as CodeNodeType];
    if (!family) continue;
    byFamily.set(family, (byFamily.get(family) ?? 0) + (count ?? 0));
  }

  const total = [...byFamily.values()].reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;

  const segments = NODE_FAMILIES.map((family) => ({
    family,
    label: NODE_FAMILY_LABELS[family],
    count: byFamily.get(family) ?? 0,
    color: familyColor(family),
  })).filter((segment) => segment.count > 0);

  return (
    <div className="composition">
      <div
        className="composition__bar"
        role="img"
        aria-label={segments
          .map((segment) => `${segment.label} ${String(segment.count)}`)
          .join(', ')}
      >
        {segments.map((segment) => (
          <span
            key={segment.family}
            className="composition__segment"
            style={{
              width: `${String((segment.count / total) * 100)}%`,
              background: segment.color,
            }}
            title={`${segment.label}: ${formatCount(segment.count)}`}
          />
        ))}
      </div>

      {showLegend && (
        <ul className="composition__legend">
          {segments.map((segment) => (
            <li key={segment.family} className="composition__key">
              <span className="swatch" style={{ background: segment.color }} />
              <span className="composition__key-label">{segment.label}</span>
              <span className="composition__key-count">{formatCount(segment.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
