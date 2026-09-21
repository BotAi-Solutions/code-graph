import { useState } from 'react';
import { callStatusLabel, formatCall, type RetrievalCall } from '../model/retrieval.js';

/**
 * What the page actually sent.
 *
 * On a debugging surface this is not a nicety: "does the UI send the query I
 * typed, unmodified" is one of the things this page exists to answer, and the
 * only honest way to answer it is to show the request. Collapsed by default so
 * it stays out of the way until it is wanted.
 */
export function RequestInspector({
  calls,
  onClear,
}: {
  calls: RetrievalCall[];
  onClear: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <section className="lab-inspector">
      <header className="lab-inspector__head">
        <button
          type="button"
          className="lab-inspector__toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <span className="lab-inspector__caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          Retrieval requests
          <span className="lab-inspector__count">{calls.length}</span>
        </button>

        {open && calls.length > 0 && (
          <button type="button" className="button button--quiet" onClick={onClear}>
            Clear
          </button>
        )}
      </header>

      {open && (
        <div className="lab-inspector__body">
          {calls.length === 0 ? (
            <p className="lab-muted">No requests yet. Run a search to see what is sent.</p>
          ) : (
            <ol className="lab-inspector__list">
              {calls.map((call, index) => (
                <li key={`${call.url}-${String(index)}`} className="lab-inspector__item">
                  <pre className="lab-inspector__request">{formatCall(call).join('\n')}</pre>
                  <span
                    className={`lab-inspector__status${call.error ? ' lab-inspector__status--error' : ''}`}
                  >
                    {callStatusLabel(call)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
