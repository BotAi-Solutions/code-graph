import type {
  CodeEdge,
  CodeNode,
  ConfidenceLevel,
  NodeDetail,
  RelatedNode,
} from '../../types/index.js';
import { edgeEvidence } from '../../types/index.js';
import { shortenPath } from '../../utils/format.js';
import {
  NODE_TYPE_LABELS,
  nodeColor,
  nodeFullName,
  nodeLabel,
  relationshipColor,
} from './graph-style.js';

/**
 * Details for whatever is selected.
 *
 * Everything shown comes from the API — the inspector never derives facts from
 * the canvas — and a section with nothing in it is not rendered at all, so the
 * panel is a description of this node rather than a form with empty fields.
 */

export interface NodeInspectorProps {
  detail: NodeDetail | null;
  selectedEdge: {
    edge: CodeEdge;
    source: CodeNode | undefined;
    target: CodeNode | undefined;
  } | null;
  loading: boolean;
  error: string | null;
  /** Absolute path of the analysed working tree, when we know it. */
  repositoryPath: string | null;
  expanded: boolean;
  onSelectNode: (nodeId: string) => void;
  onExpand: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
  onFindReferences: (nodeId: string) => void;
}

function lineRange(node: CodeNode): string {
  if (node.startLine === undefined) return '—';
  if (node.endLine === undefined || node.endLine === node.startLine) return String(node.startLine);
  return `${String(node.startLine)}–${String(node.endLine)}`;
}

/** A `vscode://` link to the exact line, when the repository is on this disk. */
function editorLink(repositoryPath: string | null, node: CodeNode): string | null {
  if (!repositoryPath || !node.filePath) return null;
  // A relative source path was resolved against the server's workspace root,
  // not the browser's, so there is no absolute path to open.
  if (!repositoryPath.startsWith('/')) return null;

  const line = node.startLine ?? 1;
  const column = (node.startCharacter ?? 0) + 1;
  return `vscode://file${repositoryPath}/${node.filePath}:${String(line)}:${String(column)}`;
}

function TypeBadge({ node }: { node: CodeNode }): React.JSX.Element {
  return (
    <span className="badge-type" style={{ borderColor: nodeColor(node.type) }}>
      <span className="badge-type__dot" style={{ background: nodeColor(node.type) }} />
      {NODE_TYPE_LABELS[node.type]}
    </span>
  );
}

function ConfidenceMark({ level }: { level: ConfidenceLevel | undefined }): React.JSX.Element | null {
  if (!level || level === 'high') return null;
  return (
    <span className={`confidence confidence--${level}`} title={`${level} confidence`}>
      {level}
    </span>
  );
}

