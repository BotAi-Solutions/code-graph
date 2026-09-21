import type { GraphPath } from '../../../types/index.js';
import { pathRows } from '../../code-graph/model/navigation.js';
import { evidenceLocation, traceVerdict } from '../model/retrieval.js';

/**
 * Tracing between two nodes, and reading the answer correctly.
 *
 * The result has three outcomes, not two, and the third is why this panel is
 * careful: a search that spent its budget is *inconclusive*, and rendering that
 * as "no path" would teach the wrong thing on a page built to check what
 * retrieval really says.
 *
 * The endpoints stack rather than sit side by side: they hold qualified names,
 * which are long, and a column that truncated both of them would leave the one
 * question this panel answers — which two nodes — unanswerable.
 */
export interface TracePanelProps {
  from: { id: string; label: string } | null;
  to: { id: string; label: string } | null;
  maxDepth: number;
  onMaxDepth: (value: number) => void;
  onSwap: () => void;
  onTrace: () => void;
  loading: boolean;
  error: string | null;
  code: string | null;
  path: GraphPath | null;
}

export function TracePanel({
  from,
  to,
  maxDepth,
  onMaxDepth,
  onSwap,
  onTrace,
  loading,
  error,
  code,
  path,
}: TracePanelProps): React.JSX.Element {
  const ready = from !== null && to !== null;

  return (
    <div className="lab-trace">
      <div className="lab-trace__ends">
        <Endpoint label="From" node={from} />
        <button
          type="button"
          className="lab-trace__swap"
          disabled={!ready}
          title="Swap the endpoints"
          aria-label="Swap the endpoints"
          onClick={onSwap}
        >
          ⇅
        </button>
        <Endpoint label="To" node={to} />
      </div>

      <div className="lab-trace__controls">
        <label className="field field--inline">
          <span className="field__label">Max depth</span>
          <input
            className="field__control field__control--tiny"
            type="number"
            min={1}
            max={12}
            value={maxDepth}
            onChange={(event) => {
              onMaxDepth(Number(event.target.value));
            }}
          />
        </label>

        <button
          type="button"
          className="button button--primary"
          disabled={!ready || loading}
          onClick={onTrace}
        >
          {loading ? 'Tracing…' : 'Trace'}
        </button>
      </div>

      {!ready && (
        <p className="lab-muted">
          Pick two nodes. Inspect a node to set <em>From</em>, then use “Trace to” on one of its
          relationships to set <em>To</em>.
        </p>
      )}

      {error !== null && (
        <div className="lab-error">
          <p className="lab-error__title">Unable to trace path</p>
          <p className="lab-error__body">{error}</p>
          {code !== null && <code className="lab-error__code">{code}</code>}
        </div>
      )}

      {path && error === null && <TraceResult path={path} maxDepth={maxDepth} />}
    </div>
  );
}

function Endpoint({
  label,
  node,
}: {
  label: string;
  node: { id: string; label: string } | null;
}): React.JSX.Element {
  return (
    <div className={`lab-trace__end${node ? '' : ' lab-trace__end--unset'}`}>
      <span className="lab-trace__end-label">{label}</span>
      <span className={`lab-trace__end-value${node ? '' : ' lab-muted'}`} title={node?.id}>
        {node?.label ?? 'not set'}
      </span>
    </div>
  );
}

function TraceResult({ path, maxDepth }: { path: GraphPath; maxDepth: number }): React.JSX.Element {
  const verdict = traceVerdict(path, maxDepth);
  const rows = pathRows(path);

  return (
    <div className="lab-trace__result">
      <p className={`lab-verdict lab-verdict--${verdict.outcome}`}>
        <strong>{verdict.title}</strong>
        {verdict.outcome === 'found' && path.depth > 0 && (
          <span className="lab-muted">
            {' '}
            · {path.depth} hop{path.depth === 1 ? '' : 's'}
          </span>
        )}
      </p>

      {verdict.body !== null && <p className="lab-note">{verdict.body}</p>}

      {rows.length > 0 && (
        <ol className="lab-chain">
          {rows.map((row) => (
            <li key={row.node.id}>
              <div className="lab-chain__node">
                <span className="lab-chain__name">{row.node.qualifiedName ?? row.node.name}</span>
                <span className="badge-type badge-type--small">{row.node.type}</span>
                {row.node.filePath && (
                  <span className="lab-chain__file">{row.node.filePath}</span>
                )}
              </div>

              {row.step && (
                <div className="lab-chain__hop">
                  <span className="lab-chain__rel">
                    {row.step.relationship}
                    {row.step.reversed ? ' (against direction)' : ''}
                  </span>
                  {row.step.evidence && (
                    <span className="lab-evidence">
                      <span className={`confidence confidence--${row.step.evidence.confidence}`}>
                        {row.step.evidence.confidence}
                      </span>
                      <span className="lab-evidence__source">{row.step.evidence.source}</span>
                      {evidenceLocation(row.step.evidence) !== null && (
                        <span className="lab-evidence__where">
                          {evidenceLocation(row.step.evidence)}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
