import { useCallback, useEffect, useState } from 'react';
import { Spinner } from '../../../components/index.js';
import { browseDirectories } from '../../../api/filesystem.api.js';
import { useAsync } from '../../../hooks/useAsync.js';
import type { SelectedDirectory } from '../../../types/index.js';

/**
 * The way in when there is no native dialog.
 *
 * A container, a remote machine or a bare Linux desktop has no folder dialog to
 * open, and "there is no picker, sorry" is not an answer. So the API serves
 * directory listings and this walks them — the same read-only boundary, drawn
 * in the app instead of by the OS.
 *
 * It lists directories and never files. That is the API's rule, not a display
 * choice, and it is why this cannot become a way to browse someone's documents.
 */

export interface DirectoryBrowserProps {
  /** Why the native dialog was not used. Shown once, quietly. */
  reason: string | null;
  onSelect: (directory: SelectedDirectory) => void;
  onClose: () => void;
}

export function DirectoryBrowser({
  reason,
  onSelect,
  onClose,
}: DirectoryBrowserProps): React.JSX.Element {
  // Null means "wherever the API starts you", which is the home directory of
  // whoever is running it.
  const [path, setPath] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const listing = useAsync(
    (signal) => browseDirectories(path ?? undefined, signal),
    [path],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const choose = useCallback(
    (directoryPath: string, name: string) => {
      onSelect({ path: directoryPath, name });
    },
    [onSelect],
  );

  const current = listing.data;

  return (
    <div
      className="browser__scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="browser" role="dialog" aria-modal="true" aria-label="Choose a project folder">
        <header className="browser__header">
          <h2 className="browser__title">Choose a project folder</h2>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Close
          </button>
        </header>

        {reason && <p className="browser__reason">{reason}</p>}

        <div className="browser__bar">
          <button
            type="button"
            className="button button--quiet"
            disabled={!current?.parentPath}
            onClick={() => {
              if (current?.parentPath) setPath(current.parentPath);
            }}
          >
            ↑ Up
          </button>
          <span className="browser__path" title={current?.path ?? ''}>
            {current?.path ?? '…'}
          </span>
          {listing.loading && <Spinner label="Reading directory" />}
        </div>

        {listing.error ? (
          <p className="browser__error">{listing.error}</p>
        ) : (
          <ul className="browser__list">
            {current?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={`browser__entry${entry.isProjectRoot ? ' browser__entry--project' : ''}`}
                  // One click opens the folder; "Use this folder" chooses the
                  // one you are in. Two gestures, no double-click to discover.
                  onClick={() => {
                    setPath(entry.path);
                  }}
                >
                  <span className="browser__entry-name">
                    <span aria-hidden="true">{entry.isProjectRoot ? '📦' : '📁'}</span>
                    {entry.name}
                  </span>
                  {entry.isProjectRoot && <span className="browser__badge">project</span>}
                </button>
              </li>
            ))}
            {current?.entries.length === 0 && (
              <li className="browser__empty">No subdirectories here.</li>
            )}
          </ul>
        )}

        {current?.truncated && (
          <p className="browser__note">
            This directory has more entries than are shown. Type its path below to go straight to
            the one you want.
          </p>
        )}

        <footer className="browser__footer">
          <form
            className="browser__jump"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = typed.trim();
              if (trimmed) setPath(trimmed);
            }}
          >
            <input
              className="field__control"
              value={typed}
              placeholder="Go to a path…"
              aria-label="Go to a path"
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
            <button type="submit" className="button">
              Go
            </button>
          </form>

          <button
            type="button"
            className="button button--primary"
            disabled={!current}
            onClick={() => {
              if (current) choose(current.path, basename(current.path));
            }}
          >
            Use this folder
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Last path segment, for either separator. */
function basename(directoryPath: string): string {
  const segments = directoryPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? directoryPath;
}
