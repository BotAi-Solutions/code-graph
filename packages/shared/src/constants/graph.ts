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
 * The overview answers "what does this repository do", so it ranks the things
 * that answer it: code-bearing symbols, the architecture around them, and the
 * repository-level resources — a documented API, a container, a README.
 *
 * Files and directories are deliberately excluded: they always win a degree
 * contest (every symbol in a file is CONTAINed by it) while saying nothing
 * about behaviour. A caller wanting the file tree asks for it. So are
 * `document_section`, `config_property` and `column`, which are the interiors
 * of the three types above them and would bury their parents.
 */
export const GRAPH_OVERVIEW_NODE_TYPES = [
  'class',
  'interface',
  'type',
  'function',
  'method',
  'api',
  'api_endpoint',
  'api_spec',
  'service',
  'external_service',
  'database',
  'table',
  'queue',
  'event',
  'container',
  'document',
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

/**
 * Node types that stand for a whole file, rather than something inside one.
 *
 * Four of them, because a repository graph does not represent every file the
 * same way: the compiler's files are `file`, a Markdown file is a `document`, a
 * settings file is a `config` and a specification is an `api_spec`. The type
 * carries what kind of knowledge the file holds, which is what makes "show me
 * the documentation" a node-type filter rather than a metadata scan.
 *
 * The cost of that choice is this constant. Anything that means "a file" — the
 * source tree, the file lookup behind source retrieval — has to ask for all
 * four, or a README would be missing from the explorer that is supposed to open
 * it.
 */
export const FILE_LIKE_NODE_TYPES = ['file', 'document', 'config', 'api_spec'] as const;

export type FileLikeNodeType = (typeof FILE_LIKE_NODE_TYPES)[number];

export function isFileLikeNodeType(type: string): type is FileLikeNodeType {
  return (FILE_LIKE_NODE_TYPES as readonly string[]).includes(type);
}

/** The source tree is the file-like types plus the directories holding them. */
export const SOURCE_TREE_NODE_TYPES = ['directory', ...FILE_LIKE_NODE_TYPES] as const;
