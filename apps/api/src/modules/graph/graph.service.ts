import type {
  CodeEdge,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  Definition,
  GraphDirection,
  GraphPath,
  GraphPathDirection,
  GraphPathStep,
  GraphProjectionId,
  ImplementationDirection,
  NodeCategory,
  NodeDetail,
  NodeRelationshipTotals,
  RelatedNode,
  SourceTree,
} from '@ckg/shared';
import {
  GRAPH_DEFAULT_DEPTH,
  GRAPH_DEFAULT_DIRECTION,
  GRAPH_DEFAULT_NODE_LIMIT,
  GRAPH_DEFAULT_PATH_DEPTH,
  GRAPH_DEFAULT_PATH_DIRECTION,
  edgeEvidence,
  graphProjection,
  nodeTypesForCategories,
  symbolInfoOf,
} from '@ckg/shared';
import type {
  GraphComposition,
  GraphResult,
  NodeRelations,
  PagedSection,
  PathResult,
  SearchResult,
  TreeLevel,
} from '@ckg/database';
import { AppError } from '../../common/errors/index.js';
import type { ProjectService } from '../projects/projects.service.js';

/**
 * Read model over the code knowledge graph.
 *
 * The API is traversal-first on purpose: a whole repository graph is never
 * returned, because a mid-sized service produces tens of thousands of nodes and
 * neither the wire nor the canvas can absorb that. Callers either walk outward
 * from a root node, or ask for the overview, which is a ranked slice.
 *
 * A *projection* is how a caller says which question they are asking —
 * architecture, call graph, files, dependencies, data flow. It resolves to the
 * same filters the caller could have sent by hand, applied to the same graph;
 * there is no second store and no second code path.
 */

