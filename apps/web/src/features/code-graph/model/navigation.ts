import type { CodeNode, GraphPath, GraphPathStep, SourceWindow } from '../../../types/index.js';
import type { CodeGraphModel } from './graph-types.js';

/**
 * The decisions behind moving around the explorer.
 *
 * Search → symbol → definition → source → callers → graph is a sequence of
 * small choices — is this node already drawn, which folders have to open to
 * reveal this file, which hop leaves this step of a route — and every one of
 * them is a pure function of what came back from the server. Keeping them here
 * rather than inside the components means they can be checked without a
 * browser, and that a component never has to decide anything.
 */

/** What a graph node needs from the source endpoint to be shown. */
export interface SourceTarget {
  file?: string;
  nodeId?: string;
  startLine?: number;
  endLine?: number;
  context?: number;
  label?: string;
}

/**
 * Where to show a node's source.
 *
 * Addressed by node id, never by path plus line, because the server holds the
 * indexed range and the client holds a view model that may be a filtered
 * projection of it. Sending the id asks the question the graph actually
 * answers: "where is this symbol written".
 */
export function sourceTargetForNode(node: Pick<CodeNode, 'id' | 'filePath'>): SourceTarget {
  return { nodeId: node.id, ...(node.filePath ? { label: node.filePath } : {}) };
}

/**
 * What choosing a search result should do.
 *
 * A result already on the canvas is a camera move: re-querying would discard
 * the view the user was reading to fetch something they can already see. One
 * that is not drawn has to be fetched, and re-rooting there puts it in the
 * middle rather than leaving the reader to find it.
 */
export function searchSelectionAction(
  model: CodeGraphModel,
  nodeId: string,
): 'focus' | 'reroot' {
  return model.nodesById.has(nodeId) ? 'focus' : 'reroot';
}

/**
 * Every folder that has to be open for a file to be visible, outermost first.
 *
 * `src/services/user.service.ts` needs `src` and `src/services`. A file at the
 * root needs nothing.
 */
export function ancestorPaths(filePath: string): string[] {
  const segments = filePath.split('/').filter((segment) => segment.length > 0);
  segments.pop();

  const paths: string[] = [];
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    paths.push(current);
  }
  return paths;
}

/** True when a line falls inside the range the source window is about. */
export function isHighlighted(
  highlight: SourceWindow['highlight'],
  line: number,
): boolean {
  if (highlight === null) return false;
  return line >= highlight.startLine && line <= highlight.endLine;
}

/**
 * A route as rows: each node paired with the hop that leaves it.
 *
 * The last node has no hop, which is what ends the list — rendering the route
 * from `steps` alone would drop it, and rendering from `nodes` alone would lose
 * the relationship that connects each pair.
 */
export interface PathRow {
  node: CodeNode;
  /** The hop out of this node, or null for the last one. */
  step: GraphPathStep | null;
}

export function pathRows(path: GraphPath | null): PathRow[] {
  if (!path || !path.found) return [];
  return path.nodes.map((node, index) => ({ node, step: path.steps[index] ?? null }));
}

/**
 * A one-line summary of a route: how far, and through what.
 *
 * Relationships are the distinct ones in order of first use, so a four-hop call
 * chain reads `ROUTES_TO → CALLS → WRITES_TO` rather than repeating CALLS.
 */
export function pathSummary(path: GraphPath): string {
  const hops = `${String(path.depth)} hop${path.depth === 1 ? '' : 's'}`;
  return path.relationships.length === 0 ? hops : `${hops} · ${path.relationships.join(' → ')}`;
}
