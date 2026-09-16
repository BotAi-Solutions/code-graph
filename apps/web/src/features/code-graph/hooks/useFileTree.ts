import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTree } from '../../../api/graph.api.js';
import { errorMessage } from '../../../hooks/useAsync.js';
import type { SourceTree, SourceTreeEntry } from '../../../types/index.js';
import { ancestorPaths } from '../model/navigation.js';

/**
 * The repository tree, one expanded folder at a time.
 *
 * Derived from the graph's own `file` and `directory` nodes rather than from a
 * second filesystem walk, and fetched per level rather than whole: a mid-sized
 * repository has thousands of path nodes, and a tree that shipped all of them
 * to draw twelve rows would be the most expensive thing on the screen.
 *
 * Levels are cached for the life of the workspace, so collapsing and
 * re-expanding a folder costs nothing. The cache is keyed by project and by the
 * refresh token, so a completed analysis is a new generation rather than stale
 * rows.
 */

export interface FileTreeState {
  /** Levels already fetched, keyed by directory path (`''` is the root). */
  levels: ReadonlyMap<string, SourceTreeEntry[]>;
  expanded: ReadonlySet<string>;
  /** Paths with a request in flight, so a row can show it is loading. */
  loadingPaths: ReadonlySet<string>;
  error: string | null;
  toggle: (path: string) => void;
  /** Opens every folder on the way to a file, so it can be revealed. */
  revealFile: (filePath: string) => void;
}

export function useFileTree(projectId: string, refreshToken: number): FileTreeState {
  const [levels, setLevels] = useState<ReadonlyMap<string, SourceTreeEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  /**
   * Paths already requested this generation.
   *
   * A ref rather than state because it guards the *request*, and two rows
   * expanding in the same tick must both see the first one's mark — a state
   * update would not have landed yet.
   */
  const requested = useRef(new Set<string>());
  const generation = `${projectId}\u0000${String(refreshToken)}`;
  const currentGeneration = useRef(generation);

  if (currentGeneration.current !== generation) {
    currentGeneration.current = generation;
    requested.current = new Set();
  }

  const load = useCallback(
    (path: string) => {
      if (requested.current.has(path)) return;
      requested.current.add(path);

      setLoadingPaths((current) => new Set(current).add(path));

      fetchTree(projectId, path)
        .then((level: SourceTree) => {
          setLevels((current) => new Map(current).set(path, level.entries));
          setError(null);
        })
        .catch((cause: unknown) => {
          // Allow a retry: a level that failed should not be permanently empty.
          requested.current.delete(path);
          setError(errorMessage(cause));
        })
        .finally(() => {
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        });
    },
    [projectId],
  );

  // The root level is the one thing fetched without being asked for: a tree
  // with nothing in it is not a tree.
  useEffect(() => {
    setLevels(new Map());
    setExpanded(new Set());
    load('');
  }, [load, refreshToken]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
          return next;
        }
        next.add(path);
        return next;
      });
      load(path);
    },
    [load],
  );

  const revealFile = useCallback(
    (filePath: string) => {
      const ancestors = ancestorPaths(filePath);
      setExpanded((current) => {
        const next = new Set(current);
        for (const path of ancestors) next.add(path);
        return next;
      });
      for (const path of ancestors) load(path);
    },
    [load],
  );

  return { levels, expanded, loadingPaths, error, toggle, revealFile };
}
