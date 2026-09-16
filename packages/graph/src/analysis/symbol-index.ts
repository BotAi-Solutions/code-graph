import type { CodeEdge, CodeGraph, CodeNode, CodeNodeType, CodeRelationship } from '@ckg/shared';

/**
 * Lookup over an already-built graph, for analyzers that need to point at a
 * symbol the compiler found.
 *
 * Every lookup is scoped by file. That is the whole point: resolving the name
 * `UserService` by searching the repository for something called `UserService`
 * is exactly the name-similarity guessing that fills a graph with edges nobody
 * can trust. An analyzer that knows a name *and the file it was declared in* —
 * which is what an import statement tells it — gets an unambiguous answer or
 * no answer at all.
 */

const NUL = String.fromCharCode(0);

/** Preferred when a file declares the same name as more than one kind. */
const TYPE_PRIORITY: readonly CodeNodeType[] = [
  'class',
  'interface',
  'type',
  'enum',
  'function',
  'method',
  'variable',
  'property',
];

export class SymbolIndex {
  private readonly byId = new Map<string, CodeNode>();
  private readonly byFile = new Map<string, CodeNode[]>();
  private readonly byFileAndQualifiedName = new Map<string, CodeNode[]>();
  private readonly byFileAndName = new Map<string, CodeNode[]>();
  private readonly ownerByNodeId = new Map<string, string>();
  private readonly childrenByNodeId = new Map<string, CodeNode[]>();
  private readonly outgoing = new Map<string, CodeEdge[]>();
  private readonly incoming = new Map<string, CodeEdge[]>();

  constructor(graph: CodeGraph = { nodes: [], edges: [] }) {
    for (const node of graph.nodes) {
      this.byId.set(node.id, node);

      if (node.filePath !== undefined) {
        push(this.byFile, node.filePath, node);
        push(this.byFileAndName, key(node.filePath, node.name), node);
        push(this.byFileAndQualifiedName, key(node.filePath, node.qualifiedName ?? node.name), node);
      }
    }

    for (const edge of graph.edges) {
      pushEdge(this.outgoing, edge.sourceNodeId, edge);
      pushEdge(this.incoming, edge.targetNodeId, edge);

      if (edge.relationship !== 'CONTAINS') continue;
      this.ownerByNodeId.set(edge.targetNodeId, edge.sourceNodeId);
      const child = this.byId.get(edge.targetNodeId);
      if (child) push(this.childrenByNodeId, edge.sourceNodeId, child);
    }
  }

  get size(): number {
    return this.byId.size;
  }

  node(id: string): CodeNode | undefined {
    return this.byId.get(id);
  }

  /** The single `repository` node, which is the graph's root. */
  repository(): CodeNode | undefined {
    for (const node of this.byId.values()) {
      if (node.type === 'repository') return node;
    }
    return undefined;
  }

  file(relativePath: string): CodeNode | undefined {
    return this.byFile
      .get(relativePath)
      ?.find((node) => node.type === 'file' && node.filePath === relativePath);
  }

  inFile(relativePath: string): readonly CodeNode[] {
    return this.byFile.get(relativePath) ?? [];
  }

  /**
   * The node a file declares under this dotted name — `UserService`, or
   * `UserService.getUser`. Returns nothing when the file declares no such
   * name, which is the honest answer for a symbol that came from a dependency.
   */
  declaration(
    relativePath: string,
    qualifiedName: string,
    types?: readonly CodeNodeType[],
  ): CodeNode | undefined {
    const candidates = [
      ...(this.byFileAndQualifiedName.get(key(relativePath, qualifiedName)) ?? []),
      ...(this.byFileAndName.get(key(relativePath, qualifiedName)) ?? []),
    ];
    return pick(candidates, types);
  }

  /** A member of a container declared in the same file: `getUser` of `UserService`. */
  member(
    relativePath: string,
    containerName: string,
    memberName: string,
    types?: readonly CodeNodeType[],
  ): CodeNode | undefined {
    return this.declaration(relativePath, `${containerName}.${memberName}`, types);
  }

  /** Edges leaving this node, in graph order. */
  edgesFrom(nodeId: string): readonly CodeEdge[] {
    return this.outgoing.get(nodeId) ?? [];
  }

  /** Edges arriving at this node, in graph order. */
  edgesTo(nodeId: string): readonly CodeEdge[] {
    return this.incoming.get(nodeId) ?? [];
  }

