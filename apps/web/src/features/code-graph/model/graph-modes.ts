import { GRAPH_PROJECTIONS, graphProjection } from '@ckg/shared';
import type {
  CodeNodeType,
  CodeRelationship,
  GraphProjection,
  GraphProjectionId,
} from '../../../types/index.js';

/**
 * The graph modes: one question each, one graph.
 *
 * A mode is the server's *projection* plus how the view should be drawn for it.
 * The projections are imported rather than restated, so "Architecture" in the
 * toolbar and `?projection=architecture` on the wire cannot drift apart, and so
 * the server can rank an overview by what the mode is about — which no
 * client-side filter could do.
 *
 * What a mode adds on top is presentational: how many nodes are worth asking
 * for, how tightly the layout should pack, and whether flow animation earns its
 * place. Nothing here changes graph semantics.
 */

export type GraphModeId = GraphProjectionId;

export interface GraphMode {
  id: GraphModeId;
  label: string;
  /** One line explaining what question the mode answers. */
  title: string;
  projection: GraphProjection;
  /** Nodes to ask the API for. Bounded by GRAPH_MAX_NODE_LIMIT. */
  limit: number;
  /**
   * How hard the layout pulls clusters apart. Higher spreads modules into
   * distinct islands; lower packs a filtered view into one readable region.
   */
  clusterSpread: number;
  /** Flow particles suit modes about behaviour, not modes about structure. */
  animateFlow: boolean;
  /** Label budget multiplier: a sparse mode can afford more labels. */
  labelDensity: number;
}

const PRESENTATION: Record<GraphModeId, Omit<GraphMode, 'id' | 'label' | 'title' | 'projection'>> =
  {
    everything: { limit: 1200, clusterSpread: 1.7, animateFlow: true, labelDensity: 1 },
    architecture: { limit: 800, clusterSpread: 1.1, animateFlow: true, labelDensity: 1.3 },
    calls: { limit: 900, clusterSpread: 0.95, animateFlow: true, labelDensity: 1.15 },
    files: { limit: 900, clusterSpread: 1.5, animateFlow: false, labelDensity: 1.05 },
    dependencies: { limit: 700, clusterSpread: 1.45, animateFlow: false, labelDensity: 1.35 },
    dataflow: { limit: 700, clusterSpread: 1.15, animateFlow: true, labelDensity: 1.35 },

    // The repository views. All are sparse by construction — a projection that
    // filters to documents or containers is showing tens of nodes, not
    // thousands — so they can afford a generous label budget and a tight
    // layout, and none of them is about flow except the contract trace.
    documentation: { limit: 600, clusterSpread: 1.3, animateFlow: false, labelDensity: 1.4 },
    apis: { limit: 600, clusterSpread: 1.05, animateFlow: true, labelDensity: 1.45 },
    configuration: { limit: 600, clusterSpread: 1.35, animateFlow: false, labelDensity: 1.4 },
    data: { limit: 700, clusterSpread: 1.2, animateFlow: true, labelDensity: 1.3 },
    'cross-source': { limit: 600, clusterSpread: 1.5, animateFlow: true, labelDensity: 1.5 },
  };

/** `everything` is the unfiltered overview, which is what "Universe" means. */
const LABELS: Partial<Record<GraphModeId, string>> = {
  everything: 'Universe',
};

export const GRAPH_MODES: readonly GraphMode[] = GRAPH_PROJECTIONS.map((projection) => ({
  id: projection.id,
  label: LABELS[projection.id] ?? projection.label,
  title: projection.title,
  projection,
  ...PRESENTATION[projection.id],
}));

const BY_ID = new Map<GraphModeId, GraphMode>(GRAPH_MODES.map((mode) => [mode.id, mode]));

export function graphMode(id: GraphModeId): GraphMode {
  const mode = BY_ID.get(id);
  if (!mode) throw new Error(`unknown graph mode: ${id}`);
  return mode;
}

/**
 * The mode a project opens on.
 *
 * Architecture, not Universe: it answers the question someone actually arrives
 * with — how is this system put together — and an unfiltered overview of a real
 * repository is a hairball, which is not an introduction. This is also the
 * server's own default, so the first request needs no override.
 */
export const DEFAULT_MODE_ID: GraphModeId = 'architecture';

export function defaultMode(): GraphMode {
  return graphMode(DEFAULT_MODE_ID);
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Which mode the current filters correspond to, if any.
 *
 * The active mode is tracked explicitly, so this only has to answer the other
 * question: has the user edited the filters away from what the mode prescribes?
 * When they have, no button claims to describe the view.
 */
export function matchMode(
  nodeTypes: readonly CodeNodeType[],
  relationships: readonly CodeRelationship[],
): GraphModeId | null {
  return (
    GRAPH_MODES.find(
      (mode) =>
        sameSet(mode.projection.nodeTypes, nodeTypes) &&
        sameSet(mode.projection.relationships, relationships),
    )?.id ?? null
  );
}

export { graphProjection };
