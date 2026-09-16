import { CODE_NODE_TYPES, CODE_RELATIONSHIPS } from '../../../types/index.js';
import type {
  CodeNodeType,
  CodeRelationship,
  NodeTypeCounts,
  RelationshipCounts,
} from '../../../types/index.js';
import {
  FAMILIES_BY_CATEGORY,
  NODE_CATEGORIES,
  NODE_CATEGORY_LABELS,
  NODE_FAMILY_LABELS,
  NODE_TYPE_LABELS,
} from '../../../types/index.js';
import type { CodeGraphModel, GraphFilterState } from '../model/graph-types.js';
import { TYPES_BY_FAMILY } from '../model/node-types.js';
import {
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_LABELS,
  relationshipColor,
} from '../model/edge-types.js';
import { nodeColor } from '../utils/graph-colors.js';

/**
 * Narrowing, in two layers that are not the same thing.
 *
 * **Node types and relationships go to the server.** The point of those is to
 * fetch less: a call-graph view should never have pulled the file tree down the
 * wire in the first place. Changing one re-queries.
 *
 * **Modules, externals, exports and entry points are applied here.** They are
 * properties of the slice that came back — the server has no module filter, and
 * inventing one would mean inventing a definition of "module" on the server
 * that the canvas would then have to agree with.
 *
 * A type the project has none of is dimmed rather than hidden: knowing the
 * graph contains no queues is information, and a filter list that changes shape
 * per project is harder to learn.
 */

export interface GraphFiltersProps {
  filters: GraphFilterState;
  model: CodeGraphModel;
  nodeTypeCounts?: NodeTypeCounts | undefined;
  relationshipCounts?: RelationshipCounts | undefined;
  /** True when this view has no EXPORTS edges, so "exported" cannot be known. */
  exportsUnavailable: boolean;
  onChange: (next: GraphFilterState) => void;
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function GraphFilters({
  filters,
  model,
  nodeTypeCounts,
  relationshipCounts,
  exportsUnavailable,
  onChange,
}: GraphFiltersProps): React.JSX.Element {
  const patch = (next: Partial<GraphFilterState>): void => {
    onChange({ ...filters, ...next });
  };

  const typeActive = (type: CodeNodeType): boolean =>
    filters.nodeTypes.length === 0 || filters.nodeTypes.includes(type);

  const relationshipActive = (relationship: CodeRelationship): boolean =>
    filters.relationships.length === 0 || filters.relationships.includes(relationship);

  const toggleType = (type: CodeNodeType): void => {
    // An empty selection means "everything", so the first click on a chip
    // narrows to everything-but-that-one.
    const base = filters.nodeTypes.length === 0 ? [...CODE_NODE_TYPES] : filters.nodeTypes;
    patch({ nodeTypes: toggle(base, type) });
  };

  const toggleRelationship = (relationship: CodeRelationship): void => {
    const base =
      filters.relationships.length === 0 ? [...CODE_RELATIONSHIPS] : filters.relationships;
    patch({ relationships: toggle(base, relationship) });
  };

  /** Takes or drops a whole family at once, which is what a heading does. */
  const toggleGroup = (group: readonly CodeNodeType[]): void => {
    const base = filters.nodeTypes.length === 0 ? [...CODE_NODE_TYPES] : filters.nodeTypes;
    const allOn = group.every((type) => base.includes(type));
    patch({
      nodeTypes: allOn
        ? base.filter((type) => !group.includes(type))
        : [...new Set([...base, ...group])],
    });
  };

  const toggleRelationshipGroup = (group: readonly CodeRelationship[]): void => {
    const base =
      filters.relationships.length === 0 ? [...CODE_RELATIONSHIPS] : filters.relationships;
    const allOn = group.every((relationship) => base.includes(relationship));
    patch({
      relationships: allOn
        ? base.filter((relationship) => !group.includes(relationship))
        : [...new Set([...base, ...group])],
    });
  };

  const moduleActive = (id: string): boolean =>
    filters.modules.length === 0 || filters.modules.includes(id);

  return (
    <div className="filters">
      <fieldset className="filters__group">
        <legend className="filters__legend">
          Scope
          <span className="filters__legend-note">applied to this view</span>
        </legend>

        <div className="filters__row">
          <span className="filters__row-title filters__row-title--static">Show</span>
          <div className="filters__chips">
            <button
              type="button"
              className={`chip${filters.showExternal ? ' chip--active' : ''}`}
              aria-pressed={filters.showExternal}
              title="Packages imported from outside this repository"
              onClick={() => {
                patch({ showExternal: !filters.showExternal });
              }}
            >
              External dependencies
              <span className="chip__count">{model.metadata.externalCount}</span>
            </button>

            <button
              type="button"
              className={`chip${filters.exportedOnly ? ' chip--active' : ''}${
                exportsUnavailable ? ' chip--empty' : ''
              }`}
              aria-pressed={filters.exportedOnly}
              disabled={exportsUnavailable}
              title={
                exportsUnavailable
                  ? 'Needs the EXPORTS relationship in the view — try the Files mode, or enable it under Relationships'
                  : 'Only symbols another file exports by name'
              }
              onClick={() => {
                patch({ exportedOnly: !filters.exportedOnly });
              }}
            >
              Public symbols only
            </button>

            <button
              type="button"
              className={`chip${filters.entryPointsOnly ? ' chip--active' : ''}`}
              aria-pressed={filters.entryPointsOnly}
              title="HTTP routes and files named like a process entry point, plus what they touch"
              onClick={() => {
                patch({ entryPointsOnly: !filters.entryPointsOnly });
              }}
            >
              Entry points only
              <span className="chip__count">{model.metadata.entryPointCount}</span>
            </button>
          </div>
        </div>

        {model.metadata.modules.length > 1 && (
          <div className="filters__row">
            <button
              type="button"
              className="filters__row-title"
              title="Show every module"
              onClick={() => {
                patch({ modules: [] });
              }}
            >
              Modules
            </button>

            <div className="filters__chips">
              {model.metadata.modules.map((module) => {
                const active = moduleActive(module.id);

                return (
                  <button
                    key={module.id}
                    type="button"
                    className={`chip${active ? ' chip--active' : ''}`}
                    aria-pressed={active}
                    title={`${module.label} — ${String(module.nodeIds.length)} nodes in this view`}
                    onClick={() => {
                      const base =
                        filters.modules.length === 0
                          ? model.metadata.modules.map((item) => item.id)
                          : filters.modules;
                      patch({ modules: toggle(base, module.id) });
                    }}
                  >
                    {module.label}
                    <span className="chip__count">{module.nodeIds.length}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="filters__group">
        <legend className="filters__legend">
          Node types
          <span className="filters__legend-note">re-queries the server</span>
          <button
            type="button"
            className="filters__all"
            onClick={() => {
              patch({ nodeTypes: [] });
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
                    toggleGroup(TYPES_BY_FAMILY[family]);
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
          <span className="filters__legend-note">re-queries the server</span>
          <button
            type="button"
            className="filters__all"
            onClick={() => {
              patch({ relationships: [] });
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
                toggleRelationshipGroup(RELATIONSHIPS_BY_GROUP[group]);
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
