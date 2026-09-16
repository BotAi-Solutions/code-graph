import { useMemo } from 'react';
import type {
  CodeNode,
  ConfidenceLevel,
  NodeDetail,
  RelatedNode,
  SymbolInfo,
} from '../../../types/index.js';
import { edgeEvidence } from '../../../types/index.js';
import { shortenPath } from '../../../utils/format.js';
import type { CodeGraphModel, GraphEdge, GraphNode } from '../model/graph-types.js';
import { nodeFullName, nodeLabel, nodeTypeLabel } from '../model/node-types.js';
import { relationshipColor } from '../model/edge-types.js';
import { nodeColor } from '../utils/graph-colors.js';
import { FOCUS_DEPTHS } from '../hooks/useGraphFocus.js';

/**
 * Everything about the selection.
 *
 * Two sources, kept visibly distinct. Most of the panel comes from the API in
 * one round trip and describes the *repository*: the callers of a method are
 * its callers whether or not they are on screen. A small part — members, and
 * the connection counts in the summary — is derived from the graph that is
 * drawn, and is labelled "in this view" wherever it appears, because a count
 * that silently means two different things depending on the section is worse
 * than no count.
 *
 * A section with nothing in it is not rendered, so the panel reads as a
 * description of this node rather than as a form with empty fields.
 *
 * It renders as a block, not as a landmark: it is one band inside the
 * workspace's sidebar, and the sidebar is the `<aside>`. Two nested asides
 * would be two landmarks describing one region.
 */

export interface GraphInspectorProps {
  model: CodeGraphModel;
  node: GraphNode | null;
  detail: NodeDetail | null;
  selectedEdge: { edge: GraphEdge; source: GraphNode | null; target: GraphNode | null } | null;
  loading: boolean;
  error: string | null;
  /** Absolute path of the analysed working tree, when we know it. */
  repositoryPath: string | null;
  expanded: boolean;
  focused: boolean;
  focusDepth: number;
  onSelectNode: (nodeId: string) => void;
  /** Opens the source viewer at this node's indexed range. */
  onOpenSource: (nodeId: string) => void;
  onExpand: (nodeId: string, depth: number) => void;
  onToggleFocus: (nodeId: string) => void;
  onChangeFocusDepth: (depth: number) => void;
  onReroot: (nodeId: string) => void;
  onFindReferences: (nodeId: string) => void;
  onPathFrom: (nodeId: string) => void;
  onPathTo: (nodeId: string) => void;
}

export function GraphInspector(props: GraphInspectorProps): React.JSX.Element {
  if (props.selectedEdge) return <EdgeInspector {...props.selectedEdge} />;

  if (props.loading && !props.detail) {
    return (
      <div className="inspector">
        <p className="inspector__empty">Loading node…</p>
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="inspector">
        <p className="inspector__error">{props.error}</p>
      </div>
    );
  }

  if (!props.detail || !props.node) {
    return (
      <div className="inspector">
        <h2 className="inspector__title">No selection</h2>
        <p className="inspector__empty">
          Click a node to inspect it. Double-click to pull in its neighbours.
        </p>
        <p className="inspector__empty">
          Zooming out shows architecture; zooming in reveals symbols.
        </p>
      </div>
    );
  }

  return <NodeBody {...props} node={props.node} detail={props.detail} />;
}

