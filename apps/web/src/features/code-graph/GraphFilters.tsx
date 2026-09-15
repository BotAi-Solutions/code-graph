import { CODE_NODE_TYPES, CODE_RELATIONSHIPS } from '../../types/index.js';
import type { CodeNodeType, CodeRelationship } from '../../types/index.js';
import { nodeColor, relationshipColor } from './graph-style.js';

export interface GraphFiltersProps {
  nodeTypes: CodeNodeType[];
  relationships: CodeRelationship[];
  onChangeNodeTypes: (next: CodeNodeType[]) => void;
  onChangeRelationships: (next: CodeRelationship[]) => void;
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/**
 * Filters are applied by the API during traversal, not in the browser: the
 * point is to fetch less, not to hide what was already fetched.
 */
export function GraphFilters({
  nodeTypes,
  relationships,
  onChangeNodeTypes,
  onChangeRelationships,
}: GraphFiltersProps): React.JSX.Element {
  return (
    <div className="filters">
      <fieldset className="filters__group">
        <legend className="filters__legend">
          Node types
          <button
            type="button"
            className="filters__all"
            onClick={() => {
              onChangeNodeTypes(nodeTypes.length === 0 ? [...CODE_NODE_TYPES] : []);
            }}
          >
            {nodeTypes.length === 0 ? 'all' : 'clear'}
          </button>
        </legend>
        <div className="filters__chips">
          {CODE_NODE_TYPES.map((type) => {
            const active = nodeTypes.length === 0 || nodeTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                className={`chip${active ? ' chip--active' : ''}`}
                style={active ? { borderColor: nodeColor(type) } : undefined}
                aria-pressed={active}
                onClick={() => {
                  // An empty selection means "everything"; the first click on a
                  // chip therefore narrows to just that type.
                  const base = nodeTypes.length === 0 ? [...CODE_NODE_TYPES] : nodeTypes;
                  onChangeNodeTypes(toggle(base, type));
                }}
              >
                <span className="chip__dot" style={{ background: nodeColor(type) }} />
                {type}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="filters__group">
        <legend className="filters__legend">
          Relationships
          <button
            type="button"
            className="filters__all"
            onClick={() => {
              onChangeRelationships(relationships.length === 0 ? [...CODE_RELATIONSHIPS] : []);
            }}
          >
            {relationships.length === 0 ? 'all' : 'clear'}
          </button>
        </legend>
        <div className="filters__chips">
          {CODE_RELATIONSHIPS.map((relationship) => {
            const active = relationships.length === 0 || relationships.includes(relationship);
            return (
              <button
                key={relationship}
                type="button"
                className={`chip${active ? ' chip--active' : ''}`}
                style={active ? { borderColor: relationshipColor(relationship) } : undefined}
                aria-pressed={active}
                onClick={() => {
                  const base =
                    relationships.length === 0 ? [...CODE_RELATIONSHIPS] : relationships;
                  onChangeRelationships(toggle(base, relationship));
                }}
              >
                <span
                  className="chip__line"
                  style={{ background: relationshipColor(relationship) }}
                />
                {relationship}
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
