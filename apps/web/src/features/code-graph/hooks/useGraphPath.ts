import { useCallback, useEffect, useMemo, useState } from 'react';
import { findPath } from '../../../api/graph.api.js';
import { errorMessage } from '../../../hooks/useAsync.js';
import type { CodeGraph, GraphPath, GraphProjectionId } from '../../../types/index.js';

/**
 * Find Path, answered by the server.
 *
 * The canvas holds a slice; the question does not. "How does a request get from
 * the controller to the table" is about the repository, and the route usually
 * runs through nodes the current view never fetched — so asking the canvas
 * would reliably answer "no route" about a route that plainly exists.
 *
 * The server walks the whole graph, breadth-first and bounded, and returns the
 * route *with its nodes and edges*. Those are merged onto the canvas by the
 * caller, which is what makes a found path something you can actually look at
 * rather than a list of names.
 */

export interface GraphPathState {
  from: string | null;
  to: string | null;
  path: GraphPath | null;
  loading: boolean;
  error: string | null;
  /** The route's nodes and edges, for merging into the view. Null when none. */
  graph: CodeGraph | null;
  pathNodeIds: ReadonlySet<string> | null;
  pathEdgeIds: ReadonlySet<string> | null;
  setFrom: (nodeId: string | null) => void;
  setTo: (nodeId: string | null) => void;
  clear: () => void;
}

export function useGraphPath(
  projectId: string,
  projection: GraphProjectionId | null,
): GraphPathState {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [path, setPath] = useState<GraphPath | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) {
      setPath(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    // Deliberately no `projection` filter on the request. A projection narrows
    // what is *drawn*; narrowing the search as well would make Find Path answer
    // "no route" whenever the route happened to pass through a node type the
    // current view is hiding, which is the least useful moment to be quiet.
    findPath(projectId, { from, to }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPath(result);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setPath(null);
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [projectId, from, to, projection]);

  const graph = useMemo<CodeGraph | null>(
    () => (path?.found ? { nodes: path.nodes, edges: path.edges } : null),
    [path],
  );

  const pathNodeIds = useMemo(
    () => (path?.found ? new Set(path.nodes.map((node) => node.id)) : null),
    [path],
  );

  const pathEdgeIds = useMemo(
    () => (path?.found ? new Set(path.edges.map((edge) => edge.id)) : null),
    [path],
  );

  const clear = useCallback(() => {
    setFrom(null);
    setTo(null);
  }, []);

  return {
    from,
    to,
    path,
    loading,
    error,
    graph,
    pathNodeIds,
    pathEdgeIds,
    setFrom,
    setTo,
    clear,
  };
}
