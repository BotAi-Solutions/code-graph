import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSource, type SourceRequest } from '../../../api/source.api.js';
import { errorMessage } from '../../../hooks/useAsync.js';
import type { SourceWindow } from '../../../types/index.js';

/**
 * The source viewer's state: what is open, and the lines behind it.
 *
 * Source is fetched lazily and never speculatively — opening a project reads no
 * files at all, and selecting a node reads none either. A file is read when the
 * user asks to see it, which is what keeps exploring a large repository from
 * turning into a download of it.
 *
 * A request is a *target*, not a file: `{ nodeId }` means "show me this symbol
 * where it is written", and the server resolves the file and the range from
 * what it indexed. That is why navigating from a caller to its definition is
 * one state change here rather than a lookup the UI has to perform.
 */

const CACHE_LIMIT = 24;

export interface SourceTarget extends SourceRequest {
  /** Shown while the window loads, so the panel has a title immediately. */
  label?: string;
}

export interface SourceViewState {
  target: SourceTarget | null;
  source: SourceWindow | null;
  loading: boolean;
  error: string | null;
  /** True while a target is set; the panel renders only then. */
  open: boolean;
  show: (target: SourceTarget) => void;
  close: () => void;
  /** Re-reads the current target, dropping its cached window. */
  reload: () => void;
}

function keyOf(projectId: string, target: SourceTarget): string {
  return [
    projectId,
    target.file ?? '',
    target.nodeId ?? '',
    target.startLine ?? '',
    target.endLine ?? '',
    target.context ?? '',
  ].join('\u0000');
}

export function useSourceView(projectId: string): SourceViewState {
  const cache = useRef(new Map<string, SourceWindow>());
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const [source, setSource] = useState<SourceWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (target === null) {
      setSource(null);
      setError(null);
      setLoading(false);
      return;
    }

    const key = keyOf(projectId, target);
    const cached = cache.current.get(key);

    if (cached) {
      cache.current.delete(key);
      cache.current.set(key, cached);
      setSource(cached);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchSource(projectId, target, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;

        cache.current.set(key, result);
        if (cache.current.size > CACHE_LIMIT) {
          const oldest = cache.current.keys().next().value;
          if (oldest !== undefined) cache.current.delete(oldest);
        }

        setSource(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setSource(null);
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [projectId, target, nonce]);

  const show = useCallback((next: SourceTarget) => {
    setTarget(next);
  }, []);

  const close = useCallback(() => {
    setTarget(null);
  }, []);

  const reload = useCallback(() => {
    cache.current.clear();
    setNonce((value) => value + 1);
  }, []);

  return { target, source, loading, error, open: target !== null, show, close, reload };
}
