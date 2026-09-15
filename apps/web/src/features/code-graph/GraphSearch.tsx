import { useEffect, useRef, useState } from 'react';
import { searchNodes } from '../../api/graph.api.js';
import { errorMessage } from '../../hooks/useAsync.js';
import type { CodeNode } from '../../types/index.js';
import { nodeColor } from './graph-style.js';

const DEBOUNCE_MS = 200;

export interface GraphSearchProps {
  projectId: string;
  onSelect: (node: CodeNode) => void;
}

/** Symbol and file search. Selecting a result re-roots the traversal on it. */
export function GraphSearch({ projectId, onSelect }: GraphSearchProps): React.JSX.Element {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CodeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchNodes(projectId, trimmed, controller.signal)
        .then((nodes) => {
          if (controller.signal.aborted) return;
          setResults(nodes);
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
        placeholder="Search symbol or file"
        aria-label="Search symbol or file"
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
                onClick={() => {
                  choose(node);
                }}
              >
                <span className="search__dot" style={{ background: nodeColor(node.type) }} />
                <span className="search__name">{node.name}</span>
                <span className="search__meta">
                  {node.type}
                  {node.filePath ? ` · ${node.filePath}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
