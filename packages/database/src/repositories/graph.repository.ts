import type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
} from '@ckg/shared';
import { GRAPH_OVERVIEW_NODE_TYPES } from '@ckg/shared';
import type { NodeTypeCounts } from '@ckg/shared';
import type { Database, Queryable } from '../client.js';
import {
  CODE_EDGE_COLUMNS,
  CODE_NODE_COLUMNS,
  toCodeEdge,
  toCodeNode,
  type CodeEdgeRow,
  type CodeNodeRow,
} from './row-mappers.js';

/** Relationships that describe structure rather than behaviour. */
const STRUCTURAL_RELATIONSHIPS: readonly CodeRelationship[] = ['CONTAINS'];

const BEHAVIOURAL_RELATIONSHIPS: readonly CodeRelationship[] = [
  'CALLS',
  'REFERENCES',
  'IMPLEMENTS',
  'EXTENDS',
  'IMPORTS',
];

/** Rows per INSERT statement when persisting a graph. */
const INSERT_CHUNK_SIZE = 1000;

export interface TraverseOptions {
  rootNodeId: string;
  depth: number;
  nodeTypes?: CodeNodeType[] | undefined;
  relationships?: CodeRelationship[] | undefined;
  limit: number;
}

export interface OverviewOptions {
  nodeTypes?: CodeNodeType[] | undefined;
  relationships?: CodeRelationship[] | undefined;
  limit: number;
}

export interface GraphResult extends CodeGraph {
  /** True when the node limit cut the result short. */
  truncated: boolean;
}

export interface GraphCounts {
  nodeCount: number;
  edgeCount: number;
}

export interface GraphComposition extends GraphCounts {
  nodeTypeCounts: NodeTypeCounts;
}

export type NeighbourDirection = 'incoming' | 'outgoing';

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * All SQL that touches the graph tables. Traversal happens in the database with
 * a recursive CTE so a large repository never has to be shipped to Node just to
 * walk two hops.
 */
export class GraphRepository {
  constructor(private readonly db: Database) {}