function NodeList({
  title,
  nodes,
  onSelectNode,
}: {
  title: string;
  nodes: CodeNode[];
  onSelectNode: (nodeId: string) => void;
}): React.JSX.Element | null {
  if (nodes.length === 0) return null;

  return (
    <section className="inspector__section">
      <h3 className="inspector__heading">
        {title} <span className="inspector__count">{nodes.length}</span>
      </h3>
      <ul className="inspector__list">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              className="inspector__link"
              title={nodeFullName(node)}
              onClick={() => {
                onSelectNode(node.id);
              }}
            >
              <span className="swatch" style={{ background: nodeColor(node.type) }} />
              <span className="inspector__link-name">{nodeFullName(node)}</span>
              <span className="inspector__link-meta">
                {node.filePath ? shortenPath(node.filePath, 28) : NODE_TYPE_LABELS[node.type]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A section whose entries carry the relationship that produced them. */
function RelatedList({
  title,
  nodes,
  onSelectNode,
}: {
  title: string;
  nodes: RelatedNode[];
  onSelectNode: (nodeId: string) => void;
}): React.JSX.Element | null {
  if (nodes.length === 0) return null;

  return (
    <section className="inspector__section">
      <h3 className="inspector__heading">
        {title} <span className="inspector__count">{nodes.length}</span>
      </h3>
      <ul className="inspector__list">
        {nodes.map((node) => (
          <li key={`${node.id}-${node.relationship}`}>
            <button
              type="button"
              className="inspector__link"
              title={`${node.relationship} — ${nodeFullName(node)}${
                node.evidenceSource ? ` (${node.evidenceSource})` : ''
              }`}
              onClick={() => {
                onSelectNode(node.id);
              }}
            >
              <span className="swatch" style={{ background: nodeColor(node.type) }} />
              <span className="inspector__link-name">{nodeFullName(node)}</span>
              <span className="inspector__link-meta">
                <span
                  className="inspector__relationship"
                  style={{ color: relationshipColor(node.relationship) }}
                >
                  {node.relationship}
                </span>
                <ConfidenceMark level={node.confidence} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NodeInspector(props: NodeInspectorProps): React.JSX.Element {
  if (props.selectedEdge) {
    const { edge, source, target } = props.selectedEdge;
    const evidence = edgeEvidence(edge);

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
          <dd>{source ? nodeFullName(source) : edge.sourceNodeId}</dd>
          <dt>To</dt>
          <dd>{target ? nodeFullName(target) : edge.targetNodeId}</dd>
          {evidence && (
            <>
              <dt>Evidence</dt>
              <dd>
                {evidence.source} <ConfidenceMark level={evidence.confidence} />
              </dd>
            </>
          )}
          {edge.metadata?.occurrences !== undefined && (
            <>
              <dt>Occurrences</dt>
              <dd>{String(edge.metadata.occurrences)}</dd>
            </>
          )}
          {edge.metadata?.statement !== undefined && (
            <>
              <dt>Statement</dt>
              <dd>{String(edge.metadata.statement)}</dd>
            </>
          )}
          {edge.metadata?.via !== undefined && (
            <>
              <dt>Found via</dt>
              <dd>{String(edge.metadata.via)}</dd>
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
          Click a node to inspect it. Double-click to pull in its neighbours.
        </p>
      </aside>
    );
  }

  const { node, callers, callees, references, dependencies, dependents, apis, databases } =
    props.detail;

  const link = editorLink(props.repositoryPath, node);
  const role = typeof node.metadata?.role === 'string' ? node.metadata.role : null;

  return (
    <aside className="inspector">
      <h2 className="inspector__title" title={nodeFullName(node)}>
        <span className="swatch" style={{ background: nodeColor(node.type) }} />
        {nodeLabel(node)}
      </h2>

      <div className="inspector__badges">
        <TypeBadge node={node} />
        {role && (
          <span
            className="badge-role"
            title={
              typeof node.metadata?.roleEvidence === 'string'
                ? `Classified as ${role}: ${node.metadata.roleEvidence}`
                : undefined
            }
          >
            {role}
          </span>
        )}
        {props.expanded && <span className="badge-role badge-role--muted">expanded</span>}
      </div>

      <dl className="inspector__facts">
        {node.qualifiedName && node.qualifiedName !== node.name && (
          <>
            <dt>Name</dt>
            <dd className="inspector__mono">{node.qualifiedName}</dd>
          </>
        )}
        <dt>File</dt>
        <dd title={node.filePath}>{node.filePath ?? '—'}</dd>
        {node.startLine !== undefined && (
          <>
            <dt>Lines</dt>
            <dd>{lineRange(node)}</dd>
          </>
        )}
        {node.type === 'api' && node.metadata?.httpMethod !== undefined && (
          <>
            <dt>Route</dt>
            <dd className="inspector__mono">
              {String(node.metadata.httpMethod)} {String(node.metadata.path ?? '')}
            </dd>
            <dt>Framework</dt>
            <dd>{String(node.metadata.framework ?? 'unknown')}</dd>
          </>
        )}
        {node.metadata?.provider !== undefined && (
          <>
            <dt>Provider</dt>
            <dd>{String(node.metadata.provider)}</dd>
          </>
        )}
        {node.metadata?.vendor !== undefined && (
          <>
            <dt>Vendor</dt>
            <dd>
              {String(node.metadata.vendor)}
              {node.metadata.host !== undefined ? ` · ${String(node.metadata.host)}` : ''}
              {node.metadata.package !== undefined ? ` · ${String(node.metadata.package)}` : ''}
            </dd>
          </>
        )}
        {Array.isArray(node.metadata?.frameworks) && node.metadata.frameworks.length > 0 && (
          <>
            <dt>Frameworks</dt>
            <dd>{node.metadata.frameworks.map(String).join(', ')}</dd>
          </>
        )}
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

      <div className="inspector__actions">
        {link ? (
          <a className="button" href={link} title={`Open ${node.filePath ?? ''} in your editor`}>
            Open source
          </a>
        ) : (
          node.filePath && (
            <button
              type="button"
              className="button"
              title="Copy the file path"
              onClick={() => {
                void navigator.clipboard?.writeText(
                  node.startLine === undefined
                    ? (node.filePath as string)
                    : `${node.filePath as string}:${String(node.startLine)}`,
                );
              }}
            >
              Copy path
            </button>
          )
        )}
        <button
          type="button"
          className="button"
          title="Pull this node's neighbours onto the canvas"
          onClick={() => {
            props.onExpand(node.id);
          }}
        >
          Expand
        </button>
        <button
          type="button"
          className="button"
          title="Start a new traversal from this node"
          onClick={() => {
            props.onFocus(node.id);
          }}
        >
          Focus
        </button>
        <button
          type="button"
          className="button"
          title="Everything that points at this node"
          onClick={() => {
            props.onFindReferences(node.id);
          }}
        >
          Find references
        </button>
      </div>

      <NodeList title="Calls" nodes={callees} onSelectNode={props.onSelectNode} />
      <NodeList title="Called by" nodes={callers} onSelectNode={props.onSelectNode} />
      <NodeList title="References" nodes={references} onSelectNode={props.onSelectNode} />
      <RelatedList title="APIs" nodes={apis} onSelectNode={props.onSelectNode} />
      <RelatedList title="Data" nodes={databases} onSelectNode={props.onSelectNode} />
      <RelatedList title="Depends on" nodes={dependencies} onSelectNode={props.onSelectNode} />
      <RelatedList title="Depended on by" nodes={dependents} onSelectNode={props.onSelectNode} />

      {callers.length === 0 &&
        callees.length === 0 &&
        references.length === 0 &&
        apis.length === 0 &&
        databases.length === 0 &&
        dependencies.length === 0 &&
        dependents.length === 0 && (
          <p className="inspector__empty">Nothing else in the graph touches this node.</p>
        )}
    </aside>
  );
}
