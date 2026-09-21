import type { CodeNode, NodeDetail, RelatedNode } from '../../../types/index.js';
import {
  evidenceLocation,
  isRelated,
  relationshipSections,
} from '../model/retrieval.js';

/**
 * One node's detail, as sections that have something in them.
 *
 * Evidence is shown rather than summarised. Whether the graph's evidence is
 * good enough for an agent to reason from is the question this page was built
 * to answer, so a panel that reduced an edge to its relationship name would be
 * hiding exactly the thing under test.
 *
 * It lives in a narrow column, so a neighbour is a two-line row — name and
 * type, then where the claim came from — rather than one line that wraps in an
 * unpredictable place. "Trace to" is the row's own action and sits with it.
 */
export interface NodeInspectorProps {
  detail: NodeDetail;
  /** Follows a relationship: the neighbour becomes the inspected node. */
  onInspect: (node: CodeNode) => void;
  onTraceTo: (node: { id: string; label: string }) => void;
}

export function NodeInspector({
  detail,
  onInspect,
  onTraceTo,
}: NodeInspectorProps): React.JSX.Element {
  const sections = relationshipSections(detail);
  const { node, symbol } = detail;

  return (
    <div className="lab-node">
      <header className="lab-node__head">
        <h3 className="lab-node__name">{node.qualifiedName ?? node.name}</h3>
        <div className="lab-node__tags">
          <span className="badge-type">{node.type}</span>
          {symbol.role && <span className="badge-role">{symbol.role}</span>}
          {symbol.language && <span className="badge-role badge-role--muted">{symbol.language}</span>}
        </div>

        {node.filePath && (
          <p className="lab-node__file" title={node.filePath}>
            {node.filePath}
            {node.startLine === undefined ? '' : `:${String(node.startLine)}`}
          </p>
        )}

        {detail.parent && (
          <p className="lab-node__parent">
            Contained by <strong>{detail.parent.qualifiedName ?? detail.parent.name}</strong>
            <span className="lab-muted"> ({detail.parent.type})</span>
          </p>
        )}
      </header>

      {sections.length === 0 ? (
        <p className="lab-muted lab-node__none">
          This node has no recorded relationships. It exists in the graph, but nothing was derived
          connecting it to anything else.
        </p>
      ) : (
        sections.map((section) => (
          <section key={section.key} className="lab-rel">
            <h4 className="lab-rel__title">
              {section.label}
              <span className="lab-rel__count">{section.nodes.length}</span>
            </h4>
            <ul className="lab-rel__list">
              {section.nodes.map((neighbour) => (
                <li key={`${section.key}-${neighbour.id}`} className="lab-rel__item">
                  <div className="lab-rel__row">
                    <button
                      type="button"
                      className="lab-rel__link"
                      title="Inspect this node"
                      onClick={() => {
                        onInspect(neighbour);
                      }}
                    >
                      {neighbour.qualifiedName ?? neighbour.name}
                    </button>
                    <span className="badge-type badge-type--small">{neighbour.type}</span>
                    <button
                      type="button"
                      className="lab-rel__trace"
                      title="Trace a path from the inspected node to this one"
                      onClick={() => {
                        onTraceTo({
                          id: neighbour.id,
                          label: neighbour.qualifiedName ?? neighbour.name,
                        });
                      }}
                    >
                      Trace to
                    </button>
                  </div>

                  {isRelated(neighbour) && <Evidence node={neighbour} />}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/** The edge's own record of where the claim came from, shown as recorded. */
function Evidence({ node }: { node: RelatedNode }): React.JSX.Element {
  const location = evidenceLocation(node.evidence);

  return (
    <span className="lab-evidence">
      <span className="lab-evidence__rel">
        <span className="lab-evidence__dir" aria-hidden="true">
          {node.direction === 'incoming' ? '←' : '→'}
        </span>
        {node.relationship}
      </span>
      {node.evidence && (
        <>
          <span className={`confidence confidence--${node.evidence.confidence}`}>
            {node.evidence.confidence}
          </span>
          <span className="lab-evidence__source">{node.evidence.source}</span>
          {node.evidence.method && (
            <span className="lab-evidence__method">{node.evidence.method}</span>
          )}
          {location && <span className="lab-evidence__where">{location}</span>}
        </>
      )}
    </span>
  );
}
