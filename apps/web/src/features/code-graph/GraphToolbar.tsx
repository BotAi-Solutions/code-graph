import { useState } from 'react';
import { GRAPH_MAX_DEPTH } from '@ckg/shared';
import type {
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  GraphMeta,
  GraphProjectionId,
  GraphSummary,
} from '../../types/index.js';
import { GraphFilters } from './GraphFilters.js';
import { VIEW_PRESETS, matchPreset } from './view-presets.js';
import { GraphSearch } from './GraphSearch.js';

export interface GraphToolbarProps {
  projectId: string;
  depth: number;
  projection: GraphProjectionId | null;
  nodeTypes: CodeNodeType[];
  relationships: CodeRelationship[];
  meta: GraphMeta | null;
  summary: GraphSummary | null;
  loading: boolean;
  expandedCount: number;
  onChangeDepth: (depth: number) => void;
  onChangeNodeTypes: (next: CodeNodeType[]) => void;
  onChangeRelationships: (next: CodeRelationship[]) => void;
  onSearchSelect: (node: CodeNode) => void;
  onApplyPreset: (projection: GraphProjectionId) => void;
  onFit: () => void;
  onReset: () => void;
}

export function GraphToolbar(props: GraphToolbarProps): React.JSX.Element {
  const [filtersOpen, setFiltersOpen] = useState(false);

  // A projection is lit while the filters still match what it prescribes; the
  // moment the user edits them, no button claims to describe the view.
  const activePreset = matchPreset(props.nodeTypes, props.relationships) ?? props.projection;
  const edited =
    props.projection !== null && matchPreset(props.nodeTypes, props.relationships) === null;

  const overview = props.meta?.mode === 'overview';

  return (
    <div className="toolbar">
      <div className="toolbar__row">
        <GraphSearch projectId={props.projectId} onSelect={props.onSearchSelect} />

        <label className="toolbar__depth">
          Depth
          <input
            type="number"
            min={0}
            max={GRAPH_MAX_DEPTH}
            value={props.depth}
            disabled={overview}
            title={
              overview
                ? 'Depth applies once a root node is selected'
                : 'Hops to traverse from the root node'
            }
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) {
                props.onChangeDepth(Math.min(Math.max(next, 0), GRAPH_MAX_DEPTH));
              }
            }}
          />
        </label>

        <div className="segmented" role="group" aria-label="Graph projection">
          {VIEW_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`segmented__option${
                activePreset === preset.id ? ' segmented__option--active' : ''
              }`}
              title={preset.title}
              aria-pressed={activePreset === preset.id}
              onClick={() => {
                props.onApplyPreset(preset.id);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`button${filtersOpen ? ' button--active' : ''}`}
          aria-expanded={filtersOpen}
          onClick={() => {
            setFiltersOpen((open) => !open);
          }}
        >
          Filters
          {edited && <span className="button__mark" title="Filters edited" />}
        </button>

        <div className="toolbar__spacer" />

        <button type="button" className="button" onClick={props.onFit}>
          Fit
        </button>
        <button type="button" className="button" onClick={props.onReset}>
          Reset
        </button>

        <span className="toolbar__status">
          {props.loading
            ? 'loading…'
            : props.meta
              ? [
                  `${String(props.meta.nodeCount)} nodes`,
                  `${String(props.meta.edgeCount)} edges`,
                  props.expandedCount > 0 ? `${String(props.expandedCount)} expanded` : null,
                  props.meta.truncated ? 'truncated' : null,
                  props.meta.mode,
                ]
                  .filter((part): part is string => part !== null)
                  .join(' · ')
              : ''}
        </span>
      </div>

      {filtersOpen && (
        <GraphFilters
          nodeTypes={props.nodeTypes}
          relationships={props.relationships}
          nodeTypeCounts={props.summary?.nodeTypeCounts}
          relationshipCounts={props.summary?.relationshipCounts}
          onChangeNodeTypes={props.onChangeNodeTypes}
          onChangeRelationships={props.onChangeRelationships}
        />
      )}
    </div>
  );
}
