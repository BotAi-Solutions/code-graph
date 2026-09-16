import { useEffect, useRef, useState } from 'react';
import { searchNodes } from '../../api/graph.api.js';
import { errorMessage } from '../../hooks/useAsync.js';
import type { CodeNode } from '../../types/index.js';
import { shortenPath } from '../../utils/format.js';
import { NODE_TYPE_LABELS, nodeColor, nodeFullName } from './graph-style.js';

const DEBOUNCE_MS = 200;
const PAGE_SIZE = 15;

export interface GraphSearchProps {
  projectId: string;
  onSelect: (node: CodeNode) => void;
}

/**
 * Search over symbols, members, files, directories, API routes and node types —
 * all of which the server matches against the same three columns, so one box
 * covers `UserService`, `UserService.getUser`, `user.service.ts`,
 * `src/services`, `POST /users` and `table`.
 *
 * Results are a page, not the whole match set, and the count says so: a search
 * that quietly truncates is a search that lies about what is in the graph.
 */
export function GraphSearch({ projectId, onSelect }: GraphSearchProps): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CodeNode[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setTotal(0);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchNodes(projectId, trimmed, { limit: PAGE_SIZE }, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setResults(page.nodes);
          setTotal(page.total);
          setError(null);
          setOpen(true);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(errorMessage(cause));
        });
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, term]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
    };
  }, []);

  const choose = (node: CodeNode): void => {
    onSelect(node);
    setOpen(false);
    setTerm(node.name);
  };

  return (
    <div className="search" ref={containerRef}>
      <input
        className="search__input"
        type="search"
        value={term}
        placeholder="Search symbol, file, route or type"
        aria-label="Search symbol, file, route or type"
        onChange={(event) => {
          setTerm(event.target.value);
        }}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
      />

      {open && (results.length > 0 || error) && (
        <ul className="search__results" role="listbox">
          {error && <li className="search__error">{error}</li>}

          {results.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="search__result"
                title={nodeFullName(node)}
                onClick={() => {
                  choose(node);
                }}
              >
                <span className="search__dot" style={{ background: nodeColor(node.type) }} />
                <span className="search__name">{nodeFullName(node)}</span>
                <span className="search__meta">
                  <span className="search__type">{NODE_TYPE_LABELS[node.type]}</span>
                  {node.filePath ? shortenPath(node.filePath, 30) : ''}
                </span>
              </button>
            </li>
          ))}

          {total > results.length && (
            <li className="search__more">
              showing {results.length} of {total} — narrow the term to see the rest
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
