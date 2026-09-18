import type {
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  GraphDirection,
  NodeTypeCounts,
  RelatedNode,
  RelationshipCounts,
} from '@ckg/shared';
import {
  BEHAVIOURAL_RELATIONSHIPS,
  DEPENDENCY_RELATIONSHIPS,
  FILE_LIKE_NODE_TYPES,
  GRAPH_OVERVIEW_NODE_TYPES,
  SOURCE_TREE_NODE_TYPES,
  GRAPH_PATH_NODE_BUDGET,
  isCodeNodeType,
  STRUCTURAL_RELATIONSHIPS,
} from '@ckg/shared';
import type { Database, Queryable } from '../client.js';
import {
  CODE_EDGE_COLUMNS,
  CODE_NODE_COLUMNS,
  toCodeEdge,
  toCodeNode,
  toRelatedNode,
  type CodeEdgeRow,
  type CodeNodeRow,
  type RelatedNodeRow,
} from './row-mappers.js';

/** Rows per INSERT statement when persisting a graph. */
const INSERT_CHUNK_SIZE = 1000;

/** Relationships that answer "which APIs reach this node". */
const API_RELATIONSHIPS: readonly CodeRelationship[] = ['ROUTES_TO'];

/** Relationships that answer "which data stores does this node touch". */
const DATA_RELATIONSHIPS: readonly CodeRelationship[] = [
  'READS_FROM',
  'WRITES_TO',
  'PUBLISHES',
  'SUBSCRIBES',
];

/** Node types that count as a data store for the purposes of the above. */
const DATA_NODE_TYPES: readonly CodeNodeType[] = ['database', 'table', 'queue', 'event'];

/**
 * Relationships that answer "what does the repository say about this".
 *
 * Both directions: a class wants the sections that describe it, and a document
 * wants what it describes and what it links to.
 */
const DOCUMENTATION_RELATIONSHIPS: readonly CodeRelationship[] = ['DOCUMENTS', 'LINKS_TO'];

/**
 * Relationships that answer "what declares this, and what fulfils it".
 *
 * `DEFINES` runs from a declarative file to the resource it brings into
 * existence, `IMPLEMENTED_BY` from a promised operation to the code that keeps
 * the promise. They share a section because they are the two halves of one
 * question — where did this come from, and is it real.
 */
const CONTRACT_RELATIONSHIPS: readonly CodeRelationship[] = ['DEFINES', 'IMPLEMENTED_BY'];

/**
 * Relationships that answer "what implements this, and what does it implement".
 *
 * Both directions are meaningful and the caller is told which it got, so an
 * interface lists its implementers and a class lists what it conforms to
 * without two endpoints saying almost the same thing.
 */
const IMPLEMENTATION_RELATIONSHIPS: readonly CodeRelationship[] = ['IMPLEMENTS', 'EXTENDS'];

/** Node types that make up the repository tree. */
/**
 * Node types the source tree is made of.
 *
 * Not just `file`: a repository graph represents a README as a `document`, a
 * compose file as a `config` and a specification as an `api_spec`, and an
 * explorer that only asked for `file` would show a project as a `src/`
 * directory with nothing around it.
 */
const TREE_NODE_TYPES: readonly CodeNodeType[] = [...SOURCE_TREE_NODE_TYPES];

export interface TraverseOptions {
  rootNodeId: string;
  depth: number;
  nodeTypes?: CodeNodeType[] | undefined;
  relationships?: CodeRelationship[] | undefined;
  /** Which way the walk may follow an edge. Defaults to both. */
  direction?: GraphDirection | undefined;
  limit: number;
}

export interface OverviewOptions {
  nodeTypes?: CodeNodeType[] | undefined;
  relationships?: CodeRelationship[] | undefined;
  /** Ranked ahead of everything else, whatever their degree. */
  priorityNodeTypes?: CodeNodeType[] | undefined;
  limit: number;
}

export interface SearchOptions {
  nodeTypes?: CodeNodeType[] | undefined;
  limit: number;
  offset: number;
}

