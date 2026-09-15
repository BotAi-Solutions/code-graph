import { useState } from 'react';
import { GRAPH_MAX_DEPTH } from '@ckg/shared';
import type { CodeNode, CodeNodeType, CodeRelationship, GraphMeta } from '../../types/index.js';
import { GraphFilters } from './GraphFilters.js';
import { VIEW_PRESETS, matchPreset } from './view-presets.js';
import { GraphSearch } from './GraphSearch.js';

export interface GraphToolbarProps {
  projectId: string;
  depth: number;
  nodeTypes: CodeNodeType[];
  relationships: CodeRelationship[];
  meta: GraphMeta | null;
  loading: boolean;
  onChangeDepth: (depth: number) => void;
  onChangeNodeTypes: (next: CodeNodeType[]) => void;
  onChangeRelationships: (next: CodeRelationship[]) => void;
  onSearchSelect: (node: CodeNode) => void;
  onApplyPreset: (nodeTypes: CodeNodeType[], relationships: CodeRelationship[]) => void;
  onFit: () => void;
  onReset: () => void;
}

export function GraphToolbar(props: GraphToolbarProps): React.JSX.Element {
  const [filtersOpen, setFiltersOpen] = useState(false);

  const activePreset = matchPreset(props.nodeTypes, props.relationships);

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
            disabled={props.meta?.mode === 'overview'}
            title={
              props.meta?.mode === 'overview'
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

        <div className="segmented" role="group" aria-label="View preset">
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
                props.onApplyPreset(preset.nodeTypes, preset.relationships);
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
              ? `${String(props.meta.nodeCount)} nodes · ${String(props.meta.edgeCount)} edges${
                  props.meta.truncated ? ' · truncated' : ''
                } · ${props.meta.mode}`
              : ''}
        </span>
      </div>

      {filtersOpen && (
        <GraphFilters
          nodeTypes={props.nodeTypes}
          relationships={props.relationships}
          onChangeNodeTypes={props.onChangeNodeTypes}
          onChangeRelationships={props.onChangeRelationships}
        />
      )}
    </div>
  );
}
