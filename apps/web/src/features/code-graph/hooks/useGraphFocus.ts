import { useCallback, useMemo, useState } from 'react';
import type { CodeGraphModel } from '../model/graph-types.js';
import { withinHops } from '../utils/graph-traversal.js';

/**
 * Focus mode: isolating the view around one node and its neighbourhood.
 *
 * It works on the graph that is already loaded, which is the right scope for
 * the question it answers — "show me less of what I am looking at". Walking the
 * *repository* is the server's job, and two of the workspace's buttons hand it
 * that job: Re-root re-queries from this node, and Find Path searches the whole
 * graph. Neither is done here, so there is only ever one answer to each.
 */

export interface GraphFocusState {
  /** Node the view is isolated around, or null. */
  focusNodeId: string | null;
  focusDepth: number;
  /** The isolated set, or null when focus is off. */
  focusNodeIds: ReadonlySet<string> | null;

  setFocus: (nodeId: string | null) => void;
  setFocusDepth: (depth: number) => void;
}

export const FOCUS_DEPTHS = [1, 2, 3] as const;

export function useGraphFocus(model: CodeGraphModel): GraphFocusState {
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(1);

  const focusNodeIds = useMemo(() => {
    if (!focusNodeId || !model.nodesById.has(focusNodeId)) return null;
    return withinHops(model, focusNodeId, focusDepth);
  }, [model, focusNodeId, focusDepth]);

  const setFocus = useCallback((nodeId: string | null) => {
    setFocusNodeId(nodeId);
  }, []);

  return { focusNodeId, focusDepth, focusNodeIds, setFocus, setFocusDepth };
}