function NodeBody({
  model,
  node,
  detail,
  repositoryPath,
  expanded,
  focused,
  focusDepth,
  onSelectNode,
  onOpenSource,
  onExpand,
  onToggleFocus,
  onChangeFocusDepth,
  onReroot,
  onFindReferences,
  onPathFrom,
  onPathTo,
}: GraphInspectorProps & { node: GraphNode; detail: NodeDetail }): React.JSX.Element {
  const source = detail.node;
  const symbol = detail.symbol;
  const definition = detail.definition;
  const link = editorLink(repositoryPath, source);

  /** What this node contains, according to the graph on screen. */
  const members = useMemo(() => {
    const contained: GraphNode[] = [];
    for (const edge of model.edges) {
      if (edge.type !== 'CONTAINS' || edge.source !== node.id) continue;
      const member = model.nodesById.get(edge.target);
      if (member) contained.push(member);
    }
    return contained.sort((a, b) => b.metrics.importance - a.metrics.importance);
  }, [model, node.id]);

  const architecture = [...detail.apis, ...detail.databases];

  const nothingElse =
    detail.callers.length === 0 &&
    detail.callees.length === 0 &&
    detail.references.length === 0 &&
    architecture.length === 0 &&
    detail.dependencies.length === 0 &&
    detail.dependents.length === 0 &&
    detail.implementations.length === 0 &&
    detail.children.length === 0 &&
    members.length === 0;

  /** True when the indexer gave this node a place in a file to open. */
  const hasSource = definition?.filePath != null;

  return (
    <div className="inspector">
      <h2 className="inspector__title" title={node.fullLabel}>
        <span className="swatch" style={{ background: nodeColor(node.type) }} />
        {nodeLabel(source)}
      </h2>

      <div className="inspector__badges">
        <span className="badge-type" style={{ borderColor: nodeColor(node.type) }}>
          <span className="badge-type__dot" style={{ background: nodeColor(node.type) }} />
          {nodeTypeLabel(node.type)}
        </span>
        {node.role && (
          <span
            className="badge-role"
            title={
              typeof node.metadata.roleEvidence === 'string'
                ? `Classified as ${node.role}: ${node.metadata.roleEvidence}`
                : undefined
            }
          >
            {node.role}
          </span>
        )}
        {node.entryPoint && (
          <span className="badge-role" title="Where execution enters the system">
            entry point
          </span>
        )}
        {node.external && (
          <span className="badge-role badge-role--muted" title="Outside this repository">
            external
          </span>
        )}
        {expanded && <span className="badge-role badge-role--muted">expanded</span>}
      </div>

      {/* The definition line: where this symbol is written, and a way there.
          It is a button rather than a caption because "file:line" is the one
          thing on this panel a reader always wants to act on. */}
      {hasSource ? (
        <button
          type="button"
          className="inspector__definition"
          title={`Open ${definition?.filePath ?? ''}`}
          onClick={() => {
            onOpenSource(node.id);
          }}
        >
          <span className="inspector__definition-path">{definition?.filePath}</span>
          {definition?.startLine != null && (
            <span className="inspector__definition-line">:{definition.startLine}</span>
          )}
        </button>
      ) : (
        source.filePath && (
          <p className="inspector__path" title={source.filePath}>
            {source.filePath}
          </p>
        )
      )}

      {symbol.qualifiedName && symbol.qualifiedName !== symbol.name && (
        <p className="inspector__qualified" title={symbol.qualifiedName}>
          {symbol.qualifiedName}
        </p>
      )}

      <div className="inspector__metrics" title="Counted over the graph currently drawn">
        <Metric value={node.metrics.dependencies} label="dependencies" />
        <Metric value={node.metrics.dependents} label="dependents" />
        <Metric value={node.metrics.degree} label="connections" />
        <Metric
          value={Math.round(node.metrics.importance * 100)}
          label="importance"
          suffix="%"
          title="Degree, centrality, node type and entry-point status, combined"
        />
      </div>

      <div className="inspector__actions">
        <button
          type="button"
          className="button"
          disabled={!hasSource}
          title={hasSource ? 'Read this symbol where it is written' : 'No indexed source for this node'}
          onClick={() => {
            onOpenSource(node.id);
          }}
        >
          Open source
        </button>
        <button
          type="button"
          className={`button${focused ? ' button--active' : ''}`}
          title="Show only this node and its neighbourhood"
          aria-pressed={focused}
          onClick={() => {
            onToggleFocus(node.id);
          }}
        >
          Focus graph
        </button>
        <button
          type="button"
          className="button"
          title="Pull this node's neighbours onto the canvas"
          onClick={() => {
            onExpand(node.id, 1);
          }}
        >
          Expand 1 hop
        </button>
        <button
          type="button"
          className="button"
          title="Pull in everything within two hops"
          onClick={() => {
            onExpand(node.id, 2);
          }}
        >
          Expand 2 hops
        </button>
        <button
          type="button"
          className="button"
          title="Everything that points at this node, whatever the current mode"
          onClick={() => {
            onFindReferences(node.id);
          }}
        >
          Find references
        </button>
        {link && (
          <a className="button button--quiet" href={link} title="Open in your editor">
            Editor
          </a>
        )}
      </div>

      <div className="inspector__depth">
        <span className="inspector__depth-label">Depth</span>
        <div className="segmented segmented--compact" role="group" aria-label="Focus depth">
          {FOCUS_DEPTHS.map((depth) => (
            <button
              key={depth}
              type="button"
              className={`segmented__option${
                focusDepth === depth ? ' segmented__option--active' : ''
              }`}
              aria-pressed={focusDepth === depth}
              onClick={() => {
                onChangeFocusDepth(depth);
              }}
            >
              {depth}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button--quiet"
          title="Re-query the server from this node at this depth"
          onClick={() => {
            onReroot(node.id);
          }}
        >
          Re-root here
        </button>
      </div>

      <div className="inspector__actions inspector__actions--quiet">
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            onPathFrom(node.id);
          }}
        >
          Path from here
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            onPathTo(node.id);
          }}
        >
          Path to here
        </button>
      </div>

      <Facts node={node} symbol={symbol} detail={detail} onSelectNode={onSelectNode} />

      <ApiNodeList
        title="Callers"
        nodes={detail.callers}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <ApiNodeList
        title="Callees"
        nodes={detail.callees}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <ApiNodeList
        title="References"
        nodes={detail.references}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <RelatedList
        title="Dependencies"
        nodes={detail.dependencies}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <RelatedList
        title="Dependents"
        nodes={detail.dependents}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <RelatedList
        title="Implements"
        nodes={detail.implementations}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <RelatedList
        title="Architecture"
        nodes={architecture}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <ApiNodeList
        title="Members"
        nodes={detail.children}
        onSelectNode={onSelectNode}
        onOpenSource={onOpenSource}
      />
      <NodeList title="Symbols" hint="in this view" nodes={members} onSelectNode={onSelectNode} />

      {nothingElse && (
        <p className="inspector__empty">Nothing else in the graph touches this node.</p>
      )}
    </div>
  );
}

