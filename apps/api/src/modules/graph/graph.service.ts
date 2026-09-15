import type { CodeNode, CodeNodeType, CodeRelationship, NodeDetail } from '@ckg/shared';
import { GRAPH_DEFAULT_DEPTH, GRAPH_DEFAULT_NODE_LIMIT } from '@ckg/shared';
import type { GraphComposition, GraphResult } from '@ckg/database';
import { AppError } from '../../common/errors/index.js';
import type { ProjectService } from '../projects/projects.service.js';

/**
 * Read model over the code knowledge graph.
 *
 * The API is traversal-first on purpose: a whole repository graph is never
 * returned, because a mid-sized service produces tens of thousands of nodes and
 * neither the wire nor the canvas can absorb that. Callers either walk outward
 * from a root node, or ask for the overview, which is a ranked slice.
 */

export interface GraphStore {
  traverse(
    projectId: string,
    options: {
      rootNodeId: string;
      depth: number;
      nodeTypes?: CodeNodeType[] | undefined;
      relationships?: CodeRelationship[] | undefined;
      limit: number;
    },
  ): Promise<GraphResult>;
  overview(
    projectId: string,
    options: {
      nodeTypes?: CodeNodeType[] | undefined;
      relationships?: CodeRelationship[] | undefined;
      limit: number;
    },
  ): Promise<GraphResult>;
  findNode(projectId: string, nodeId: string): Promise<CodeNode | null>;
  findRootNode(projectId: string): Promise<CodeNode | null>;
  searchNodes(projectId: string, term: string, limit: number): Promise<CodeNode[]>;
  callers(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]>;
  callees(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]>;
  references(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]>;
  composition(projectId: string): Promise<GraphComposition>;
}

export interface GraphQueryInput {
  projectId: string;
  rootNodeId?: string | undefined;
  depth?: number | undefined;
  nodeTypes?: CodeNodeType[] | undefined;
  relationships?: CodeRelationship[] | undefined;
  limit?: number | undefined;
}

export type GraphQueryMode = 'traversal' | 'overview';

export interface GraphQueryResult extends GraphResult {
  mode: GraphQueryMode;
  rootNodeId: string | null;
  depth: number;
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

    if (input.rootNodeId) {
      const root = await this.graph.findNode(input.projectId, input.rootNodeId);
      if (!root) throw AppError.nodeNotFound(input.rootNodeId);

      const result = await this.graph.traverse(input.projectId, {
        rootNodeId: input.rootNodeId,
        depth,
        nodeTypes: input.nodeTypes,
        relationships: input.relationships,
        limit,
      });

      return { ...result, mode: 'traversal', rootNodeId: input.rootNodeId, depth };
    }

    // No root given: show the project's most connected code instead of
    // dumping the repository tree, which is what makes the first render useful.
    const result = await this.graph.overview(input.projectId, {
      nodeTypes: input.nodeTypes,
      relationships: input.relationships,
      limit,
    });

    return { ...result, mode: 'overview', rootNodeId: null, depth: 0 };
  }

  async getNode(projectId: string, nodeId: string): Promise<CodeNode> {
    await this.projects.getById(projectId);
    const node = await this.graph.findNode(projectId, nodeId);
    if (!node) throw AppError.nodeNotFound(nodeId);
    return node;
  }

  /** Everything the node inspector shows, in one round trip. */
  async getNodeDetail(projectId: string, nodeId: string, limit: number): Promise<NodeDetail> {
    const node = await this.getNode(projectId, nodeId);

    const [callers, callees, references] = await Promise.all([
      this.graph.callers(projectId, nodeId, limit),
      this.graph.callees(projectId, nodeId, limit),
      this.graph.references(projectId, nodeId, limit),
    ]);

    return { node, callers, callees, references };
  }

  async getCallers(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    await this.getNode(projectId, nodeId);
    return this.graph.callers(projectId, nodeId, limit);
  }

  async getCallees(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    await this.getNode(projectId, nodeId);
    return this.graph.callees(projectId, nodeId, limit);
  }

  async search(projectId: string, term: string, limit: number): Promise<CodeNode[]> {
    await this.projects.getById(projectId);
    return this.graph.searchNodes(projectId, term, limit);
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
