import type { CodeEdge, CodeNode, NodeDetail } from '../../types/index.js';
import { nodeColor, relationshipColor } from './graph-style.js';

export interface NodeInspectorProps {
  detail: NodeDetail | null;
  selectedEdge: { edge: CodeEdge; source: CodeNode | undefined; target: CodeNode | undefined } | null;
  loading: boolean;
  error: string | null;
  onSelectNode: (nodeId: string) => void;
  onExpand: (nodeId: string) => void;
}

function lineRange(node: CodeNode): string {
  if (node.startLine === undefined) return '—';
  if (node.endLine === undefined || node.endLine === node.startLine) return String(node.startLine);
  return `${String(node.startLine)}–${String(node.endLine)}`;
}

function NodeList({
  title,
  nodes,
  onSelectNode,
}: {
  title: string;
  nodes: CodeNode[];
  onSelectNode: (nodeId: string) => void;
}): React.JSX.Element {
  return (
    <section className="inspector__section">
      <h3 className="inspector__heading">
        {title} <span className="inspector__count">{nodes.length}</span>
      </h3>
      {nodes.length === 0 ? (
        <p className="inspector__empty">none</p>
      ) : (
        <ul className="inspector__list">
          {nodes.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="inspector__link"
                onClick={() => {
                  onSelectNode(node.id);
                }}
              >
                <span className="swatch" style={{ background: nodeColor(node.type) }} />
                <span className="inspector__link-name">{node.name}</span>
                <span className="inspector__link-meta">{node.filePath ?? node.type}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Details for whatever is selected. Everything shown comes from the API — the
 * inspector never derives facts from the canvas.
 */
export function NodeInspector(props: NodeInspectorProps): React.JSX.Element {
  if (props.selectedEdge) {
    const { edge, source, target } = props.selectedEdge;
    return (
      <aside className="inspector">
        <h2 className="inspector__title">Selected edge</h2>
        <dl className="inspector__facts">
          <dt>Relationship</dt>
          <dd>
            <span
              className="legend__line"
              style={{ color: relationshipColor(edge.relationship) }}
            />
            {edge.relationship}
          </dd>
          <dt>From</dt>
          <dd>{source ? `${source.type} ${source.name}` : edge.sourceNodeId}</dd>
          <dt>To</dt>
          <dd>{target ? `${target.type} ${target.name}` : edge.targetNodeId}</dd>
          {edge.metadata?.occurrences !== undefined && (
            <>
              <dt>Occurrences</dt>
              <dd>{String(edge.metadata.occurrences)}</dd>
            </>
          )}
          {edge.metadata?.derived === true && (
            <>
              <dt>Derived</dt>
              <dd>Summarises edges between members of these containers</dd>
            </>
          )}
        </dl>
      </aside>
    );
  }

  if (props.loading) {
    return (
      <aside className="inspector">
        <p className="inspector__empty">Loading node…</p>
      </aside>
    );
  }

  if (props.error) {
    return (
      <aside className="inspector">
        <p className="inspector__error">{props.error}</p>
      </aside>
    );
  }

  if (!props.detail) {
    return (
      <aside className="inspector">
        <h2 className="inspector__title">No selection</h2>
        <p className="inspector__empty">
          Click a node to inspect it. Double-click to re-root the traversal there.
        </p>
      </aside>
    );
  }

  const { node, callers, callees, references } = props.detail;

  return (
    <aside className="inspector">
      <h2 className="inspector__title">
        <span className="swatch" style={{ background: nodeColor(node.type) }} />
        {node.name}
      </h2>

      <dl className="inspector__facts">
        <dt>Type</dt>
        <dd>{node.type}</dd>
        <dt>File</dt>
        <dd title={node.filePath}>{node.filePath ?? '—'}</dd>
        <dt>Line</dt>
        <dd>{lineRange(node)}</dd>
        {node.metadata?.scipSymbol !== undefined && (
          <>
            <dt>SCIP symbol</dt>
            <dd className="inspector__mono">{String(node.metadata.scipSymbol)}</dd>
          </>
        )}
        {node.metadata?.language !== undefined && (
          <>
            <dt>Language</dt>
            <dd>{String(node.metadata.language)}</dd>
          </>
        )}
      </dl>

      <button
        type="button"
        className="button button--full"
        onClick={() => {
          props.onExpand(node.id);
        }}
      >
        Traverse from this node
      </button>

      <NodeList title="Callers" nodes={callers} onSelectNode={props.onSelectNode} />
      <NodeList title="Callees" nodes={callees} onSelectNode={props.onSelectNode} />
      <NodeList title="References" nodes={references} onSelectNode={props.onSelectNode} />
    </aside>
  );
}