function Metric({
  value,
  label,
  suffix,
  title,
}: {
  value: number;
  label: string;
  suffix?: string;
  title?: string;
}): React.JSX.Element {
  return (
    <div className="inspector__metric" {...(title ? { title } : {})}>
      <span className="inspector__metric-value">
        {value}
        {suffix}
      </span>
      <span className="inspector__metric-label">{label}</span>
    </div>
  );
}

/**
 * The named facts about a symbol, straight from the API's `symbol` block.
 *
 * Nothing is derived here and nothing is inferred: a row appears when the
 * server reported a value and is absent when it reported null, which is what
 * keeps the panel from quietly asserting that an un-analysed symbol is
 * un-exported or belongs to no framework.
 */
function Facts({
  node,
  symbol,
  detail,
  onSelectNode,
}: {
  node: GraphNode;
  symbol: SymbolInfo;
  detail: NodeDetail;
  onSelectNode: (nodeId: string) => void;
}): React.JSX.Element {
  const metadata = node.metadata;
  const parent = detail.parent;

  return (
    <dl className="inspector__facts">
      {parent && (
        <>
          <dt>Declared in</dt>
          <dd>
            <button
              type="button"
              className="inspector__inline-link"
              title={nodeFullName(parent)}
              onClick={() => {
                onSelectNode(parent.id);
              }}
            >
              {nodeFullName(parent)}
            </button>
          </dd>
        </>
      )}
      <dt>Module</dt>
      <dd>{symbol.module ?? node.moduleLabel}</dd>
      {symbol.startLine !== null && (
        <>
          <dt>Lines</dt>
          <dd>{lineRange(detail.node)}</dd>
        </>
      )}
      {symbol.exported === true && (
        <>
          <dt>Exported</dt>
          <dd>Imported by name elsewhere</dd>
        </>
      )}
      {symbol.visibility !== null && (
        <>
          <dt>Visibility</dt>
          <dd>{symbol.visibility}</dd>
        </>
      )}
      {symbol.apiRoute && (
        <>
          <dt>Route</dt>
          <dd className="inspector__mono">
            {symbol.apiRoute.method ?? ''} {symbol.apiRoute.path ?? ''}
          </dd>
        </>
      )}
      {symbol.framework !== null && (
        <>
          <dt>Framework</dt>
          <dd>{symbol.framework}</dd>
        </>
      )}
      {symbol.databaseResource !== null && (
        <>
          <dt>Data store</dt>
          <dd className="inspector__mono">{symbol.databaseResource}</dd>
        </>
      )}
      {symbol.externalService !== null && (
        <>
          <dt>External service</dt>
          <dd>
            {symbol.externalService}
            {metadata.host !== undefined ? ` · ${String(metadata.host)}` : ''}
            {metadata.package !== undefined ? ` · ${String(metadata.package)}` : ''}
          </dd>
        </>
      )}
      {symbol.messagingResource !== null && (
        <>
          <dt>Messaging</dt>
          <dd className="inspector__mono">{symbol.messagingResource}</dd>
        </>
      )}
      {Array.isArray(metadata.frameworks) && metadata.frameworks.length > 0 && (
        <>
          <dt>Frameworks</dt>
          <dd>{metadata.frameworks.map(String).join(', ')}</dd>
        </>
      )}
      {symbol.scipSymbol !== null && (
        <>
          <dt>SCIP symbol</dt>
          <dd className="inspector__mono">{symbol.scipSymbol}</dd>
        </>
      )}
      {symbol.language !== null && (
        <>
          <dt>Language</dt>
          <dd>{symbol.language}</dd>
        </>
      )}
    </dl>
  );
}

