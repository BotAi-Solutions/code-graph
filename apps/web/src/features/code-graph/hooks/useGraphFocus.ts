import { useCallback, useMemo, useState } from 'react';
import type { CodeGraphModel } from '../model/graph-types.js';
import { findPath, inducedEdges, withinHops, type PathResult } from '../utils/graph-traversal.js';

/**
 * Focus mode and the path finder: the two ways of asking the canvas to show
 * less.
 *
 * They are one hook because they are the same idea with different arguments —
 * "restrict the view to this part of the graph" — and because they are mutually
 * exclusive in practice: a path *is* a focus, and having both active would
 * leave the user unable to say which one they were looking at.
 *
 * Both work on the graph that is already loaded. That is a real limit and the
 * UI says so: a path is found between two things you can see, not through the
 * whole repository. Walking the repository is the server's job, and the Focus
 * button hands it that job by re-rooting the query.
 */

export interface GraphFocusState {
  /** Node the view is isolated around, or null. */
  focusNodeId: string | null;
  focusDepth: number;
  /** The isolated set, or null when focus is off. */
  focusNodeIds: ReadonlySet<string> | null;

  path: PathResult | null;
  pathFrom: string | null;
  pathTo: string | null;
  pathNodeIds: ReadonlySet<string> | null;
  pathEdgeIds: ReadonlySet<string> | null;

  setFocus: (nodeId: string | null) => void;
  setFocusDepth: (depth: number) => void;
  setPathFrom: (nodeId: string | null) => void;
  setPathTo: (nodeId: string | null) => void;
  clearPath: () => void;
}

export const FOCUS_DEPTHS = [1, 2, 3] as const;

export function useGraphFocus(model: CodeGraphModel): GraphFocusState {
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(1);
  const [pathFrom, setPathFromState] = useState<string | null>(null);
  const [pathTo, setPathToState] = useState<string | null>(null);

  const focusNodeIds = useMemo(() => {
    if (!focusNodeId || !model.nodesById.has(focusNodeId)) return null;
    return withinHops(model, focusNodeId, focusDepth);
  }, [model, focusNodeId, focusDepth]);

  const path = useMemo(() => {
    if (!pathFrom || !pathTo) return null;
    return findPath(model, pathFrom, pathTo);
  }, [model, pathFrom, pathTo]);

  const pathNodeIds = useMemo(
    () => (path && path.nodeIds.length > 0 ? new Set(path.nodeIds) : null),
    [path],
  );

  const pathEdgeIds = useMemo(() => {
    if (!path || path.nodeIds.length === 0) return null;
    // The route's own edges, plus any other edge between two nodes on it — a
    // path drawn without them would imply those relationships do not exist.
    const along = inducedEdges(model, new Set(path.nodeIds));
    for (const id of path.edgeIds) along.add(id);
    return along;
  }, [model, path]);

  const setFocus = useCallback((nodeId: string | null) => {
    setFocusNodeId(nodeId);
    if (nodeId) {
      setPathFromState(null);
      setPathToState(null);
    }
  }, []);

  const setPathFrom = useCallback((nodeId: string | null) => {
    setPathFromState(nodeId);
    if (nodeId) setFocusNodeId(null);
  }, []);

  const setPathTo = useCallback((nodeId: string | null) => {
    setPathToState(nodeId);
    if (nodeId) setFocusNodeId(null);
  }, []);

  const clearPath = useCallback(() => {
    setPathFromState(null);
    setPathToState(null);
  }, []);

  return {
    focusNodeId,
    focusDepth,
    focusNodeIds,
    path,
    pathFrom,
    pathTo,
    pathNodeIds,
    pathEdgeIds,
    setFocus,
    setFocusDepth,
    setPathFrom,
    setPathTo,
    clearPath,
  };
}
