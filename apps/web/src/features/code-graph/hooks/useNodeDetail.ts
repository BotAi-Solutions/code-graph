import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNodeDetail } from '../../../api/graph.api.js';
import { errorMessage } from '../../../hooks/useAsync.js';
import type { NodeDetail } from '../../../types/index.js';

/**
 * A node's full detail, with a small cache in front of it.
 *
 * Selecting a node costs a round trip, and exploring means selecting the same
 * handful of nodes over and over — click a caller, click back, click it again.
 * Without a cache that is three identical requests for an answer that cannot
 * have changed, because the graph only changes when an analysis completes.
 *
 * That is exactly why `refreshToken` is part of the key rather than a reason to
 * clear the cache: a completed run makes a new generation of answers, and
 * entries from the old one simply stop being reachable.
 *
 * The cache is bounded and insertion-ordered — a `Map` re-inserts on hit, so
 * evicting the first key evicts the least recently used one.
 */

const CACHE_LIMIT = 60;

export interface NodeDetailState {
  detail: NodeDetail | null;
  loading: boolean;
  error: string | null;
  /** Drops the cache, for a caller that knows the graph moved under it. */
  invalidate: () => void;
}

export function useNodeDetail(
  projectId: string,
  nodeId: string | null,
  refreshToken: number,
): NodeDetailState {
  const cache = useRef(new Map<string, NodeDetail>());
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (nodeId === null) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    const key = `${projectId}\u0000${String(refreshToken)}\u0000${nodeId}`;
    const cached = cache.current.get(key);

    if (cached) {
      // Re-insert so this key becomes the most recent one.
      cache.current.delete(key);
      cache.current.set(key, cached);
      setDetail(cached);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    // The previous node's detail is kept on screen while the next one loads,
    // so the panel does not blink empty on every click.
    setError(null);

    fetchNodeDetail(projectId, nodeId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;

        cache.current.set(key, result);
        if (cache.current.size > CACHE_LIMIT) {
          const oldest = cache.current.keys().next().value;
          if (oldest !== undefined) cache.current.delete(oldest);
        }

        setDetail(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [projectId, nodeId, refreshToken]);

  const invalidate = useCallback(() => {
    cache.current.clear();
  }, []);

  return { detail, loading, error, invalidate };
}
