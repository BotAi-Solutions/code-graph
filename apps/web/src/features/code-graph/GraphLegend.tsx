import { useState } from 'react';
import {
  NODE_FAMILIES,
  NODE_FAMILY_LABELS,
  CODE_RELATIONSHIPS,
  type CodeNodeType,
} from '../../types/index.js';
import {
  NODE_SHAPES,
  TYPES_BY_FAMILY,
  familyColor,
  nodeColor,
  relationshipColor,
  STRUCTURAL_RELATIONSHIPS,
} from './graph-style.js';

/**
 * The key to the composite encoding: hue names the family, shape names the
 * member. Collapsed by default so it never competes with the graph itself.
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
          {NODE_FAMILIES.map((family) => (
            <span key={family} className="swatch" style={{ background: familyColor(family) }} />
          ))}
        </span>
        Legend
      </button>

      {open && (
        <div className="legend__body">
          {NODE_FAMILIES.map((family) => (
            <div key={family} className="legend__group">
              <span className="legend__group-title">
                <span className="swatch" style={{ background: familyColor(family) }} />
                {NODE_FAMILY_LABELS[family]}
              </span>
              <div className="legend__items">
                {TYPES_BY_FAMILY[family].map((type) => (
                  <span key={type} className="legend__item">
                    <NodeGlyph type={type} />
                    {type}
                  </span>
                ))}
              </div>
            </div>
          ))}

          <div className="legend__group">
            <span className="legend__group-title">Relationships</span>
            <div className="legend__items">
              {CODE_RELATIONSHIPS.map((relationship) => (
                <span key={relationship} className="legend__item">
                  <span
                    className={`legend__line${
                      STRUCTURAL_RELATIONSHIPS.has(relationship) ? ' legend__line--dashed' : ''
                    }`}
                    style={{ color: relationshipColor(relationship) }}
                  />
                  {relationship}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A miniature of the shape Cytoscape draws for this node type. */
function NodeGlyph({ type }: { type: CodeNodeType }): React.JSX.Element {
  const shape = NODE_SHAPES[type];
  const style: React.CSSProperties = { background: nodeColor(type) };

  if (shape === 'round-rectangle') style.borderRadius = '3px';
  else if (shape === 'round-diamond') {
    style.borderRadius = '2px';
    style.transform = 'rotate(45deg) scale(0.78)';
  } else if (shape === 'round-hexagon') {
    style.clipPath = 'polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0% 50%)';
  } else style.borderRadius = '50%';

  return <span className="glyph" style={style} aria-hidden="true" />;
}