function Section({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint?: string | undefined;
  count: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="inspector__section">
      <h3 className="inspector__heading">
        {title}
        {hint && <span className="inspector__hint">{hint}</span>}
        <span className="inspector__count">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function NodeList({
  title,
  hint,
  nodes,
  onSelectNode,
}: {
  title: string;
  hint?: string;
  nodes: GraphNode[];
  onSelectNode: (nodeId: string) => void;
}): React.JSX.Element | null {
  if (nodes.length === 0) return null;

  return (
    <Section title={title} hint={hint} count={nodes.length}>
      <ul className="inspector__list">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              className="inspector__link"
              title={node.fullLabel}
              onClick={() => {
                onSelectNode(node.id);
              }}
            >
              <span className="swatch" style={{ background: nodeColor(node.type) }} />
              <span className="inspector__link-name">{node.label}</span>
              <span className="inspector__link-meta">{nodeTypeLabel(node.type)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * A section of plain API nodes: callers, callees, references, members.
 *
 * Every row does two things, because those are the two questions someone has
 * about a caller: *what is it* (select it, and the panel and the canvas both
 * move to it) and *where is it* (open its source). Splitting them into two
 * targets rather than one is what lets a reader walk a call chain without
 * losing the graph.
 */
function ApiNodeList({
  title,
  nodes,
  onSelectNode,
  onOpenSource,
}: {
  title: string;
  nodes: CodeNode[];
  onSelectNode: (nodeId: string) => void;
  onOpenSource: (nodeId: string) => void;
}): React.JSX.Element | null {
  if (nodes.length === 0) return null;

  return (
    <Section title={title} count={nodes.length}>
      <ul className="inspector__list">
        {nodes.map((node) => (
          <li key={node.id} className="inspector__row">
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
                {node.filePath ? shortenPath(node.filePath, 26) : nodeTypeLabel(node.type)}
                {node.startLine !== undefined && `:${String(node.startLine)}`}
              </span>
            </button>
            <SourceButton node={node} onOpenSource={onOpenSource} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** A section whose entries carry the relationship that produced them. */
function RelatedList({
  title,
  nodes,
  onSelectNode,
  onOpenSource,
}: {
  title: string;
  nodes: RelatedNode[];
  onSelectNode: (nodeId: string) => void;
  onOpenSource: (nodeId: string) => void;
}): React.JSX.Element | null {
  if (nodes.length === 0) return null;

  return (
    <Section title={title} count={nodes.length}>
      <ul className="inspector__list">
        {nodes.map((node) => (
          <li key={`${node.id}-${node.relationship}-${node.direction}`} className="inspector__row">
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
                  {node.direction === 'incoming' ? '←' : '→'} {node.relationship}
                </span>
                <ConfidenceMark level={node.confidence} />
              </span>
            </button>
            <SourceButton node={node} onOpenSource={onOpenSource} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The "where is it" half of a row, for a node the indexer gave a file. */
function SourceButton({
  node,
  onOpenSource,
}: {
  node: CodeNode;
  onOpenSource: (nodeId: string) => void;
}): React.JSX.Element | null {
  if (!node.filePath) return null;

  return (
    <button
      type="button"
      className="inspector__row-source"
      title={`Open ${node.filePath}${node.startLine === undefined ? '' : `:${String(node.startLine)}`}`}
      aria-label={`Open the source of ${nodeFullName(node)}`}
      onClick={() => {
        onOpenSource(node.id);
      }}
    >
      source
    </button>
  );
}

function EdgeInspector({
  edge,
  source,
  target,
}: {
  edge: GraphEdge;
  source: GraphNode | null;
  target: GraphNode | null;
}): React.JSX.Element {
  const evidence = edgeEvidence(edge.sourceEdge);
  const metadata = edge.metadata;

  return (
    <div className="inspector">
      <h2 className="inspector__title">Selected relationship</h2>

      <dl className="inspector__facts">
        <dt>Relationship</dt>
        <dd>
          <span className="legend__line" style={{ color: relationshipColor(edge.type) }} />
          {edge.type}
        </dd>
        <dt>From</dt>
        <dd>{source?.fullLabel ?? edge.source}</dd>
        <dt>To</dt>
        <dd>{target?.fullLabel ?? edge.target}</dd>
        {evidence && (
          <>
            <dt>Evidence</dt>
            <dd>
              {evidence.source} <ConfidenceMark level={evidence.confidence} />
            </dd>
          </>
        )}
        {metadata.occurrences !== undefined && (
          <>
            <dt>Occurrences</dt>
            <dd>{String(metadata.occurrences)}</dd>
          </>
        )}
        {metadata.statement !== undefined && (
          <>
            <dt>Statement</dt>
            <dd>{String(metadata.statement)}</dd>
          </>
        )}
        {metadata.via !== undefined && (
          <>
            <dt>Found via</dt>
            <dd>{String(metadata.via)}</dd>
          </>
        )}
        {metadata.derived === true && (
          <>
            <dt>Derived</dt>
            <dd>Summarises edges between members of these containers</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ConfidenceMark({
  level,
}: {
  level: ConfidenceLevel | undefined;
}): React.JSX.Element | null {
  if (!level || level === 'high') return null;
  return (
    <span className={`confidence confidence--${level}`} title={`${level} confidence`}>
      {level}
    </span>
  );
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
