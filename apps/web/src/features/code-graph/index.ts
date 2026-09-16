/**
 * The code graph feature.
 *
 * Only the workspace and the pieces another screen legitimately needs are
 * exported. The engine, the layout and the render state are internal: nothing
 * outside this folder should be able to reach into how the graph is drawn.
 */
export { GraphWorkspace } from './GraphWorkspace.js';
export type { GraphWorkspaceProps } from './GraphWorkspace.js';

export { GRAPH_MODES, DEFAULT_MODE_ID, graphMode, matchMode } from './model/graph-modes.js';
export type { GraphMode, GraphModeId } from './model/graph-modes.js';

export { normalizeGraph } from './model/graph-transform.js';
export { mergeGraphs, newNodeCount } from './model/merge-graph.js';
export { NODE_STYLES, TYPES_BY_FAMILY, nodeStyle, nodeLabel, nodeFullName, nodeTypeLabel } from './model/node-types.js';
export { EDGE_STYLES, edgeStyle, relationshipColor } from './model/edge-types.js';

export { FAMILY_COLORS, familyColor, nodeColor } from './utils/graph-colors.js';
export type { CodeGraphModel, GraphNode, GraphEdge, GraphMetadata } from './model/graph-types.js';
