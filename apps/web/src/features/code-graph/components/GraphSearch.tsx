import { useEffect, useRef, useState } from 'react';
import type { CodeNode } from '../../../types/index.js';
import { shortenPath } from '../../../utils/format.js';
import type { GraphSearchState } from '../hooks/useGraphSearch.js';
import { nodeFullName, nodeTypeLabel } from '../model/node-types.js';
import { nodeColor } from '../utils/graph-colors.js';

/**
 * One box over symbols, members, files, directories, routes and node types.
 *
 * The server matches all of those against the same three columns, so
 * `UserService`, `UserService.getUser`, `user.service.ts`, `src/services`,
 * `POST /users` and `table` all work here without a syntax to learn.
 *
 * Results are a page, and the footer says how big the match set really was: a
 * search that quietly truncates is a search that lies about what is in the
 * graph. A result already on the canvas is marked, because choosing it is then
 * a camera move rather than a fetch.
 */

export interface GraphSearchProps {
  search: GraphSearchState;
  /** Ids currently drawn, so an on-screen result can say so. */
  presentNodeIds: ReadonlySet<string>;
  onSelect: (node: CodeNode) => void;
}

export function GraphSearch({
  search,
  presentNodeIds,
  onSelect,
}: GraphSearchProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCursor(0);
  }, [search.results]);

  useEffect(() => {
    if (search.term.trim().length > 0) setOpen(true);
  }, [search.term]);

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
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (search.results.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setCursor((index) => (index + 1) % search.results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((index) => (index - 1 + search.results.length) % search.results.length);
    } else if (event.key === 'Enter') {
      const node = search.results[cursor];
      if (node) {
        event.preventDefault();
        choose(node);
      }
    }
  };

  return (
    <div className="search" ref={containerRef}>
      <input
        className="search__input"
        type="search"
        value={search.term}
        placeholder="Search symbol, file, module or route"
        aria-label="Search symbol, file, module or route"
        aria-expanded={open}
        onChange={(event) => {
          search.setTerm(event.target.value);
        }}
        onFocus={() => {
          if (search.results.length > 0) setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />

      {search.loading && <span className="search__spinner" aria-hidden="true" />}

      {open && (search.results.length > 0 || search.error) && (
        <ul className="search__results" role="listbox">
          {search.error && <li className="search__error">{search.error}</li>}

          {search.results.map((node, index) => (
            <li key={node.id}>
              <button
                type="button"
                className={`search__result${index === cursor ? ' search__result--cursor' : ''}`}
                title={nodeFullName(node)}
                onMouseEnter={() => {
                  setCursor(index);
                }}
                onClick={() => {
                  choose(node);
                }}
              >
                <span className="search__dot" style={{ background: nodeColor(node.type) }} />
                <span className="search__name">{nodeFullName(node)}</span>
                <span className="search__meta">
                  <span className="search__type">{nodeTypeLabel(node.type)}</span>
                  {node.filePath ? shortenPath(node.filePath, 28) : ''}
                  {presentNodeIds.has(node.id) && (
                    <span className="search__present" title="Already on the canvas">
                      on canvas
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}

          {search.total > search.results.length && (
            <li className="search__more">
              showing {search.results.length} of {search.total} — narrow the term to see the rest
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
