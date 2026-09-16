/**
 * Traversal defaults. The graph API is deliberately traversal-first: a whole
 * repository graph is never returned by default because it would overwhelm both
 * the API and the canvas.
 */
export const GRAPH_DEFAULT_DEPTH = 2;
export const GRAPH_MAX_DEPTH = 5;
export const GRAPH_DEFAULT_NODE_LIMIT = 500;
export const GRAPH_MAX_NODE_LIMIT = 2000;

/** Depth a single expand-on-click step fetches. */
export const GRAPH_EXPANSION_DEPTH = 1;
/** Neighbours returned per section of the node inspector. */
export const GRAPH_DEFAULT_NEIGHBOUR_LIMIT = 100;
/** Search page size, and the ceiling a caller may ask for. */
export const GRAPH_DEFAULT_SEARCH_LIMIT = 20;
export const GRAPH_MAX_SEARCH_LIMIT = 100;

/** Separator used when composing stable graph identities. */
export const GRAPH_ID_SEPARATOR = '::';

/**
 * Which way a traversal is allowed to walk. `both` is the default because a
 * depth-1 walk from a service should find its callers as well as its callees.
 */
export const GRAPH_DIRECTIONS = ['both', 'outgoing', 'incoming'] as const;

export type GraphDirection = (typeof GRAPH_DIRECTIONS)[number];

export const GRAPH_DEFAULT_DIRECTION: GraphDirection = 'both';

/**
 * Node types the overview ranks when neither the caller nor the projection
 * chooses.
 *
 * The overview answers "what does this codebase do", so it ranks code-bearing
 * symbols. Files and directories are deliberately excluded: they always win a
 * degree contest (every symbol in a file is CONTAINed by it) while saying
 * nothing about behaviour. A caller wanting the file tree asks for it.
 */
export const GRAPH_OVERVIEW_NODE_TYPES = [
  'class',
  'interface',
  'type',
  'function',
  'method',
  'api',
  'service',
  'external_service',
  'database',
  'table',
  'queue',
  'event',
] as const;

/**
 * Bounded path search between two nodes.
 *
 * A path query is a breadth-first walk, so it is bounded twice: by how many
 * hops it may take, and by how many nodes it may visit before giving up. Both
 * matter — a hub node in a real repository reaches most of the graph in three
 * hops, and an unbounded search would happily prove it.
 */
export const GRAPH_DEFAULT_PATH_DEPTH = 6;
export const GRAPH_MAX_PATH_DEPTH = 12;
/** Nodes one path search may visit before it reports `truncated`. */
export const GRAPH_PATH_NODE_BUDGET = 20_000;

/**
 * Which way a path search may follow an edge.
 *
 * `outgoing` asks the question that a trace is usually about — how does a
 * request get from the controller to the table — and falls back to an
 * undirected search when no directed route exists, saying so in the result.
 * `both` ignores direction from the start.
 */
export const GRAPH_PATH_DIRECTIONS = ['outgoing', 'both'] as const;

export type GraphPathDirection = (typeof GRAPH_PATH_DIRECTIONS)[number];

export const GRAPH_DEFAULT_PATH_DIRECTION: GraphPathDirection = 'outgoing';

/** Entries one level of the source tree returns. */
export const SOURCE_TREE_DEFAULT_LIMIT = 500;
export const SOURCE_TREE_MAX_LIMIT = 2000;
