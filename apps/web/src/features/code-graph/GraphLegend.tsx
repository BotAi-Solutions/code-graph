import { useState } from 'react';
import type { CodeNodeType } from '../../types/index.js';
import {
  DASHED_RELATIONSHIPS,
  FAMILIES_BY_CATEGORY,
  LABELLED_RELATIONSHIPS,
  NODE_CATEGORIES,
  NODE_CATEGORY_LABELS,
  NODE_FAMILY_LABELS,
  NODE_SHAPES,
  NODE_TYPE_LABELS,
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_LABELS,
  TYPES_BY_FAMILY,
  familyColor,
  nodeColor,
  relationshipGroupColor,
} from './graph-style.js';

/**
 * The key to the composite encoding: hue names the family, shape names the
 * member, and for the architectural types shape is the primary channel rather
 * than a secondary one — which is why they are shown in their own category
 * instead of mixed into one flat list of colours.
 *
 * Collapsed by default so it never competes with the graph itself.
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
                  <span
                    className="legend__line"
                    style={{ color: relationshipGroupColor(group) }}
                  />
                  {RELATIONSHIP_GROUP_LABELS[group]}
                </span>
                <div className="legend__items">
                  {RELATIONSHIPS_BY_GROUP[group].map((relationship) => (
                    <span key={relationship} className="legend__item">
                      <span
                        className={`legend__line${
                          DASHED_RELATIONSHIPS.has(relationship) ? ' legend__line--dashed' : ''
                        }`}
                        style={{ color: relationshipGroupColor(group) }}
                      />
                      {relationship}
                      {LABELLED_RELATIONSHIPS.has(relationship) && (
                        <span className="legend__note" title="Labelled on the canvas">
                          ·
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p className="legend__footnote">
            Dotted edges are derived summaries or medium-confidence findings; every edge records
            what observed it, shown when you select it.
          </p>
        </div>
      )}
    </div>
  );
}

/** A miniature of the shape Cytoscape draws for this node type. */
function NodeGlyph({ type }: { type: CodeNodeType }): React.JSX.Element {
  const shape = NODE_SHAPES[type];
  const style: React.CSSProperties = { background: nodeColor(type) };

  switch (shape) {
    case 'round-rectangle':
    case 'rectangle':
      style.borderRadius = shape === 'rectangle' ? '1px' : '3px';
      break;
    case 'round-diamond':
      style.borderRadius = '2px';
      style.transform = 'rotate(45deg) scale(0.78)';
      break;
    case 'round-hexagon':
      style.clipPath = 'polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0% 50%)';
      break;
    case 'round-heptagon':
      style.clipPath = 'polygon(50% 0%, 90% 20%, 100% 60%, 75% 100%, 25% 100%, 0% 60%, 10% 20%)';
      break;
    case 'round-octagon':
      style.clipPath =
        'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)';
      break;
    case 'round-tag':
      style.clipPath = 'polygon(0% 0%, 70% 0%, 100% 50%, 70% 100%, 0% 100%)';
      break;
    case 'cut-rectangle':
      style.clipPath =
        'polygon(20% 0%, 80% 0%, 100% 20%, 100% 80%, 80% 100%, 20% 100%, 0% 80%, 0% 20%)';
      break;
    case 'barrel':
      style.borderRadius = '40% / 18%';
      break;
    case 'right-rhomboid':
      style.transform = 'skewX(-18deg) scale(0.9)';
      style.borderRadius = '1px';
      break;
    case 'star':
      style.clipPath =
        'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)';
      break;
    case 'vee':
      style.clipPath = 'polygon(0% 0%, 50% 70%, 100% 0%, 100% 30%, 50% 100%, 0% 30%)';
      break;
    default:
      style.borderRadius = '50%';
  }

  return <span className="glyph" style={style} aria-hidden="true" />;
}
