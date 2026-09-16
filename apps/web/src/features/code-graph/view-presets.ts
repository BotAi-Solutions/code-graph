import { DEFAULT_GRAPH_PROJECTION_ID, GRAPH_PROJECTIONS, graphProjection } from '@ckg/shared';
import type { CodeNodeType, CodeRelationship, GraphProjection, GraphProjectionId } from '../../types/index.js';

/**
 * The toolbar's views, which are the server's projections.
 *
 * These used to be client-side filter combinations. They are now the same
 * definitions the API reads, imported rather than restated, so "Architecture"
 * in the toolbar and `?projection=architecture` on the wire cannot drift apart —
 * and so the server can *rank* an overview by what the projection is about,
 * which no client-side filter could do.
 */
export type ViewPreset = GraphProjection;

export const VIEW_PRESETS: readonly GraphProjection[] = GRAPH_PROJECTIONS;

export const DEFAULT_PRESET_ID: GraphProjectionId = DEFAULT_GRAPH_PROJECTION_ID;

export function defaultPreset(): GraphProjection {
  return graphProjection(DEFAULT_GRAPH_PROJECTION_ID);
}

export function presetById(id: GraphProjectionId): GraphProjection {
  return graphProjection(id);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Which projection the current filters correspond to, if any.
 *
 * The active projection is tracked explicitly by the page, so this only has to
 * answer the other question: has the user edited the filters away from what the
 * projection prescribes? When they have, no button is lit.
 */
export function matchPreset(
  nodeTypes: readonly CodeNodeType[],
  relationships: readonly CodeRelationship[],
): GraphProjectionId | null {
  return (
    VIEW_PRESETS.find(
      (preset) =>
        sameSet(preset.nodeTypes, nodeTypes) && sameSet(preset.relationships, relationships),
    )?.id ?? null
  );
}