  /**
   * Nodes one hop away along a relationship. Used by the classification stage,
   * which reasons about the shape of the graph rather than about source text.
   */
  related(
    nodeId: string,
    relationship: CodeRelationship,
    direction: 'outgoing' | 'incoming',
  ): CodeNode[] {
    const edges = direction === 'outgoing' ? this.edgesFrom(nodeId) : this.edgesTo(nodeId);

    return edges
      .filter((edge) => edge.relationship === relationship)
      .map((edge) =>
        this.byId.get(direction === 'outgoing' ? edge.targetNodeId : edge.sourceNodeId),
      )
      .filter((node): node is CodeNode => node !== undefined);
  }

  /** True when this node, or any node it CONTAINS, has such a relationship. */
  hasRelationship(
    nodeId: string,
    relationship: CodeRelationship,
    direction: 'outgoing' | 'incoming',
    includeMembers = false,
  ): boolean {
    if (this.related(nodeId, relationship, direction).length > 0) return true;
    if (!includeMembers) return false;

    return this.children(nodeId).some(
      (child) => this.related(child.id, relationship, direction).length > 0,
    );
  }

  /** Nodes this one CONTAINS, in graph order. */
  children(nodeId: string): readonly CodeNode[] {
    return this.childrenByNodeId.get(nodeId) ?? [];
  }

  /** The node that CONTAINS this one, if any. */
  owner(nodeId: string): CodeNode | undefined {
    const ownerId = this.ownerByNodeId.get(nodeId);
    return ownerId ? this.byId.get(ownerId) : undefined;
  }

  /**
   * The nearest class or interface above this node, which is the useful
   * altitude for an architectural edge: a SQL statement inside a method is a
   * fact about the repository class that owns it too.
   */
  enclosingContainer(nodeId: string): CodeNode | undefined {
    let current = this.owner(nodeId);
    let guard = 0;

    while (current && guard < 32) {
      if (current.type === 'class' || current.type === 'interface') return current;
      if (current.type === 'file' || current.type === 'repository') return undefined;
      current = this.owner(current.id);
      guard += 1;
    }
    return undefined;
  }

  /** Every node of a type, in id order. Used for whole-graph classification. */
  ofType(type: CodeNodeType): CodeNode[] {
    return [...this.byId.values()]
      .filter((node) => node.type === type)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * The definition whose range covers a position, innermost first. This is how
   * an analyzer attributes a syntactic finding — a call, a string literal — to
   * the method it sits inside.
   */
  enclosingDefinition(relativePath: string, line: number): CodeNode | undefined {
    let best: CodeNode | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;

    for (const node of this.inFile(relativePath)) {
      if (node.type === 'file' || node.type === 'directory') continue;
      if (node.startLine === undefined) continue;

      const end = node.endLine ?? node.startLine;
      if (line < node.startLine || line > end) continue;

      const span = end - node.startLine;
      // Ties go to the more specific declaration: a method inside a class with
      // a single-line body outranks the class.
      if (span < bestSpan || (span === bestSpan && rank(node) < rank(best))) {
        best = node;
        bestSpan = span;
      }
    }
    return best;
  }
}

function key(filePath: string, name: string): string {
  return `${filePath}${NUL}${name}`;
}

function push(map: Map<string, CodeNode[]>, mapKey: string, node: CodeNode): void {
  const existing = map.get(mapKey);
  if (existing) {
    existing.push(node);
    return;
  }
  map.set(mapKey, [node]);
}

function pushEdge(map: Map<string, CodeEdge[]>, mapKey: string, edge: CodeEdge): void {
  const existing = map.get(mapKey);
  if (existing) {
    existing.push(edge);
    return;
  }
  map.set(mapKey, [edge]);
}

function rank(node: CodeNode | undefined): number {
  if (!node) return Number.MAX_SAFE_INTEGER;
  const index = TYPE_PRIORITY.indexOf(node.type);
  return index === -1 ? TYPE_PRIORITY.length : index;
}

function pick(
  candidates: readonly CodeNode[],
  types?: readonly CodeNodeType[],
): CodeNode | undefined {
  const allowed = types ? candidates.filter((node) => types.includes(node.type)) : candidates;
  if (allowed.length <= 1) return allowed[0];

  return [...allowed].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
}

/** Convenience for tests and callers holding a graph rather than an index. */
export function indexGraph(graph: CodeGraph): SymbolIndex {
  return new SymbolIndex(graph);
}
