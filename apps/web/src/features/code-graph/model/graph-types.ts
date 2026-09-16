import type {
  CodeEdge,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  GraphDirection,
  GraphProjectionId,
} from '../../../types/index.js';

/**
 * The visualisation's own graph model.
 *
 * The renderer never sees a SCIP response or an API envelope. It sees this,
 * which is deliberately a different shape: the API answers "what is in the
 * graph", and this answers "what should be drawn and how loudly". Anything
 * derived — degree, centrality, importance, module membership, cluster — is
 * computed once here rather than recomputed in six components.
 *
 * `source` on each node and edge is the untouched API record, so the inspector
 * and every follow-up request still speak the server's vocabulary. Normalising
 * adds a layer; it does not fork the contract.
 */

export interface GraphNodeMetrics {
  degree: number;
  inDegree: number;
  outDegree: number;
  /** Outgoing edges along dependency-bearing relationships. */
  dependencies: number;
  /** Incoming ones. */
  dependents: number;
  /** PageRank over the displayed slice, normalised to its own maximum, 0–1. */
  centrality: number;
  /** The composite the renderer sizes, glows and labels by, 0–1. */
  importance: number;
}

export interface GraphNode {
  id: string;
  /** What the canvas draws: `getUser()`, `UserService`, `POST /users`. */
  label: string;
  /** The qualified form, for tooltips and the inspector. */
  fullLabel: string;
  type: CodeNodeType;
  file: string | null;
  /**
   * The cluster this node belongs to: a source directory, an external package
   * belt, or the infrastructure the repository talks to. This is what makes
   * the layout a galaxy rather than a cloud.
   */
  module: string;
  /** Human-readable module name, for filters and the inspector. */
  moduleLabel: string;
  directory: string | null;
  /** A package outside this repository. */
  external: boolean;
  /** An HTTP route, or a file named like a process entry point. */
  entryPoint: boolean;
  /** Something another file imports by name. */
  exported: boolean;
  /** `controller`, `service`, `repository`, `entity` — when an analyzer said so. */
  role: string | null;
  metadata: Record<string, unknown>;
  metrics: GraphNodeMetrics;
  /** The API record, untouched. */
  source: CodeNode;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: CodeRelationship;
  /** `mutual` when the same pair is also related the other way round. */
  direction: 'directed' | 'mutual';
  /** Observation count where the producer reported one, else 1. */
  weight: number;
  metadata: Record<string, unknown>;
  /** The API record, untouched. */
  sourceEdge: CodeEdge;
}

export interface GraphModule {
  id: string;
  label: string;
  /** Node ids in this module, in the order they arrived. */
  nodeIds: string[];
  kind: 'source' | 'external' | 'infrastructure' | 'root';
}

export interface GraphMetadata {
  repository: string | null;
  branch: string | null;
  commit: string | null;
  nodeCount: number;
  edgeCount: number;
  modules: GraphModule[];
  languages: string[];
  /** Counts the stats bar reports, computed once over the whole model. */
  entryPointCount: number;
  externalCount: number;
}

export interface CodeGraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: GraphMetadata;
  /** Lookup by id, built alongside the arrays so no component rebuilds it. */
  nodesById: ReadonlyMap<string, GraphNode>;
  edgesById: ReadonlyMap<string, GraphEdge>;
  /** Undirected adjacency, for hover neighbourhoods and path finding. */
  adjacency: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_MODEL: CodeGraphModel = {
  nodes: [],
  edges: [],
  metadata: {
    repository: null,
    branch: null,
    commit: null,
    nodeCount: 0,
    edgeCount: 0,
    modules: [],
    languages: [],
    entryPointCount: 0,
    externalCount: 0,
  },
  nodesById: new Map(),
  edgesById: new Map(),
  adjacency: new Map(),
};

// --- view state -----------------------------------------------------------

/**
 * Client-side narrowing, applied after the server has answered.
 *
 * Node types and relationships are *server* filters — the point of those is to
 * fetch less. Modules, externals, exports and entry points are properties of
 * the slice that came back, so they are applied here.
 */
export interface GraphFilterState {
  nodeTypes: CodeNodeType[];
  relationships: CodeRelationship[];
  /** Empty means every module. */
  modules: string[];
  showExternal: boolean;
  exportedOnly: boolean;
  entryPointsOnly: boolean;
}

export interface GraphQueryState {
  rootNodeId: string | null;
  depth: number;
  direction: GraphDirection;
  projection: GraphProjectionId | null;
}

/** What the user is looking at right now. */
export interface GraphSelection {
  nodeId: string | null;
  edgeId: string | null;
}

/** A found route between two nodes in the displayed graph. */
export interface GraphPath {
  from: string;
  to: string;
  /** Node ids, from `from` to `to` inclusive. Empty when there is no route. */
  nodeIds: string[];
  edgeIds: string[];
}

export function isEmpty(model: CodeGraphModel): boolean {
  return model.nodes.length === 0;
}