  /**
   * Replaces a project's entire graph in one transaction. Re-analysis is
   * therefore atomic: readers see either the previous graph or the new one.
   * Stable ids mean an unchanged repository produces byte-identical rows.
   */
  async replaceProjectGraph(projectId: string, graph: CodeGraph): Promise<GraphCounts> {
    return this.db.transaction(async (tx) => {
      // Edges cascade from nodes, but deleting explicitly keeps the intent
      // obvious and the statement order stable.
      await tx.query('DELETE FROM code_edges WHERE project_id = $1', [projectId]);
      await tx.query('DELETE FROM code_nodes WHERE project_id = $1', [projectId]);

      await this.insertNodes(tx, projectId, graph.nodes);
      await this.insertEdges(tx, projectId, graph.edges);

      return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length };
    });
  }

  private async insertNodes(tx: Queryable, projectId: string, nodes: CodeNode[]): Promise<void> {
    for (const batch of chunk(nodes, INSERT_CHUNK_SIZE)) {
      await tx.query(
        `INSERT INTO code_nodes (id, project_id, node_type, name, file_path, start_line, end_line, metadata)
         SELECT * FROM unnest(
           $1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::jsonb[]
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          batch.map((node) => node.id),
          batch.map(() => projectId),
          batch.map((node) => node.type),
          batch.map((node) => node.name),
          batch.map((node) => node.filePath ?? null),
          batch.map((node) => node.startLine ?? null),
          batch.map((node) => node.endLine ?? null),
          batch.map((node) => JSON.stringify(node.metadata ?? {})),
        ],
      );
    }
  }

  private async insertEdges(tx: Queryable, projectId: string, edges: CodeEdge[]): Promise<void> {
    for (const batch of chunk(edges, INSERT_CHUNK_SIZE)) {
      await tx.query(
        `INSERT INTO code_edges (id, project_id, source_node_id, target_node_id, relationship, metadata)
         SELECT * FROM unnest(
           $1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::jsonb[]
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          batch.map((edge) => edge.id),
          batch.map(() => projectId),
          batch.map((edge) => edge.sourceNodeId),
          batch.map((edge) => edge.targetNodeId),
          batch.map((edge) => edge.relationship),
          batch.map((edge) => JSON.stringify(edge.metadata ?? {})),
        ],
      );
    }
  }

  async findNode(projectId: string, nodeId: string): Promise<CodeNode | null> {
    const result = await this.db.query<CodeNodeRow>(
      `SELECT ${CODE_NODE_COLUMNS} FROM code_nodes WHERE project_id = $1 AND id = $2`,
      [projectId, nodeId],
    );
    const row = result.rows[0];
    return row ? toCodeNode(row) : null;
  }

  /** The synthetic `repository` node created by the graph builder. */
  async findRootNode(projectId: string): Promise<CodeNode | null> {
    const result = await this.db.query<CodeNodeRow>(
      `SELECT ${CODE_NODE_COLUMNS} FROM code_nodes
        WHERE project_id = $1 AND node_type = 'repository'
        ORDER BY id
        LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    return row ? toCodeNode(row) : null;
  }

  async searchNodes(projectId: string, term: string, limit: number): Promise<CodeNode[]> {
    const result = await this.db.query<CodeNodeRow>(
      `SELECT ${CODE_NODE_COLUMNS} FROM code_nodes
        WHERE project_id = $1
          AND (lower(name) LIKE $2 OR lower(coalesce(file_path, '')) LIKE $2)
        ORDER BY length(name), name, id
        LIMIT $3`,
      [projectId, `%${term.toLowerCase()}%`, limit],
    );
    return result.rows.map(toCodeNode);
  }

  async counts(projectId: string): Promise<GraphCounts> {
    const result = await this.db.query<{ node_count: number; edge_count: number }>(
      `SELECT
         (SELECT count(*)::bigint FROM code_nodes WHERE project_id = $1) AS node_count,
         (SELECT count(*)::bigint FROM code_edges WHERE project_id = $1) AS edge_count`,
      [projectId],
    );
    const row = result.rows[0];
    return { nodeCount: row?.node_count ?? 0, edgeCount: row?.edge_count ?? 0 };
  }

  /** Counts per node type, for the composition bar on the dashboard. */
  async composition(projectId: string): Promise<GraphComposition> {
    const [counts, perType] = await Promise.all([
      this.counts(projectId),
      this.db.query<{ node_type: string; count: number }>(
        `SELECT node_type, count(*)::bigint AS count
           FROM code_nodes
          WHERE project_id = $1
          GROUP BY node_type`,
        [projectId],
      ),
    ]);

    const nodeTypeCounts: NodeTypeCounts = {};
    for (const row of perType.rows) {
      nodeTypeCounts[row.node_type as CodeNodeType] = row.count;
    }

    return { ...counts, nodeTypeCounts };
  }

  /**
   * Breadth-limited walk outward from a root node. Both the relationship filter
   * and the node-type filter are applied *during* expansion, so a filtered
   * traversal never reaches through a node the caller excluded.
   */
  async traverse(projectId: string, options: TraverseOptions): Promise<GraphResult> {
    const relationships = options.relationships ?? null;
    const nodeTypes = options.nodeTypes ?? null;

    const reachable = await this.db.query<{ id: string }>(
      `WITH RECURSIVE walk(id, depth) AS (
         SELECT n.id, 0
           FROM code_nodes n
          WHERE n.project_id = $1 AND n.id = $2
         UNION
         SELECT nxt.id, w.depth + 1
           FROM walk w
           JOIN code_edges e
             ON e.project_id = $1
            AND (e.source_node_id = w.id OR e.target_node_id = w.id)
            AND ($4::text[] IS NULL OR e.relationship = ANY($4::text[]))
           JOIN code_nodes nxt
             ON nxt.project_id = $1
            AND nxt.id = CASE WHEN e.source_node_id = w.id
                              THEN e.target_node_id ELSE e.source_node_id END
            AND ($5::text[] IS NULL OR nxt.node_type = ANY($5::text[]))
          WHERE w.depth < $3
       )
       SELECT id FROM walk GROUP BY id ORDER BY min(depth), id LIMIT $6`,
      [projectId, options.rootNodeId, options.depth, relationships, nodeTypes, options.limit + 1],
    );

    const truncated = reachable.rows.length > options.limit;
    const ids = reachable.rows.slice(0, options.limit).map((row) => row.id);

    if (ids.length === 0) {
      return { nodes: [], edges: [], truncated: false };
    }

    const graph = await this.loadInducedSubgraph(projectId, ids, relationships);
    return { ...graph, truncated };
  }

  /**
   * Seed view for "show me this project" when no root node is given: the most
   * connected behavioural nodes and the edges between them. Structure-only
   * CONTAINS edges are excluded by default because they dominate degree counts
   * without saying anything about how the code behaves.
   */
  async overview(projectId: string, options: OverviewOptions): Promise<GraphResult> {
    const relationships = options.relationships ?? [...BEHAVIOURAL_RELATIONSHIPS];
    const nodeTypes = options.nodeTypes ?? [...GRAPH_OVERVIEW_NODE_TYPES];

    const ranked = await this.db.query<{ id: string }>(
      `WITH endpoints AS (
         SELECT source_node_id AS id FROM code_edges
          WHERE project_id = $1 AND relationship = ANY($2::text[])
         UNION ALL
         SELECT target_node_id AS id FROM code_edges
          WHERE project_id = $1 AND relationship = ANY($2::text[])
       ),
       degrees AS (
         SELECT id, count(*)::bigint AS degree FROM endpoints GROUP BY id
       )
       SELECT n.id
         FROM degrees d
         JOIN code_nodes n ON n.id = d.id AND n.project_id = $1
        WHERE ($3::text[] IS NULL OR n.node_type = ANY($3::text[]))
        ORDER BY d.degree DESC, n.name, n.id
        LIMIT $4`,
      [projectId, relationships, nodeTypes, options.limit + 1],
    );

    const truncated = ranked.rows.length > options.limit;
    const ids = ranked.rows.slice(0, options.limit).map((row) => row.id);

    if (ids.length === 0) {
      return { nodes: [], edges: [], truncated: false };
    }

    const graph = await this.loadInducedSubgraph(projectId, ids, relationships);
    return { ...graph, truncated };
  }

  /** Nodes plus every edge whose two endpoints are both in `ids`. */
  private async loadInducedSubgraph(
    projectId: string,
    ids: string[],
    relationships: CodeRelationship[] | null,
  ): Promise<CodeGraph> {
    const [nodes, edges] = await Promise.all([
      this.db.query<CodeNodeRow>(
        `SELECT ${CODE_NODE_COLUMNS} FROM code_nodes
          WHERE project_id = $1 AND id = ANY($2::text[])
          ORDER BY id`,
        [projectId, ids],
      ),
      this.db.query<CodeEdgeRow>(
        `SELECT ${CODE_EDGE_COLUMNS} FROM code_edges
          WHERE project_id = $1
            AND source_node_id = ANY($2::text[])
            AND target_node_id = ANY($2::text[])
            AND ($3::text[] IS NULL OR relationship = ANY($3::text[]))
          ORDER BY id`,
        [projectId, ids, relationships],
      ),
    ]);

    return { nodes: nodes.rows.map(toCodeNode), edges: edges.rows.map(toCodeEdge) };
  }

  /**
   * Nodes one hop away along specific relationships.
   * `outgoing` follows source -> target, `incoming` follows target -> source.
   */
  async neighbours(
    projectId: string,
    nodeId: string,
    direction: NeighbourDirection,
    relationships: CodeRelationship[],
    limit: number,
  ): Promise<CodeNode[]> {
    const [anchorColumn, otherColumn] =
      direction === 'outgoing'
        ? ['source_node_id', 'target_node_id']
        : ['target_node_id', 'source_node_id'];

    const result = await this.db.query<CodeNodeRow>(
      `SELECT DISTINCT ${CODE_NODE_COLUMNS.split(', ')
        .map((column) => `n.${column}`)
        .join(', ')}
         FROM code_edges e
         JOIN code_nodes n ON n.id = e.${otherColumn} AND n.project_id = $1
        WHERE e.project_id = $1
          AND e.${anchorColumn} = $2
          AND e.relationship = ANY($3::text[])
        ORDER BY n.name, n.id
        LIMIT $4`,
      [projectId, nodeId, relationships, limit],
    );
    return result.rows.map(toCodeNode);
  }

  async callers(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    return this.neighbours(projectId, nodeId, 'incoming', ['CALLS'], limit);
  }

  async callees(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    return this.neighbours(projectId, nodeId, 'outgoing', ['CALLS'], limit);
  }

  /** Everything that points at this node with REFERENCES. */
  async references(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    return this.neighbours(projectId, nodeId, 'incoming', ['REFERENCES'], limit);
  }
}

export { BEHAVIOURAL_RELATIONSHIPS, STRUCTURAL_RELATIONSHIPS };