export interface SearchResult {
  nodes: CodeNode[];
  total: number;
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
  relationshipCounts: RelationshipCounts;
}

/** Everything the node inspector shows, gathered in one query. */
export interface NodeRelations {
  callers: CodeNode[];
  callees: CodeNode[];
  references: CodeNode[];
  dependencies: RelatedNode[];
  dependents: RelatedNode[];
  apis: RelatedNode[];
  databases: RelatedNode[];
  /** Prose about this node, and the documents it links to. */
  documentation: RelatedNode[];
  /** What declares this node, and what fulfils what it declares. */
  contracts: RelatedNode[];
}

export type NeighbourDirection = 'incoming' | 'outgoing';

/** One level of the repository tree, derived from the graph's path nodes. */
export interface TreeEntry {
  path: string;
  name: string;
  type: 'directory' | 'file';
  nodeId: string;
}

export interface TreeLevel {
  path: string;
  parentPath: string | null;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface PathOptions {
  maxDepth: number;
  /** False walks edges both ways, which is the undirected fallback. */
  directed: boolean;
  relationships?: CodeRelationship[] | undefined;
  nodeTypes?: CodeNodeType[] | undefined;
  /** Nodes the search may visit before giving up. */
  nodeBudget?: number | undefined;
}

/** One edge crossed by a route, and which way it was crossed. */
export interface PathHop {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationship: CodeRelationship;
  /** True when the route crossed this edge against its direction. */
  reversed: boolean;
  metadata: Record<string, unknown> | null;
}

export interface PathResult {
  found: boolean;
  /** Node ids from `from` to `to` inclusive; empty when there is no route. */
  nodeIds: string[];
  hops: PathHop[];
  /** True when the node budget ran out before the search could conclude. */
  truncated: boolean;
}

interface TreeRow {
  id: string;
  name: string;
  file_path: string;
  node_type: string;
}

interface PathEdgeRow {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  relationship: string;
  metadata: Record<string, unknown> | null;
  other_id: string;
  reversed: boolean;
}

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
        `INSERT INTO code_nodes (
           id, project_id, node_type, name, qualified_name, file_path,
           start_line, start_character, end_line, end_character, metadata
         )
         SELECT * FROM unnest(
           $1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[],
           $7::int[], $8::int[], $9::int[], $10::int[], $11::jsonb[]
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          batch.map((node) => node.id),
          batch.map(() => projectId),
          batch.map((node) => node.type),
          batch.map((node) => node.name),
          batch.map((node) => node.qualifiedName ?? null),
          batch.map((node) => node.filePath ?? null),
          batch.map((node) => node.startLine ?? null),
          batch.map((node) => node.startCharacter ?? null),
          batch.map((node) => node.endLine ?? null),
          batch.map((node) => node.endCharacter ?? null),
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

  /**
   * Finds nodes by name, qualified name or path — which between them cover a
   * symbol (`UserService`), a member (`UserService.getUser`), a file
   * (`user.service.ts`), a directory (`src/services`) and an API route
   * (`POST /users`), because each of those is one of those three columns.
   *
   * A term that names a node type (`api`, `table`) also matches every node of
   * that type, so "show me the APIs" works from the same box.
   *
   * Ordering is a fixed ladder, so the same term always produces the same page:
   *
   *   0  the symbol's own name, exactly
   *   1  its qualified name, exactly (`UserService.getUser`)
   *   2  a file, by full path or by file name (`user.service.ts`)
   *   3  a name prefix, 4 a qualified-name prefix, 5 a path prefix
   *   6  a dotted token of a qualified name (`getUser` inside `X.getUser`)
   *   7  everything else that merely contains the term
   *
   * Shorter names win a tie, then name, then id — which leaves no room for the
   * planner's row order to decide anything a caller can see.
   */
  async searchNodes(
    projectId: string,
    term: string,
    options: SearchOptions,
  ): Promise<SearchResult> {
    const needle = term.trim().toLowerCase();
    const contains = `%${needle}%`;
    const prefix = `${needle}%`;
    // `%/user.service.ts` — a path ending in the term is a file match by name.
    const fileName = `%/${needle}`;
    // `%.getUser` — the term is the last dotted segment of a qualified name.
    const token = `%.${needle}`;
    const nodeTypes = options.nodeTypes ?? null;
    // A term that is itself a node type is treated as a type filter as well as
    // a text match.
    const typeTerm = isCodeNodeType(needle) ? needle : null;

    // The two queries share a predicate but not a parameter list: Postgres
    // cannot infer the type of a parameter a statement never references, so
    // the clause is written once and numbered per statement.
    const matchClause = (
      project: number,
      like: number,
      types: number,
      type: number,
    ): string => `
      WHERE project_id = $${String(project)}
        AND ($${String(types)}::text[] IS NULL OR node_type = ANY($${String(types)}::text[]))
        AND (
          lower(name) LIKE $${String(like)}
          OR lower(coalesce(qualified_name, '')) LIKE $${String(like)}
          OR lower(coalesce(file_path, '')) LIKE $${String(like)}
          OR ($${String(type)}::text IS NOT NULL AND node_type = $${String(type)}::text)
        )`;

    const [page, count] = await Promise.all([
      this.db.query<CodeNodeRow>(
        `SELECT ${CODE_NODE_COLUMNS}
           FROM code_nodes
          ${matchClause(1, 2, 5, 6)}
          ORDER BY
            CASE
              WHEN lower(name) = $3 THEN 0
              WHEN lower(coalesce(qualified_name, '')) = $3 THEN 1
              WHEN lower(coalesce(file_path, '')) = $3
                OR lower(coalesce(file_path, '')) LIKE $9 THEN 2
              WHEN lower(name) LIKE $4 THEN 3
              WHEN lower(coalesce(qualified_name, '')) LIKE $4 THEN 4
              WHEN lower(coalesce(file_path, '')) LIKE $4 THEN 5
              WHEN lower(coalesce(qualified_name, '')) LIKE $10 THEN 6
              ELSE 7
            END,
            length(name),
            name,
            id
          LIMIT $7 OFFSET $8`,
        [
          projectId,
          contains,
          needle,
          prefix,
          nodeTypes,
          typeTerm,
          options.limit,
          options.offset,
          fileName,
          token,
        ],
      ),
      this.db.query<{ total: number }>(
        `SELECT count(*)::bigint AS total FROM code_nodes ${matchClause(1, 2, 3, 4)}`,
        [projectId, contains, nodeTypes, typeTerm],
      ),
    ]);

    return { nodes: page.rows.map(toCodeNode), total: count.rows[0]?.total ?? 0 };
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

  /** Counts per node type and per relationship, for the composition bar and
   * for hiding filters a project has no edges for. */
  async composition(projectId: string): Promise<GraphComposition> {
    const [counts, perType, perRelationship] = await Promise.all([
      this.counts(projectId),
      this.db.query<{ node_type: string; count: number }>(
        `SELECT node_type, count(*)::bigint AS count
           FROM code_nodes
          WHERE project_id = $1
          GROUP BY node_type`,
        [projectId],
      ),
      this.db.query<{ relationship: string; count: number }>(
        `SELECT relationship, count(*)::bigint AS count
           FROM code_edges
          WHERE project_id = $1
          GROUP BY relationship`,
        [projectId],
      ),
    ]);

    const nodeTypeCounts: NodeTypeCounts = {};
    for (const row of perType.rows) {
      nodeTypeCounts[row.node_type as CodeNodeType] = row.count;
    }

    const relationshipCounts: RelationshipCounts = {};
    for (const row of perRelationship.rows) {
      relationshipCounts[row.relationship as CodeRelationship] = row.count;
    }

    return { ...counts, nodeTypeCounts, relationshipCounts };
  }

  /**
   * Breadth-limited walk outward from a root node. Both the relationship filter
   * and the node-type filter are applied *during* expansion, so a filtered
   * traversal never reaches through a node the caller excluded.
   *
   * `direction` narrows which end of an edge the walk may arrive from:
   * `outgoing` follows source → target only, which is what "what does this
   * reach" means, and `incoming` the reverse.
   */
  async traverse(projectId: string, options: TraverseOptions): Promise<GraphResult> {
    const relationships = options.relationships ?? null;
    const nodeTypes = options.nodeTypes ?? null;
    const direction: GraphDirection = options.direction ?? 'both';

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
            AND (
                  ($7 <> 'incoming' AND e.source_node_id = w.id)
               OR ($7 <> 'outgoing' AND e.target_node_id = w.id)
                )
            AND ($4::text[] IS NULL OR e.relationship = ANY($4::text[]))
           JOIN code_nodes nxt
             ON nxt.project_id = $1
            AND nxt.id = CASE WHEN e.source_node_id = w.id
                              THEN e.target_node_id ELSE e.source_node_id END
            AND ($5::text[] IS NULL OR nxt.node_type = ANY($5::text[]))
          WHERE w.depth < $3
       )
       SELECT id FROM walk GROUP BY id ORDER BY min(depth), id LIMIT $6`,
      [
        projectId,
        options.rootNodeId,
        options.depth,
        relationships,
        nodeTypes,
        options.limit + 1,
        direction,
      ],
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
   *
   * `priorityNodeTypes` lets a projection put its subject first: in an
   * architecture view the API routes and the data stores are the point, even
   * when some class has a higher degree than either.
   */
  async overview(projectId: string, options: OverviewOptions): Promise<GraphResult> {
    const relationships = options.relationships ?? [...BEHAVIOURAL_RELATIONSHIPS];
    const nodeTypes = options.nodeTypes ?? [...GRAPH_OVERVIEW_NODE_TYPES];
    const priority = options.priorityNodeTypes?.length ? options.priorityNodeTypes : null;

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
        ORDER BY
          CASE WHEN $5::text[] IS NOT NULL AND n.node_type = ANY($5::text[]) THEN 0 ELSE 1 END,
          d.degree DESC,
          n.name,
          n.id
        LIMIT $4`,
      [projectId, relationships, nodeTypes, options.limit + 1, priority],
    );

    const truncated = ranked.rows.length > options.limit;
    const ids = ranked.rows.slice(0, options.limit).map((row) => row.id);

    if (ids.length === 0) {
      return { nodes: [], edges: [], truncated: false };
    }

    const graph = await this.loadInducedSubgraph(projectId, ids, relationships);
    return { ...graph, truncated };
  }

  /**
   * Nodes plus every edge whose two endpoints are both in `ids`.
   *
   * Nodes come back in the order `ids` were selected in — nearest-first for a
   * traversal, highest-ranked first for an overview — rather than by id, so a
   * caller reading the first few is reading the most relevant few.
   */
  private async loadInducedSubgraph(
    projectId: string,
    ids: string[],
    relationships: CodeRelationship[] | null,
  ): Promise<CodeGraph> {
    const [nodes, edges] = await Promise.all([
      this.db.query<CodeNodeRow>(
        `SELECT ${CODE_NODE_COLUMNS} FROM code_nodes
          WHERE project_id = $1 AND id = ANY($2::text[])
          ORDER BY array_position($2::text[], id)`,
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
    relationships: readonly CodeRelationship[],
    limit: number,
  ): Promise<CodeNode[]> {
    const [anchorColumn, otherColumn] =
      direction === 'outgoing'
        ? ['source_node_id', 'target_node_id']
        : ['target_node_id', 'source_node_id'];

    const result = await this.db.query<CodeNodeRow>(
      `SELECT DISTINCT ${prefixed(CODE_NODE_COLUMNS, 'n')}
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

  /**
   * Everything the node inspector needs, as one query per direction rather than
   * one per section.
   *
   * The naive version of this is seven queries — callers, callees, references,
   * dependencies, dependents, apis, databases — which is the N+1 pattern with
   * extra steps. Both directions are read once, with the relationship carried
   * alongside each row, and the buckets are assigned here.
   */
  async nodeRelations(
    projectId: string,
    nodeId: string,
    limitPerSection: number,
  ): Promise<NodeRelations> {
    const relationships = [
      'CALLS',
      'REFERENCES',
      ...DEPENDENCY_RELATIONSHIPS,
      ...API_RELATIONSHIPS,
      ...DATA_RELATIONSHIPS,
      ...DOCUMENTATION_RELATIONSHIPS,
      ...CONTRACT_RELATIONSHIPS,
    ];

    // The per-section limit is applied after bucketing; the query itself is
    // capped generously so a hub node cannot be used to read the whole graph.
    const hardLimit = Math.max(limitPerSection * relationships.length, limitPerSection) + 1;

    const result = await this.db.query<RelatedNodeRow>(
      `SELECT ${prefixed(CODE_NODE_COLUMNS, 'n')}, x.relationship, x.direction,
              x.metadata AS edge_metadata
         FROM (
           SELECT target_node_id AS id, relationship, 'outgoing' AS direction, metadata
             FROM code_edges
            WHERE project_id = $1 AND source_node_id = $2 AND relationship = ANY($3::text[])
           UNION ALL
           SELECT source_node_id AS id, relationship, 'incoming' AS direction, metadata
             FROM code_edges
            WHERE project_id = $1 AND target_node_id = $2 AND relationship = ANY($3::text[])
         ) x
         JOIN code_nodes n ON n.id = x.id AND n.project_id = $1
        ORDER BY x.relationship, n.name, n.id
        LIMIT $4`,
      [projectId, nodeId, relationships, hardLimit],
    );

    const relations: NodeRelations = {
      callers: [],
      callees: [],
      references: [],
      dependencies: [],
      dependents: [],
      apis: [],
      databases: [],
      documentation: [],
      contracts: [],
    };

    for (const row of result.rows) {
      const related = toRelatedNode(row);
      const relationship = related.relationship;

      // The original three sections keep their plain `CodeNode` shape, because
      // that is the contract the existing clients were written against.
      if (relationship === 'CALLS') {
        const bucket = related.direction === 'incoming' ? relations.callers : relations.callees;
        pushLimited(bucket, plain(related), limitPerSection);
        continue;
      }
      if (relationship === 'REFERENCES' && related.direction === 'incoming') {
        pushLimited(relations.references, plain(related), limitPerSection);
        continue;
      }

      if (API_RELATIONSHIPS.includes(relationship) && related.type === 'api') {
        pushLimited(relations.apis, related, limitPerSection);
        continue;
      }

      if (DATA_RELATIONSHIPS.includes(relationship) && DATA_NODE_TYPES.includes(related.type)) {
        pushLimited(relations.databases, related, limitPerSection);
        continue;
      }

      if (DOCUMENTATION_RELATIONSHIPS.includes(relationship)) {
        pushLimited(relations.documentation, related, limitPerSection);
        continue;
      }

      if (CONTRACT_RELATIONSHIPS.includes(relationship)) {
        pushLimited(relations.contracts, related, limitPerSection);
        continue;
      }

      if (DEPENDENCY_RELATIONSHIPS.includes(relationship)) {
        const bucket =
          related.direction === 'outgoing' ? relations.dependencies : relations.dependents;
        pushLimited(bucket, related, limitPerSection);
      }
    }

    return relations;
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

  /**
   * Neighbours along specific relationships, each carrying the relationship and
   * its evidence.
   *
   * `both` reads the two directions in one statement rather than two round
   * trips, and every caller is told which direction an entry came from — which
   * is what lets "implementations" mean both "implements this" and "is
   * implemented by this" without the reader having to guess.
   */
  async relatedNeighbours(
    projectId: string,
    nodeId: string,
    relationships: readonly CodeRelationship[],
    direction: NeighbourDirection | 'both',
    limit: number,
  ): Promise<RelatedNode[]> {
    const result = await this.db.query<RelatedNodeRow>(
      `SELECT ${prefixed(CODE_NODE_COLUMNS, 'n')}, x.relationship, x.direction,
              x.metadata AS edge_metadata
         FROM (
           SELECT target_node_id AS id, relationship, 'outgoing' AS direction, metadata
             FROM code_edges
            WHERE project_id = $1 AND source_node_id = $2
              AND relationship = ANY($3::text[])
              AND $5 <> 'incoming'
           UNION ALL
           SELECT source_node_id AS id, relationship, 'incoming' AS direction, metadata
             FROM code_edges
            WHERE project_id = $1 AND target_node_id = $2
              AND relationship = ANY($3::text[])
              AND $5 <> 'outgoing'
         ) x
         JOIN code_nodes n ON n.id = x.id AND n.project_id = $1
        ORDER BY x.direction, x.relationship, n.name, n.id
        LIMIT $4`,
      [projectId, nodeId, relationships, limit, direction],
    );

    return result.rows.map(toRelatedNode);
  }

  /** What this node depends on, along the dependency-bearing relationships. */
  async dependencies(projectId: string, nodeId: string, limit: number): Promise<RelatedNode[]> {
    return this.relatedNeighbours(projectId, nodeId, DEPENDENCY_RELATIONSHIPS, 'outgoing', limit);
  }

  /** What depends on this node. */
  async dependents(projectId: string, nodeId: string, limit: number): Promise<RelatedNode[]> {
    return this.relatedNeighbours(projectId, nodeId, DEPENDENCY_RELATIONSHIPS, 'incoming', limit);
  }

  /**
   * Both sides of the inheritance relation: incoming entries implement or
   * extend this node, outgoing entries are what it implements or extends.
   */
  async implementations(
    projectId: string,
    nodeId: string,
    limit: number,
  ): Promise<RelatedNode[]> {
    return this.relatedNeighbours(projectId, nodeId, IMPLEMENTATION_RELATIONSHIPS, 'both', limit);
  }

  /**
   * The node that CONTAINS this one: its class, its file, its directory.
   *
   * At most one, because containment is a tree — the builder emits exactly one
   * CONTAINS edge into every node below the repository root.
   */
  async parent(projectId: string, nodeId: string): Promise<CodeNode | null> {
    const result = await this.db.query<CodeNodeRow>(
      `SELECT ${prefixed(CODE_NODE_COLUMNS, 'n')}
         FROM code_edges e
         JOIN code_nodes n ON n.id = e.source_node_id AND n.project_id = $1
        WHERE e.project_id = $1
          AND e.target_node_id = $2
          AND e.relationship = 'CONTAINS'
        ORDER BY n.id
        LIMIT 1`,
      [projectId, nodeId],
    );
    const row = result.rows[0];
    return row ? toCodeNode(row) : null;
  }

  /** Nodes this one CONTAINS, in source order where positions were indexed. */
  async children(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    const result = await this.db.query<CodeNodeRow>(
      `SELECT ${prefixed(CODE_NODE_COLUMNS, 'n')}
         FROM code_edges e
         JOIN code_nodes n ON n.id = e.target_node_id AND n.project_id = $1
        WHERE e.project_id = $1
          AND e.source_node_id = $2
          AND e.relationship = 'CONTAINS'
        ORDER BY n.start_line NULLS LAST, n.name, n.id
        LIMIT $3`,
      [projectId, nodeId, limit],
    );
    return result.rows.map(toCodeNode);
  }

  /**
   * The node standing for a repository-relative path, if the graph has one.
   *
   * Any of the file-like types, in their declared order of preference: a path
   * indexed by the compiler *and* described by an analyzer keeps its `file`
   * node, and a README that only an analyzer saw is found as a `document`.
   */
  async findFileNode(projectId: string, filePath: string): Promise<CodeNode | null> {
    const result = await this.db.query<CodeNodeRow>(
      `SELECT ${CODE_NODE_COLUMNS} FROM code_nodes
        WHERE project_id = $1 AND node_type = ANY($3::text[]) AND file_path = $2
        ORDER BY array_position($3::text[], node_type), id
        LIMIT 1`,
      [projectId, filePath, FILE_LIKE_NODE_TYPES],
    );
    const row = result.rows[0];
    return row ? toCodeNode(row) : null;
  }

  /**
   * One level of the repository tree, read off the `directory` and `file` nodes
   * the builder already created.
   *
   * A level at a time, not a whole tree: the point of deriving this from the
   * graph is that opening a project costs one small query rather than a second
   * filesystem walk. Prefix matching is done with `left(...) =` rather than
   * `LIKE` so a path containing `%` cannot widen its own query.
   */
  async treeLevel(projectId: string, directoryPath: string, limit: number): Promise<TreeLevel> {
    const normalized = directoryPath.replace(/^\/+|\/+$/g, '');
    const prefix = normalized === '' ? '' : `${normalized}/`;
    // Where the child's own name starts, 1-based for `substr`.
    const nameOffset = prefix.length + 1;

    const result = await this.db.query<TreeRow>(
      `SELECT id, name, file_path, node_type
         FROM code_nodes
        WHERE project_id = $1
          AND node_type = ANY($2::text[])
          AND file_path IS NOT NULL
          AND ($3 = '' OR left(file_path, $4) = $3)
          AND length(file_path) > $4
          AND position('/' in substr(file_path, $5)) = 0
        ORDER BY node_type, name, id
        LIMIT $6`,
      [projectId, TREE_NODE_TYPES, prefix, prefix.length, nameOffset, limit + 1],
    );

    const truncated = result.rows.length > limit;
    const rows = truncated ? result.rows.slice(0, limit) : result.rows;

    const parentPath =
      normalized === '' ? null : normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';

    return {
      path: normalized,
      parentPath,
      entries: rows.map((row) => ({
        path: row.file_path,
        name: row.name,
        // `node_type` is constrained to the two tree types by the query.
        // The wire contract distinguishes a directory from everything else; a
        // caller that wants to know a file is a document reads the node.
        type: row.node_type === 'directory' ? 'directory' : 'file',
        nodeId: row.id,
      })),
      truncated,
    };
  }

  /**
   * The shortest route between two nodes, walked breadth-first one level at a
   * time.
   *
   * Level-by-level rather than a single recursive CTE on purpose. A CTE that
   * carries its own path array is exponential on a graph with cycles, and a hub
   * node in a real repository reaches most of the graph within three hops —
   * which is exactly the query someone types first. Expanding a level per
   * statement keeps the work proportional to the frontier, lets the search stop
   * the moment the target appears, and gives the node budget somewhere to bite.
   *
   * Determinism comes from the ORDER BY: the first row that introduces a node
   * is its predecessor, and that row is chosen by a total order over
   * (node, direction, relationship, anchor, edge) rather than by whatever the
   * planner returned first.
   */
  async findPath(
    projectId: string,
    from: string,
    to: string,
    options: PathOptions,
  ): Promise<PathResult> {
    if (from === to) {
      return { found: true, nodeIds: [from], hops: [], truncated: false };
    }

    const relationships = options.relationships ?? null;
    const nodeTypes = options.nodeTypes ?? null;
    const budget = options.nodeBudget ?? GRAPH_PATH_NODE_BUDGET;
    const directed = options.directed;

    const cameFrom = new Map<string, PathHop>();
    const seen = new Set<string>([from]);
    let frontier: string[] = [from];
    let truncated = false;

    for (let depth = 0; depth < options.maxDepth && frontier.length > 0; depth += 1) {
      const level = await this.db.query<PathEdgeRow>(
        `SELECT e.id AS edge_id, e.source_node_id, e.target_node_id, e.relationship,
                e.metadata, e.target_node_id AS other_id, false AS reversed
           FROM code_edges e
           JOIN code_nodes n ON n.id = e.target_node_id AND n.project_id = $1
          WHERE e.project_id = $1
            AND e.source_node_id = ANY($2::text[])
            AND ($3::text[] IS NULL OR e.relationship = ANY($3::text[]))
            AND ($4::text[] IS NULL OR n.node_type = ANY($4::text[]))
          UNION ALL
         SELECT e.id AS edge_id, e.source_node_id, e.target_node_id, e.relationship,
                e.metadata, e.source_node_id AS other_id, true AS reversed
           FROM code_edges e
           JOIN code_nodes n ON n.id = e.source_node_id AND n.project_id = $1
          WHERE $5::boolean = false
            AND e.project_id = $1
            AND e.target_node_id = ANY($2::text[])
            AND ($3::text[] IS NULL OR e.relationship = ANY($3::text[]))
            AND ($4::text[] IS NULL OR n.node_type = ANY($4::text[]))
          ORDER BY other_id, reversed, relationship, source_node_id, target_node_id, edge_id`,
        [projectId, frontier, relationships, nodeTypes, directed],
      );

      const next: string[] = [];

      for (const row of level.rows) {
        if (seen.has(row.other_id)) continue;

        if (seen.size >= budget) {
          truncated = true;
          break;
        }

        seen.add(row.other_id);
        cameFrom.set(row.other_id, {
          edgeId: row.edge_id,
          sourceNodeId: row.source_node_id,
          targetNodeId: row.target_node_id,
          relationship: row.relationship as CodeRelationship,
          reversed: row.reversed,
          metadata: row.metadata,
        });

        if (row.other_id === to) {
          return { ...rebuildPath(cameFrom, from, to), truncated };
        }

        next.push(row.other_id);
      }

      if (truncated) break;
      frontier = next;
    }

    return { found: false, nodeIds: [], hops: [], truncated };
  }

  /** Nodes and edges for an already-found route, in the order it is walked. */
  async loadPathGraph(
    projectId: string,
    nodeIds: readonly string[],
    edgeIds: readonly string[],
  ): Promise<CodeGraph> {
    if (nodeIds.length === 0) return { nodes: [], edges: [] };

    const [nodes, edges] = await Promise.all([
      this.db.query<CodeNodeRow>(
        `SELECT ${CODE_NODE_COLUMNS} FROM code_nodes
          WHERE project_id = $1 AND id = ANY($2::text[])
          ORDER BY array_position($2::text[], id)`,
        [projectId, nodeIds],
      ),
      edgeIds.length === 0
        ? Promise.resolve({ rows: [] as CodeEdgeRow[] })
        : this.db.query<CodeEdgeRow>(
            `SELECT ${CODE_EDGE_COLUMNS} FROM code_edges
              WHERE project_id = $1 AND id = ANY($2::text[])
              ORDER BY array_position($2::text[], id)`,
            [projectId, edgeIds],
          ),
    ]);

    return { nodes: nodes.rows.map(toCodeNode), edges: edges.rows.map(toCodeEdge) };
  }
}

/** Walks the predecessor map back from the target and reverses it. */
function rebuildPath(
  cameFrom: ReadonlyMap<string, PathHop>,
  from: string,
  to: string,
): { found: boolean; nodeIds: string[]; hops: PathHop[] } {
  const nodeIds: string[] = [to];
  const hops: PathHop[] = [];

  let cursor = to;
  // Bounded by the map: every step removes one node that can never recur,
  // because a node enters `cameFrom` exactly once.
  while (cursor !== from) {
    const hop = cameFrom.get(cursor);
    if (!hop) return { found: false, nodeIds: [], hops: [] };
    hops.push(hop);
    cursor = hop.reversed ? hop.targetNodeId : hop.sourceNodeId;
    nodeIds.push(cursor);
  }

  nodeIds.reverse();
  hops.reverse();
  return { found: true, nodeIds, hops };
}

/** `id, name` -> `n.id, n.name`, for queries that join. */
function prefixed(columns: string, alias: string): string {
  return columns
    .split(', ')
    .map((column) => `${alias}.${column}`)
    .join(', ');
}

function pushLimited<T>(bucket: T[], value: T, limit: number): void {
  if (bucket.length < limit) bucket.push(value);
}

/** Drops the relationship fields, for the sections whose contract predates them. */
function plain(related: RelatedNode): CodeNode {
  const { relationship, direction, confidence, evidenceSource, ...node } = related;
  void relationship;
  void direction;
  void confidence;
  void evidenceSource;
  return node;
}

export { BEHAVIOURAL_RELATIONSHIPS, STRUCTURAL_RELATIONSHIPS };
