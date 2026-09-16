import { useEffect, useRef } from 'react';
import type { SourceWindow } from '../../../types/index.js';
import type { SourceViewState } from '../hooks/useSourceView.js';
import { isHighlighted } from '../model/navigation.js';

/**
 * The source band under the canvas.
 *
 * It exists only while something is open: the graph is the product, and a
 * permanently reserved strip of source would cost the canvas a fifth of its
 * height to show nothing most of the time.
 *
 * Two things make it a navigation surface rather than a text dump. The
 * highlighted range is the symbol the graph pointed at — scrolled to, not
 * merely coloured — so arriving here lands on the line you asked about. And the
 * header says which file and which lines out of how many, because a window onto
 * a file that does not say it is a window reads as a truncated file.
 */

export interface SourcePanelProps {
  view: SourceViewState;
  /** Focuses the corresponding node on the canvas, when the window has one. */
  onFocusNode?: ((nodeId: string) => void) | undefined;
}

export function SourcePanel({ view, onFocusNode }: SourcePanelProps): React.JSX.Element | null {
  if (!view.open) return null;

  const title = view.source?.file ?? view.target?.file ?? view.target?.label ?? 'Source';
  const highlightNodeId = view.source?.highlight?.nodeId ?? null;

  return (
    <section className="source" aria-label="Source">
      <header className="source__head">
        <span className="source__file" title={title}>
          {title}
        </span>

        {view.source && <SourceRange source={view.source} />}

        <div className="source__spacer" />

        {view.loading && <span className="source__spinner" aria-hidden="true" />}

        {highlightNodeId && onFocusNode && (
          <button
            type="button"
            className="button button--quiet"
            title="Show this symbol on the graph"
            onClick={() => {
              onFocusNode(highlightNodeId);
            }}
          >
            Focus graph
          </button>
        )}

        <button type="button" className="button button--quiet" onClick={view.close}>
          Close
        </button>
      </header>

      {view.error ? (
        <div className="source__message source__message--error">
          <p>{view.error}</p>
          <button type="button" className="button" onClick={view.reload}>
            Retry
          </button>
        </div>
      ) : view.source ? (
        <SourceLines source={view.source} />
      ) : (
        <div className="source__message">
          <p>Loading source…</p>
        </div>
      )}
    </section>
  );
}

function SourceRange({ source }: { source: SourceWindow }): React.JSX.Element {
  const whole = source.startLine === 1 && source.endLine === source.totalLines;

  return (
    <span className="source__range">
      {whole
        ? `${String(source.totalLines)} lines`
        : `lines ${String(source.startLine)}–${String(source.endLine)} of ${String(
            source.totalLines,
          )}`}
      {source.truncated && (
        <span className="source__truncated" title="The requested range was larger than one response">
          truncated
        </span>
      )}
    </span>
  );
}

function SourceLines({ source }: { source: SourceWindow }): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const firstHighlighted = useRef<HTMLDivElement>(null);

  const highlight = source.highlight;

  // Scrolling to the symbol is the whole point of arriving here from the graph.
  // `block: 'center'` rather than `'start'` so the line lands with its context
  // around it instead of pinned under the header.
  useEffect(() => {
    if (!highlight || !firstHighlighted.current) return;
    firstHighlighted.current.scrollIntoView({ block: 'center' });
  }, [highlight, source.file, source.startLine]);

  let seenFirst = false;

  return (
    <div className="source__body" ref={scroller}>
      <pre className="source__code">
        {source.lines.map((line) => {
          const lit = isHighlighted(highlight, line.line);

          const first = lit && !seenFirst;
          if (first) seenFirst = true;

          return (
            <div
              key={line.line}
              className={`source__line${lit ? ' source__line--lit' : ''}`}
              ref={first ? firstHighlighted : undefined}
            >
              <span className="source__gutter" aria-hidden="true">
                {line.line}
              </span>
              {/* A space keeps an empty line from collapsing to zero height,
                  which would make the gutter numbers stop lining up. */}
              <span className="source__text">{line.text === '' ? ' ' : line.text}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
