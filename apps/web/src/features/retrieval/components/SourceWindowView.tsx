import type { SourceWindow } from '../../../types/index.js';

/**
 * A window of source, with its lines numbered.
 *
 * The gutter is the point: someone validating retrieval needs to check that the
 * line the search reported is the line the code is on, and a bare block makes
 * that a counting exercise. The matched line is lit rather than merely present
 * for the same reason.
 *
 * The file name and range live in the pane's header rather than here — this
 * sits inside a pane that already has one, and a second title bar under the
 * first is the kind of nested chrome that makes a dense page unreadable.
 */
export interface SourceWindowViewProps {
  source: SourceWindow;
  /** The line the retrieval result pointed at, lit in the gutter. */
  activeLine?: number | null;
}

export function SourceWindowView({
  source,
  activeLine = null,
}: SourceWindowViewProps): React.JSX.Element {
  return (
    <div className="lab-source">
      {source.truncated && (
        <p className="lab-note lab-note--warn lab-note--inset">
          Source window truncated by the API — the requested range was wider than one response
          carries.
        </p>
      )}

      <pre className="lab-source__code">
        <code>
          {source.lines.map((line) => (
            <span
              key={line.line}
              className={`lab-source__line${line.line === activeLine ? ' lab-source__line--lit' : ''}`}
            >
              <span className="lab-source__gutter" aria-hidden="true">
                {line.line}
              </span>
              <span className="lab-source__text">{line.text === '' ? ' ' : line.text}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
