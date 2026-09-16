import { CODE_NODE_TYPES, CODE_RELATIONSHIPS } from '../../types/index.js';
import type {
  CodeNodeType,
  CodeRelationship,
  NodeTypeCounts,
  RelationshipCounts,
} from '../../types/index.js';
import {
  FAMILIES_BY_CATEGORY,
  NODE_CATEGORIES,
  NODE_CATEGORY_LABELS,
  NODE_FAMILY_LABELS,
  NODE_TYPE_LABELS,
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_LABELS,
  TYPES_BY_FAMILY,
  nodeColor,
  relationshipColor,
} from './graph-style.js';

export interface GraphFiltersProps {
  nodeTypes: CodeNodeType[];
  relationships: CodeRelationship[];
  /** What the project actually contains, so empty filters can be marked. */
  nodeTypeCounts?: NodeTypeCounts | undefined;
  relationshipCounts?: RelationshipCounts | undefined;
  onChangeNodeTypes: (next: CodeNodeType[]) => void;
  onChangeRelationships: (next: CodeRelationship[]) => void;
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/**
 * Filters are applied by the API during traversal, not in the browser: the
 * point is to fetch less, not to hide what was already fetched.
 *
 * Twenty-one node types and twenty-one relationships are too many for a flat
 * row of chips, so both are grouped the way the vocabulary itself is — code
 * families and architectural ones, relationships by what they describe — and
 * each group can be taken or dropped as a whole. A type the project has none of
 * is dimmed rather than hidden: knowing the graph contains no queues is
 * information, and a filter list that changes shape per project is harder to
 * learn.
 */
export function GraphFilters({
  nodeTypes,
  relationships,
  nodeTypeCounts,
  relationshipCounts,
  onChangeNodeTypes,
  onChangeRelationships,
}: GraphFiltersProps): React.JSX.Element {
  const typeActive = (type: CodeNodeType): boolean =>
    nodeTypes.length === 0 || nodeTypes.includes(type);

  const relationshipActive = (relationship: CodeRelationship): boolean =>
    relationships.length === 0 || relationships.includes(relationship);

  const toggleType = (type: CodeNodeType): void => {
    // An empty selection means "everything"; the first click on a chip
    // therefore narrows to everything-but-that-one.
    const base = nodeTypes.length === 0 ? [...CODE_NODE_TYPES] : nodeTypes;
    onChangeNodeTypes(toggle(base, type));
  };

  const toggleRelationship = (relationship: CodeRelationship): void => {
    const base = relationships.length === 0 ? [...CODE_RELATIONSHIPS] : relationships;
    onChangeRelationships(toggle(base, relationship));
  };

  /** Selects exactly this set of types, which is what a group heading does. */
  const onlyTypes = (group: readonly CodeNodeType[]): void => {
    const base = nodeTypes.length === 0 ? [...CODE_NODE_TYPES] : nodeTypes;
    const allOn = group.every((type) => base.includes(type));
    onChangeNodeTypes(
      allOn ? base.filter((type) => !group.includes(type)) : [...new Set([...base, ...group])],
    );
  };

  const onlyRelationships = (group: readonly CodeRelationship[]): void => {
    const base = relationships.length === 0 ? [...CODE_RELATIONSHIPS] : relationships;
    const allOn = group.every((relationship) => base.includes(relationship));
    onChangeRelationships(
      allOn
        ? base.filter((relationship) => !group.includes(relationship))
        : [...new Set([...base, ...group])],
    );
  };

  return (
    <div className="filters">
      <fieldset className="filters__group">
        <legend className="filters__legend">
          Node types
          <button
            type="button"
            className="filters__all"
            onClick={() => {
              onChangeNodeTypes(nodeTypes.length === 0 ? [] : []);
            }}
          >
            all
          </button>
        </legend>

        {NODE_CATEGORIES.map((category) => (
          <div key={category} className="filters__category">
            <span className="filters__category-title">{NODE_CATEGORY_LABELS[category]}</span>

            {FAMILIES_BY_CATEGORY[category].map((family) => (
              <div key={family} className="filters__row">
                <button
                  type="button"
                  className="filters__row-title"
                  title={`Toggle every ${NODE_FAMILY_LABELS[family].toLowerCase()} type`}
                  onClick={() => {
                    onlyTypes(TYPES_BY_FAMILY[family]);
                  }}
                >
                  {NODE_FAMILY_LABELS[family]}
                </button>

                <div className="filters__chips">
                  {TYPES_BY_FAMILY[family].map((type) => {
                    const active = typeActive(type);
                    const count = nodeTypeCounts?.[type] ?? 0;

                    return (
                      <button
                        key={type}
                        type="button"
                        className={`chip${active ? ' chip--active' : ''}${
                          nodeTypeCounts && count === 0 ? ' chip--empty' : ''
                        }`}
                        style={active ? { borderColor: nodeColor(type) } : undefined}
                        aria-pressed={active}
                        title={
                          nodeTypeCounts
                            ? `${NODE_TYPE_LABELS[type]} — ${String(count)} in this project`
                            : NODE_TYPE_LABELS[type]
                        }
                        onClick={() => {
                          toggleType(type);
                        }}
                      >
                        <span className="chip__dot" style={{ background: nodeColor(type) }} />
                        {type}
                        {nodeTypeCounts && count > 0 && (
                          <span className="chip__count">{count}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </fieldset>

      <fieldset className="filters__group">
        <legend className="filters__legend">
          Relationships
          <button
            type="button"
            className="filters__all"
            onClick={() => {
              onChangeRelationships([]);
            }}
          >
            all
          </button>
        </legend>

        {RELATIONSHIP_GROUPS.map((group) => (
          <div key={group} className="filters__row">
            <button
              type="button"
              className="filters__row-title"
              title={`Toggle every ${RELATIONSHIP_GROUP_LABELS[group].toLowerCase()} relationship`}
              onClick={() => {
                onlyRelationships(RELATIONSHIPS_BY_GROUP[group]);
              }}
            >
              {RELATIONSHIP_GROUP_LABELS[group]}
            </button>

            <div className="filters__chips">
              {RELATIONSHIPS_BY_GROUP[group].map((relationship) => {
                const active = relationshipActive(relationship);
                const count = relationshipCounts?.[relationship] ?? 0;

                return (
                  <button
                    key={relationship}
                    type="button"
                    className={`chip${active ? ' chip--active' : ''}${
                      relationshipCounts && count === 0 ? ' chip--empty' : ''
                    }`}
                    style={active ? { borderColor: relationshipColor(relationship) } : undefined}
                    aria-pressed={active}
                    title={
                      relationshipCounts
                        ? `${relationship} — ${String(count)} in this project`
                        : relationship
                    }
                    onClick={() => {
                      toggleRelationship(relationship);
                    }}
                  >
                    <span
                      className="chip__line"
                      style={{ background: relationshipColor(relationship) }}
                    />
                    {relationship}
                    {relationshipCounts && count > 0 && (
                      <span className="chip__count">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
