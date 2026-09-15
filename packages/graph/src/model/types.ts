import type { CodeEdge, CodeGraph, CodeNode, CodeNodeType, CodeRelationship } from '@ckg/shared';

/**
 * The graph domain model is defined in `@ckg/shared` so that the API, the web
 * client and the database all speak the same vocabulary. This package owns the
 * behaviour: identity, construction, traversal and serialisation.
 */
export type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
} from '@ckg/shared';

export {
  CODE_NODE_TYPES,
  CODE_RELATIONSHIPS,
  isCodeNodeType,
  isCodeRelationship,
} from '@ckg/shared';

export interface GraphBuildStats {
  documentCount: number;
  symbolCount: number;
  nodeCount: number;
  edgeCount: number;
  /** References whose target was not defined inside the analysed repository. */
  unresolvedReferenceCount: number;
}

export interface GraphBuildResult extends CodeGraph {
  stats: GraphBuildStats;
}

/** Lookup structures over a graph, used by traversal and by tests. */
export class CodeGraphIndex {
  private readonly nodesById: Map<string, CodeNode>;
  private readonly outgoing: Map<string, CodeEdge[]>;
  private readonly incoming: Map<string, CodeEdge[]>;

  constructor(private readonly graph: CodeGraph) {
    this.nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    this.outgoing = new Map();
    this.incoming = new Map();

    for (const edge of graph.edges) {
      appendTo(this.outgoing, edge.sourceNodeId, edge);
      appendTo(this.incoming, edge.targetNodeId, edge);
    }
  }

  get nodes(): CodeNode[] {
    return this.graph.nodes;
  }

  get edges(): CodeEdge[] {
    return this.graph.edges;
  }

  node(id: string): CodeNode | undefined {
    return this.nodesById.get(id);
  }

  edgesFrom(nodeId: string): CodeEdge[] {
    return this.outgoing.get(nodeId) ?? [];
  }

  edgesTo(nodeId: string): CodeEdge[] {
    return this.incoming.get(nodeId) ?? [];
  }

  nodesOfType(type: CodeNodeType): CodeNode[] {
    return this.graph.nodes.filter((node) => node.type === type);
  }

  edgesOfType(relationship: CodeRelationship): CodeEdge[] {
    return this.graph.edges.filter((edge) => edge.relationship === relationship);
  }
}

function appendTo(map: Map<string, CodeEdge[]>, key: string, edge: CodeEdge): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(edge);
    return;
  }
  map.set(key, [edge]);
}
