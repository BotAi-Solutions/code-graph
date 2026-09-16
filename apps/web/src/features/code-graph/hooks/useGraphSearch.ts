import { useEffect, useMemo, useState } from 'react';
import { searchNodes } from '../../../api/graph.api.js';
import { errorMessage } from '../../../hooks/useAsync.js';
import type { CodeNode, CodeNodeType } from '../../../types/index.js';
import type { CodeGraphModel } from '../model/graph-types.js';

/**
 * Search across the whole project, and its echo on the canvas.
 *
 * The server does the matching, because it is matching against the repository
 * and the canvas only holds a slice of it: a search that could only find what
 * was already drawn would be a filter pretending to be a search. What the
 * canvas contributes is the *overlap* — which of the results are on screen
 * right now — so matches light up where they exist and a result that is not
 * drawn yet still takes you to it.
 */

const DEBOUNCE_MS = 200;
const PAGE_SIZE = 20;

export interface GraphSearchState {
  term: string;
  setTerm: (term: string) => void;
  results: CodeNode[];
  total: number;
  loading: boolean;
  error: string | null;
  /** Result ids that are on the canvas, so they can be lit rather than fetched. */
  matchedNodeIds: ReadonlySet<string> | null;
  clear: () => void;
}

export function useGraphSearch(
  projectId: string,
  model: CodeGraphModel,
  options: { nodeTypes?: CodeNodeType[] } = {},
): GraphSearchState {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CodeNode[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nodeTypeKey = options.nodeTypes?.join(',') ?? '';

  useEffect(() => {
    const trimmed = term.trim();

    if (trimmed.length === 0) {
      setResults([]);
      setTotal(0);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const timer = setTimeout(() => {
      searchNodes(projectId, trimmed, { limit: PAGE_SIZE }, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setResults(page.nodes);
          setTotal(page.total);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(errorMessage(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // `nodeTypeKey` is a stable stand-in for the array identity.
  }, [projectId, term, nodeTypeKey]);

  const matchedNodeIds = useMemo(() => {
    if (results.length === 0) return null;
    const matched = new Set<string>();
    for (const node of results) {
      if (model.nodesById.has(node.id)) matched.add(node.id);
    }
    return matched.size > 0 ? matched : null;
  }, [results, model]);

  return {
    term,
    setTerm,
    results,
    total,
    loading,
    error,
    matchedNodeIds,
    clear: () => {
      setTerm('');
    },
  };
}
