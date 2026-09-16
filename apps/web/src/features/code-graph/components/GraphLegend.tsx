import { useState } from 'react';
import type { CodeNodeType } from '../../../types/index.js';
import {
  FAMILIES_BY_CATEGORY,
  NODE_CATEGORIES,
  NODE_CATEGORY_LABELS,
  NODE_FAMILY_LABELS,
  NODE_TYPE_LABELS,
} from '../../../types/index.js';
import { TYPES_BY_FAMILY, nodeStyle, type NodeShape } from '../model/node-types.js';
import {
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_LABELS,
  edgeStyle,
  relationshipGroupColor,
} from '../model/edge-types.js';
import { familyColor, nodeColor } from '../utils/graph-colors.js';

/**
 * The key to a composite encoding: hue names the family, silhouette names the
 * member, size and glow name importance, and the label names the thing itself.
 *
 * For the architectural types silhouette is the *primary* channel rather than a
 * secondary one, which is why they are shown in their own category instead of
 * mixed into one flat list of colours.
 *
 * Collapsed by default so it never competes with the graph.
 */
export function GraphLegend(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className={`legend${open ? ' legend--open' : ''}`}>
      <button
        type="button"
        className="legend__toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className="legend__swatches" aria-hidden="true">
          {NODE_CATEGORIES.flatMap((category) => FAMILIES_BY_CATEGORY[category]).map((family) => (
            <span key={family} className="swatch" style={{ background: familyColor(family) }} />
          ))}
        </span>
        Legend
      </button>

      {open && (
        <div className="legend__body">
          {NODE_CATEGORIES.map((category) => (
            <div key={category} className="legend__category">
              <span className="legend__category-title">{NODE_CATEGORY_LABELS[category]}</span>

              {FAMILIES_BY_CATEGORY[category].map((family) => (
                <div key={family} className="legend__group">
                  <span className="legend__group-title">
                    <span className="swatch" style={{ background: familyColor(family) }} />
                    {NODE_FAMILY_LABELS[family]}
                  </span>
                  <div className="legend__items">
                    {TYPES_BY_FAMILY[family].map((type) => (
                      <span key={type} className="legend__item" title={NODE_TYPE_LABELS[type]}>
                        <NodeGlyph type={type} />
                        {type}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}

          <div className="legend__category">
            <span className="legend__category-title">Relationships</span>

            {RELATIONSHIP_GROUPS.map((group) => (
              <div key={group} className="legend__group">
                <span className="legend__group-title">
                  <span className="legend__line" style={{ color: relationshipGroupColor(group) }} />
                  {RELATIONSHIP_GROUP_LABELS[group]}
                </span>
                <div className="legend__items">
                  {RELATIONSHIPS_BY_GROUP[group].map((relationship) => {
                    const style = edgeStyle(relationship);

                    return (
                      <span key={relationship} className="legend__item">
                        <span
                          className={`legend__line legend__line--${style.emphasis}`}
                          style={{ color: relationshipGroupColor(group) }}
                        />
                        {relationship}
                        {style.flow && (
                          <span className="legend__note" title="Animated flow on the canvas">
                            ·
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <p className="legend__footnote">
            Size and glow track importance — degree, centrality, entry-point and exported status.
            Zooming out drops low-level symbols to specks and hides their labels; zooming in brings
            them back. Every edge records what observed it, shown when you select it.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * A miniature of the silhouette the shader draws.
 *
 * Hand-written clip paths rather than a shared source with the GLSL: the two
 * are different enough — signed distance fields against polygon points — that a
 * shared definition would be a fiction. The test suite checks that every node
 * type has a glyph here.
 */
const CLIP_PATHS: Record<NodeShape, string | null> = {
  circle: null,
  square: null,
  diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
  hexagon: 'polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0% 50%)',
  triangle: 'polygon(50% 2%, 100% 92%, 0% 92%)',
  pentagon: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)',
  ring: null,
  squareRing: null,
  capsule: null,
  rhomboid: null,
  star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
  cross: 'polygon(38% 0%, 62% 0%, 62% 38%, 100% 38%, 100% 62%, 62% 62%, 62% 100%, 38% 100%, 38% 62%, 0% 62%, 0% 38%, 38% 38%)',
};

export function NodeGlyph({ type }: { type: CodeNodeType }): React.JSX.Element {
  const shape = nodeStyle(type).shape;
  const color = nodeColor(type);
  const style: React.CSSProperties = { background: color };

  const clip = CLIP_PATHS[shape];
  if (clip) style.clipPath = clip;

  switch (shape) {
    case 'circle':
      style.borderRadius = '50%';
      break;
    case 'square':
      style.borderRadius = '2px';
      break;
    case 'ring':
      style.background = 'transparent';
      style.border = `2px solid ${color}`;
      style.borderRadius = '50%';
      break;
    case 'squareRing':
      style.background = 'transparent';
      style.border = `2px solid ${color}`;
      style.borderRadius = '1px';
      break;
    case 'capsule':
      style.borderRadius = '40% / 26%';
      break;
    case 'rhomboid':
      style.transform = 'skewX(-18deg) scale(0.92)';
      style.borderRadius = '1px';
      break;
    default:
      break;
  }

  return <span className="glyph" style={style} aria-hidden="true" />;
}
