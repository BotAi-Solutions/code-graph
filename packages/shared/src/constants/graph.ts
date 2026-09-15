/**
 * Traversal defaults. The graph API is deliberately traversal-first: a whole
 * repository graph is never returned by default because it would overwhelm both
 * the API and the canvas.
 */
export const GRAPH_DEFAULT_DEPTH = 2;
export const GRAPH_MAX_DEPTH = 5;
export const GRAPH_DEFAULT_NODE_LIMIT = 500;
export const GRAPH_MAX_NODE_LIMIT = 2000;

/** Separator used when composing stable graph identities. */
export const GRAPH_ID_SEPARATOR = '::';

/**
 * Node types the overview ranks when the caller does not choose.
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
] as const;