export interface GraphStore {
  traverse(
    projectId: string,
    options: {
      rootNodeId: string;
      depth: number;
      nodeTypes?: CodeNodeType[] | undefined;
      relationships?: CodeRelationship[] | undefined;
      direction?: GraphDirection | undefined;
      limit: number;
    },
  ): Promise<GraphResult>;
  overview(
    projectId: string,
    options: {
      nodeTypes?: CodeNodeType[] | undefined;
      relationships?: CodeRelationship[] | undefined;
      priorityNodeTypes?: CodeNodeType[] | undefined;
      limit: number;
    },
  ): Promise<GraphResult>;
  findNode(projectId: string, nodeId: string): Promise<CodeNode | null>;
  findRootNode(projectId: string): Promise<CodeNode | null>;
  searchNodes(
    projectId: string,
    term: string,
    options: {
      nodeTypes?: CodeNodeType[] | undefined;
      filePrefix?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<SearchResult>;
  nodeRelations(
    projectId: string,
    nodeId: string,
    limitPerSection: number,
  ): Promise<NodeRelations>;
  callers(projectId: string, nodeId: string, limit: number, offset?: number): Promise<CodeNode[]>;
  callees(projectId: string, nodeId: string, limit: number, offset?: number): Promise<CodeNode[]>;
  references(projectId: string, nodeId: string, limit: number, offset?: number): Promise<CodeNode[]>;
  dependencies(projectId: string, nodeId: string, limit: number, offset?: number): Promise<RelatedNode[]>;
  dependents(projectId: string, nodeId: string, limit: number, offset?: number): Promise<RelatedNode[]>;
  implementations(
    projectId: string,
    nodeId: string,
    limit: number,
    offset?: number,
    direction?: ImplementationDirection,
  ): Promise<RelatedNode[]>;
  parent(projectId: string, nodeId: string): Promise<CodeNode | null>;
  children(projectId: string, nodeId: string, limit: number, offset?: number): Promise<CodeNode[]>;
  apis(projectId: string, nodeId: string, limit: number, offset?: number): Promise<RelatedNode[]>;
  databases(projectId: string, nodeId: string, limit: number, offset?: number): Promise<RelatedNode[]>;
  documentation(projectId: string, nodeId: string, limit: number, offset?: number): Promise<RelatedNode[]>;
  contracts(projectId: string, nodeId: string, limit: number, offset?: number): Promise<RelatedNode[]>;
  /** Exact size of every node-detail section. */
  relationshipTotals(projectId: string, nodeId: string): Promise<NodeRelationshipTotals>;
  /** Exact size of one paged section, counted as its list is built. */
  countSection(
    projectId: string,
    nodeId: string,
    section: PagedSection,
    direction?: ImplementationDirection,
  ): Promise<number>;
  findFileNode(projectId: string, filePath: string): Promise<CodeNode | null>;
  treeLevel(projectId: string, directoryPath: string, limit: number): Promise<TreeLevel>;
  findPath(
    projectId: string,
    from: string,
    to: string,
    options: {
      maxDepth: number;
      directed: boolean;
      relationships?: CodeRelationship[] | undefined;
      nodeTypes?: CodeNodeType[] | undefined;
    },
  ): Promise<PathResult>;
  loadPathGraph(
    projectId: string,
    nodeIds: readonly string[],
    edgeIds: readonly string[],
  ): Promise<{ nodes: CodeNode[]; edges: CodeEdge[] }>;
  composition(projectId: string): Promise<GraphComposition>;
}

export interface GraphPathInput {
  projectId: string;
  from: string;
  to: string;
  maxDepth?: number | undefined;
  direction?: GraphPathDirection | undefined;
  relationships?: CodeRelationship[] | undefined;
  nodeTypes?: CodeNodeType[] | undefined;
  projection?: GraphProjectionId | undefined;
}

export interface GraphQueryInput {
  projectId: string;
  rootNodeId?: string | undefined;
  depth?: number | undefined;
  projection?: GraphProjectionId | undefined;
  nodeTypes?: CodeNodeType[] | undefined;
  relationships?: CodeRelationship[] | undefined;
  direction?: GraphDirection | undefined;
  limit?: number | undefined;
}

export type GraphQueryMode = 'traversal' | 'overview';

export interface GraphQueryResult extends GraphResult {
  mode: GraphQueryMode;
  rootNodeId: string | null;
  depth: number;
  direction: GraphDirection;
  projection: GraphProjectionId | null;
  /** The filters actually applied, after the projection was resolved. */
  appliedNodeTypes: CodeNodeType[] | null;
  appliedRelationships: CodeRelationship[] | null;
}

export interface GraphSearchResult {
  nodes: CodeNode[];
  total: number;
  limit: number;
  offset: number;
  /** The node types actually searched, after categories were resolved. */
  nodeTypes: CodeNodeType[] | null;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

/** One page of a relationship section, with the full count it was cut from. */
export interface SectionPage<TItem> {
  items: TItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface GraphSearchOptions {
  nodeTypes?: CodeNodeType[] | undefined;
  /** Coarse narrowing: code, architecture or repository knowledge. */
  categories?: NodeCategory[] | undefined;
  /** Repository-relative path prefix. */
  file?: string | undefined;
  limit: number;
  offset: number;
}

export class GraphService {
  constructor(
    private readonly graph: GraphStore,
    private readonly projects: ProjectService,
  ) {}

  async query(input: GraphQueryInput): Promise<GraphQueryResult> {
    await this.projects.getById(input.projectId);

    const depth = input.depth ?? GRAPH_DEFAULT_DEPTH;
    const limit = input.limit ?? GRAPH_DEFAULT_NODE_LIMIT;
    const direction = input.direction ?? GRAPH_DEFAULT_DIRECTION;

    // An explicit filter always wins over the projection's default, so the UI
    // can start from a projection and then let the user narrow it.
    const projection = input.projection ? graphProjection(input.projection) : null;
    const nodeTypes = input.nodeTypes ?? nonEmpty(projection?.nodeTypes);
    const relationships = input.relationships ?? nonEmpty(projection?.relationships);

    const applied = {
      projection: projection?.id ?? null,
      appliedNodeTypes: nodeTypes ?? null,
      appliedRelationships: relationships ?? null,
    };

    if (input.rootNodeId) {
      const root = await this.graph.findNode(input.projectId, input.rootNodeId);
      if (!root) throw AppError.nodeNotFound(input.rootNodeId);

      const result = await this.graph.traverse(input.projectId, {
        rootNodeId: input.rootNodeId,
        depth,
        nodeTypes,
        relationships,
        direction,
        limit,
      });

      return {
        ...result,
        ...applied,
        mode: 'traversal',
        rootNodeId: input.rootNodeId,
        depth,
        direction,
      };
    }

    // No root given: show the project's most connected code instead of
    // dumping the repository tree, which is what makes the first render useful.
    const result = await this.graph.overview(input.projectId, {
      nodeTypes,
      relationships,
      priorityNodeTypes: nonEmpty(projection?.priorityNodeTypes),
      limit,
    });

    return { ...result, ...applied, mode: 'overview', rootNodeId: null, depth: 0, direction };
  }

  async getNode(projectId: string, nodeId: string): Promise<CodeNode> {
    await this.projects.getById(projectId);
    const node = await this.graph.findNode(projectId, nodeId);
    if (!node) throw AppError.nodeNotFound(nodeId);
    return node;
  }

  /**
   * Everything the node inspector shows, in one round trip.
   *
   * `callers`, `callees` and `references` keep the shape they have always had.
   * The sections added since — dependencies, dependents, related APIs, related
   * data stores — carry the relationship with each entry, because "depends on"
   * covers five different relationships and the inspector should say which.
   */
  async getNodeDetail(projectId: string, nodeId: string, limit: number): Promise<NodeDetail> {
    const node = await this.getNode(projectId, nodeId);

    // Four reads, issued together rather than in sequence: the bucketed sweep
    // over everything touching the node, the two halves of containment, and
    // the inheritance relation, which the sweep deliberately does not carry.
    // Five reads, issued together rather than in sequence: the bucketed sweep
    // over everything touching the node, the two halves of containment, the
    // inheritance relation, which the sweep deliberately does not carry, and
    // the exact size of every section — so a list cut by `limit` says so.
    const [relations, implementations, parent, children, totals] = await Promise.all([
      this.graph.nodeRelations(projectId, nodeId, limit),
      this.graph.implementations(projectId, nodeId, limit),
      this.graph.parent(projectId, nodeId),
      this.graph.children(projectId, nodeId, limit),
      this.graph.relationshipTotals(projectId, nodeId),
    ]);

    return {
      node,
      symbol: symbolInfoOf(node),
      definition: await this.definitionOf(projectId, node, parent),
      callers: relations.callers,
      callees: relations.callees,
      references: relations.references,
      dependencies: relations.dependencies as RelatedNode[],
      dependents: relations.dependents as RelatedNode[],
      apis: relations.apis as RelatedNode[],
      databases: relations.databases as RelatedNode[],
      documentation: relations.documentation as RelatedNode[],
      contracts: relations.contracts as RelatedNode[],
      implementations,
      parent,
      children,
      totals,
    };
  }

  /**
   * Where a symbol is written down.
   *
   * There is no separate "definition" record in this graph, and there should
   * not be: a node *is* a definition — SCIP recorded the range it occupies, and
   * the builder stored it. So this reports the node's own coordinates plus the
   * `file` node that owns them, and reports nulls for a node the indexer gave
   * no range (a table, an external package, a synthesised service).
   */
  async getDefinition(projectId: string, nodeId: string): Promise<Definition | null> {
    const node = await this.getNode(projectId, nodeId);
    const parent = await this.graph.parent(projectId, nodeId);
    return this.definitionOf(projectId, node, parent);
  }

  private async definitionOf(
    projectId: string,
    node: CodeNode,
    parent: CodeNode | null,
  ): Promise<Definition | null> {
    if (node.filePath === undefined) return null;

    // The file node is usually the parent for a top-level symbol, and further
    // up for a method; only the second case costs a lookup.
    const fileNode =
      parent?.type === 'file'
        ? parent
        : node.type === 'file'
          ? node
          : await this.graph.findFileNode(projectId, node.filePath);

    const metadata = node.metadata ?? {};

    return {
      nodeId: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName ?? null,
      type: node.type,
      language: typeof metadata.language === 'string' ? metadata.language : null,
      filePath: node.filePath,
      startLine: node.startLine ?? null,
      startCharacter: node.startCharacter ?? null,
      endLine: node.endLine ?? null,
      endCharacter: node.endCharacter ?? null,
      fileNodeId: fileNode?.id ?? null,
    };
  }

  async getDependencies(projectId: string, nodeId: string, page: PageRequest): Promise<SectionPage<RelatedNode>> {
    return this.page(projectId, nodeId, 'dependencies', page, () =>
      this.graph.dependencies(projectId, nodeId, page.limit, page.offset),
    );
  }

  async getDependents(projectId: string, nodeId: string, page: PageRequest): Promise<SectionPage<RelatedNode>> {
    return this.page(projectId, nodeId, 'dependents', page, () =>
      this.graph.dependents(projectId, nodeId, page.limit, page.offset),
    );
  }

  async getImplementations(
    projectId: string,
    nodeId: string,
    page: PageRequest & { direction?: ImplementationDirection | undefined },
  ): Promise<SectionPage<RelatedNode>> {
    const direction = page.direction ?? 'both';
    return this.page(
      projectId,
      nodeId,
      'implementations',
      page,
      () => this.graph.implementations(projectId, nodeId, page.limit, page.offset, direction),
      direction,
    );
  }

  /** One page of one of the four architectural sections, both directions. */
  async getArchitecturalSection(
    projectId: string,
    nodeId: string,
    section: 'apis' | 'databases' | 'documentation' | 'contracts',
    page: PageRequest,
  ): Promise<SectionPage<RelatedNode>> {
    return this.page(projectId, nodeId, section, page, () =>
      this.graph[section](projectId, nodeId, page.limit, page.offset),
    );
  }

  /**
   * One page of one section, with its exact total.
   *
   * The list and the count are separate reads of the same predicate, issued
   * together. Counted rather than inferred from the page, because a page's
   * length says nothing about what lies past it.
   */
  private async page<TItem>(
    projectId: string,
    nodeId: string,
    section: PagedSection,
    page: PageRequest,
    read: () => Promise<TItem[]>,
    direction?: ImplementationDirection,
  ): Promise<SectionPage<TItem>> {
    await this.getNode(projectId, nodeId);
    const [items, total] = await Promise.all([
      read(),
      this.graph.countSection(projectId, nodeId, section, direction),
    ]);
    return { items, total, limit: page.limit, offset: page.offset };
  }

  /**
   * The containment chain above a node, nearest first.
   *
   * Plural because the useful answer to "where does this live" is the whole
   * chain — method, class, file, directory — not just the first link, and
   * walking it here costs one small query per level rather than one request.
   */
  async getParents(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    await this.getNode(projectId, nodeId);

    const chain: CodeNode[] = [];
    const seen = new Set<string>([nodeId]);
    let current = nodeId;

    while (chain.length < limit) {
      const parent = await this.graph.parent(projectId, current);
      // `seen` also guards against a cycle, which containment should never
      // have but which a malformed graph must not turn into a hung request.
      if (!parent || seen.has(parent.id)) break;
      chain.push(parent);
      seen.add(parent.id);
      current = parent.id;
    }

    return chain;
  }

  async getChildren(projectId: string, nodeId: string, page: PageRequest): Promise<SectionPage<CodeNode>> {
    return this.page(projectId, nodeId, 'children', page, () =>
      this.graph.children(projectId, nodeId, page.limit, page.offset),
    );
  }

  /** One level of the repository tree, derived from the graph's path nodes. */
  async tree(projectId: string, directoryPath: string, limit: number): Promise<SourceTree> {
    await this.projects.getById(projectId);
    return this.graph.treeLevel(projectId, directoryPath, limit);
  }

  /**
   * The shortest route between two nodes.
   *
   * Directed first, because "how does a request get from the controller to the
   * table" is a question about flow. When nothing directed exists the search is
   * repeated ignoring direction and the answer says so — two pieces of code can
   * be genuinely related without one reaching the other, and reporting "no
   * path" there would be less true than reporting the undirected route.
   */
  async findPath(input: GraphPathInput): Promise<GraphPath> {
    await this.projects.getById(input.projectId);

    const [from, to] = await Promise.all([
      this.getNode(input.projectId, input.from),
      this.getNode(input.projectId, input.to),
    ]);

    const maxDepth = input.maxDepth ?? GRAPH_DEFAULT_PATH_DEPTH;
    const direction = input.direction ?? GRAPH_DEFAULT_PATH_DIRECTION;

    const projection = input.projection ? graphProjection(input.projection) : null;
    const relationships = input.relationships ?? nonEmpty(projection?.relationships);
    const nodeTypes = input.nodeTypes ?? nonEmpty(projection?.nodeTypes);

    const search = async (directed: boolean): Promise<PathResult> =>
      this.graph.findPath(input.projectId, from.id, to.id, {
        maxDepth,
        directed,
        relationships,
        nodeTypes,
      });

    let result = await search(direction === 'outgoing');
    let undirected = direction !== 'outgoing';

    if (!result.found && direction === 'outgoing') {
      result = await search(false);
      undirected = result.found;
    }

    if (!result.found) {
      return {
        found: false,
        from: from.id,
        to: to.id,
        depth: 0,
        undirected: false,
        nodes: [],
        edges: [],
        steps: [],
        relationships: [],
        truncated: result.truncated,
      };
    }

    const edgeIds = result.hops.map((hop) => hop.edgeId);
    const graph = await this.graph.loadPathGraph(input.projectId, result.nodeIds, edgeIds);

    const steps: GraphPathStep[] = result.hops.map((hop) => {
      const metadata = hop.metadata ?? {};
      return {
        edgeId: hop.edgeId,
        sourceNodeId: hop.sourceNodeId,
        targetNodeId: hop.targetNodeId,
        relationship: hop.relationship,
        reversed: hop.reversed,
        confidence:
          typeof metadata.confidence === 'string'
            ? (metadata.confidence as GraphPathStep['confidence'])
            : null,
        evidenceSource: typeof metadata.source === 'string' ? metadata.source : null,
        // A trace is only worth as much as its weakest hop, so every hop
        // carries the whole reason it was crossed — including the file and
        // line a reader can go and check.
        evidence: edgeEvidence({ metadata }),
      };
    });

    // Distinct relationships in order of first use: the shape of the trace,
    // without repeating CALLS four times for a four-hop call chain.
    const seen = new Set<CodeRelationship>();
    const usedRelationships: CodeRelationship[] = [];
    for (const step of steps) {
      if (seen.has(step.relationship)) continue;
      seen.add(step.relationship);
      usedRelationships.push(step.relationship);
    }

    return {
      found: true,
      from: from.id,
      to: to.id,
      depth: result.hops.length,
      undirected,
      nodes: graph.nodes,
      edges: graph.edges,
      steps,
      relationships: usedRelationships,
      truncated: result.truncated,
    };
  }

  async getCallers(projectId: string, nodeId: string, page: PageRequest): Promise<SectionPage<CodeNode>> {
    return this.page(projectId, nodeId, 'callers', page, () =>
      this.graph.callers(projectId, nodeId, page.limit, page.offset),
    );
  }

  async getCallees(projectId: string, nodeId: string, page: PageRequest): Promise<SectionPage<CodeNode>> {
    return this.page(projectId, nodeId, 'callees', page, () =>
      this.graph.callees(projectId, nodeId, page.limit, page.offset),
    );
  }

  async getReferences(projectId: string, nodeId: string, page: PageRequest): Promise<SectionPage<CodeNode>> {
    return this.page(projectId, nodeId, 'references', page, () =>
      this.graph.references(projectId, nodeId, page.limit, page.offset),
    );
  }

  /**
   * Find nodes by name, qualified name or path.
   *
   * Two narrowings, resolved to one. `categories` is the question a person
   * asks — "only documentation" — and `nodeTypes` is the one the store
   * answers; when both are given the result is their intersection, and an
   * empty intersection returns nothing rather than quietly widening to
   * everything, which would be the opposite of what was asked.
   */
  async search(
    projectId: string,
    term: string,
    options: GraphSearchOptions,
  ): Promise<GraphSearchResult> {
    await this.projects.getById(projectId);

    const nodeTypes = resolveSearchTypes(options);
    if (nodeTypes !== null && nodeTypes.length === 0) {
      return { nodes: [], total: 0, limit: options.limit, offset: options.offset, nodeTypes };
    }

    // The path prefix is applied by the store, before paging. Filtering the
    // page after the fact — as this once did — dropped every match that was
    // not on the first page and then reported the survivors as the total.
    const filePrefix = normalisePathPrefix(options.file);

    const result = await this.graph.searchNodes(projectId, term, {
      ...(nodeTypes ? { nodeTypes } : {}),
      ...(filePrefix ? { filePrefix } : {}),
      limit: options.limit,
      offset: options.offset,
    });

    return { ...result, limit: options.limit, offset: options.offset, nodeTypes };
  }

  async summary(projectId: string): Promise<GraphComposition & { rootNodeId: string | null }> {
    await this.projects.getById(projectId);
    const [composition, root] = await Promise.all([
      this.graph.composition(projectId),
      this.graph.findRootNode(projectId),
    ]);
    return { ...composition, rootNodeId: root?.id ?? null };
  }
}

/** Treats a projection's empty filter list as "no filter". */
function nonEmpty<T>(values: readonly T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? [...values] : undefined;
}

/** The node types a search should look at, or null for "every type". */
function resolveSearchTypes(options: GraphSearchOptions): CodeNodeType[] | null {
  const fromCategories = options.categories ? nodeTypesForCategories(options.categories) : null;
  const explicit = nonEmpty(options.nodeTypes) ?? null;

  if (fromCategories === null) return explicit;
  if (explicit === null) return fromCategories;

  const allowed = new Set(fromCategories);
  return explicit.filter((type) => allowed.has(type));
}

/**
 * Keeps results under a path prefix.
 *
 * Applied after the store rather than inside it because the prefix narrows a
 * page, not the query: the store already ranks and pages, and pushing a second
 * predicate into that SQL would mean a second ranking to keep in step with the
 * first. `total` is corrected to the filtered count so a caller is not told
 * there are more pages than there are.
 */
/** A repository-relative path prefix as the store compares it, or null for none. */
function normalisePathPrefix(prefix: string | undefined): string | null {
  if (prefix === undefined) return null;
  const normalised = prefix.replace(/^\/+|\/+$/g, '').toLowerCase();
  return normalised === '' ? null : normalised;
}
