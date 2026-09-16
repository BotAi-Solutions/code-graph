import type {
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  GraphDirection,
  GraphProjectionId,
  NodeDetail,
  RelatedNode,
} from '@ckg/shared';
import {
  GRAPH_DEFAULT_DEPTH,
  GRAPH_DEFAULT_DIRECTION,
  GRAPH_DEFAULT_NODE_LIMIT,
  graphProjection,
} from '@ckg/shared';
import type { GraphComposition, GraphResult, NodeRelations, SearchResult } from '@ckg/database';
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
    options: { nodeTypes?: CodeNodeType[] | undefined; limit: number; offset: number },
  ): Promise<SearchResult>;
  nodeRelations(
    projectId: string,
    nodeId: string,
    limitPerSection: number,
  ): Promise<NodeRelations>;
  callers(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]>;
  callees(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]>;
  references(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]>;
  composition(projectId: string): Promise<GraphComposition>;
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
    const relations = await this.graph.nodeRelations(projectId, nodeId, limit);

    return {
      node,
      callers: relations.callers,
      callees: relations.callees,
      references: relations.references,
      dependencies: relations.dependencies as RelatedNode[],
      dependents: relations.dependents as RelatedNode[],
      apis: relations.apis as RelatedNode[],
      databases: relations.databases as RelatedNode[],
    };
  }

  async getCallers(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    await this.getNode(projectId, nodeId);
    return this.graph.callers(projectId, nodeId, limit);
  }

  async getCallees(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    await this.getNode(projectId, nodeId);
    return this.graph.callees(projectId, nodeId, limit);
  }

  async getReferences(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    await this.getNode(projectId, nodeId);
    return this.graph.references(projectId, nodeId, limit);
  }

  async search(
    projectId: string,
    term: string,
    options: { nodeTypes?: CodeNodeType[] | undefined; limit: number; offset: number },
  ): Promise<GraphSearchResult> {
    await this.projects.getById(projectId);

    const result = await this.graph.searchNodes(projectId, term, options);
    return { ...result, limit: options.limit, offset: options.offset };
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
