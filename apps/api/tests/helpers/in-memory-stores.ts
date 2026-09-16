import { randomUUID } from 'node:crypto';
import type {
  AnalysisJob,
  GraphDirection,
  NodeTypeCounts,
  ProjectSummary,
  AnalysisStatus,
  CodeEdge,
  CodeGraph,
  CodeNode,
  CodeNodeType,
  CodeRelationship,
  Project,
  RelatedNode,
  RelationshipCounts,
  Repository,
} from '@ckg/shared';
import { DEPENDENCY_RELATIONSHIPS, TERMINAL_ANALYSIS_STATUSES } from '@ckg/shared';

/**
 * In-memory stands-in for the database repositories.
 *
 * The services depend on structural interfaces rather than the concrete
 * `@ckg/database` classes, so the whole API can be exercised without Postgres.
 * Behaviour that matters to the services — scoped lookups, one repository per
 * project, a single active analysis — is reproduced faithfully.
 */

const now = (): string => new Date().toISOString();

export class InMemoryProjectStore {
  readonly projects = new Map<string, Project>();

  async create(input: { name: string; description?: string | null }): Promise<Project> {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  async findById(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  async list(input: { limit: number; offset: number }): Promise<{
    items: Project[];
    total: number;
  }> {
    const all = [...this.projects.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return { items: all.slice(input.offset, input.offset + input.limit), total: all.length };
  }

  /**
   * Mirrors the SQL listing: each project joined to its repository, its most
   * recent run and its graph size. Wired to the other in-memory stores so the
   * shape the dashboard consumes is exercised, not stubbed.
   */
  async listSummaries(input: { limit: number; offset: number }): Promise<{
    items: ProjectSummary[];
    total: number;
  }> {
    const page = await this.list(input);

    const items = await Promise.all(
      page.items.map(async (project): Promise<ProjectSummary> => {
        const repository = (await this.repositories?.findByProjectId(project.id)) ?? null;
        const jobs = (await this.analyses?.listByProject(project.id)) ?? [];
        const latest = jobs[0];
        const counts = (await this.graph?.counts(project.id)) ?? { nodeCount: 0, edgeCount: 0 };
        const nodeTypeCounts: NodeTypeCounts =
          (await this.graph?.nodeTypeCounts(project.id)) ?? {};

        return {
          ...project,
          repository: repository
            ? {
                sourceType: repository.sourceType,
                sourcePath: repository.sourcePath,
                commitHash: repository.commitHash,
              }
            : null,
          latestAnalysis: latest
            ? {
                id: latest.id,
                status: latest.status,
                language: latest.language,
                startedAt: latest.startedAt,
                completedAt: latest.completedAt,
                error: latest.error,
              }
            : null,
          nodeCount: counts.nodeCount,
          edgeCount: counts.edgeCount,
          nodeTypeCounts,
        };
      }),
    );

    return { items, total: page.total };
  }

  /** Set by the harness so summaries can join across the fakes. */
  repositories?: InMemoryRepositoryStore;
  analyses?: InMemoryAnalysisJobStore;
  graph?: InMemoryGraphStore;
}

export class InMemoryRepositoryStore {
  readonly byProject = new Map<string, Repository>();

  async upsert(input: {
    projectId: string;
    sourceType: Repository['sourceType'];
    sourcePath: string;
    commitHash?: string | null;
  }): Promise<Repository> {
    const existing = this.byProject.get(input.projectId);
    const repository: Repository = {
      id: existing?.id ?? randomUUID(),
      projectId: input.projectId,
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      commitHash: input.commitHash ?? null,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.byProject.set(input.projectId, repository);
    return repository;
  }

  async findByProjectId(projectId: string): Promise<Repository | null> {
    return this.byProject.get(projectId) ?? null;
  }
}

export class InMemoryAnalysisJobStore {
  readonly jobs = new Map<string, AnalysisJob>();

  async create(input: {
    projectId: string;
    repositoryId: string;
    language?: AnalysisJob['language'];
  }): Promise<AnalysisJob> {
    const job: AnalysisJob = {
      id: randomUUID(),
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      status: 'QUEUED',
      language: input.language ?? null,
      startedAt: null,
      completedAt: null,
      error: null,
      stats: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async findById(id: string): Promise<AnalysisJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async listByProject(projectId: string): Promise<AnalysisJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findActiveByProject(projectId: string): Promise<AnalysisJob | null> {
    return (
      [...this.jobs.values()].find(
        (job) => job.projectId === projectId && !TERMINAL_ANALYSIS_STATUSES.includes(job.status),
      ) ?? null
    );
  }

  /** Test affordance: move a job to a terminal state. */
  complete(id: string, status: AnalysisStatus = 'COMPLETED'): void {
    const job = this.jobs.get(id);
    if (job) this.jobs.set(id, { ...job, status, completedAt: now() });
  }
}

export class InMemoryGraphStore {
  private graph: CodeGraph = { nodes: [], edges: [] };

  setGraph(graph: CodeGraph): void {
    this.graph = graph;
  }

  private nodesOf(projectId: string): CodeNode[] {
    return this.graph.nodes.filter((node) => node.projectId === projectId);
  }

  private edgesOf(projectId: string): CodeEdge[] {
    return this.graph.edges.filter((edge) => edge.projectId === projectId);
  }

  async findNode(projectId: string, nodeId: string): Promise<CodeNode | null> {
    return this.nodesOf(projectId).find((node) => node.id === nodeId) ?? null;
  }

  async findRootNode(projectId: string): Promise<CodeNode | null> {
    return this.nodesOf(projectId).find((node) => node.type === 'repository') ?? null;
  }

  async counts(projectId: string): Promise<{ nodeCount: number; edgeCount: number }> {
    return {
      nodeCount: this.nodesOf(projectId).length,
      edgeCount: this.edgesOf(projectId).length,
    };
  }

  async nodeTypeCounts(projectId: string): Promise<NodeTypeCounts> {
    const counts: NodeTypeCounts = {};
    for (const node of this.nodesOf(projectId)) {
      counts[node.type] = (counts[node.type] ?? 0) + 1;
    }
    return counts;
  }

  async relationshipCounts(projectId: string): Promise<RelationshipCounts> {
    const counts: RelationshipCounts = {};
    for (const edge of this.edgesOf(projectId)) {
      counts[edge.relationship] = (counts[edge.relationship] ?? 0) + 1;
    }
    return counts;
  }

  async composition(projectId: string): Promise<{
    nodeCount: number;
    edgeCount: number;
    nodeTypeCounts: NodeTypeCounts;
    relationshipCounts: RelationshipCounts;
  }> {
    return {
      ...(await this.counts(projectId)),
      nodeTypeCounts: await this.nodeTypeCounts(projectId),
      relationshipCounts: await this.relationshipCounts(projectId),
    };
  }

  /** Mirrors the SQL: matches name, qualified name and path, and pages. */
  async searchNodes(
    projectId: string,
    term: string,
    options: { nodeTypes?: CodeNodeType[] | undefined; limit: number; offset: number },
  ): Promise<{ nodes: CodeNode[]; total: number }> {
    const needle = term.toLowerCase();
    const allowed = options.nodeTypes ? new Set(options.nodeTypes) : null;

    const matched = this.nodesOf(projectId)
      .filter((node) => !allowed || allowed.has(node.type))
      .filter(
        (node) =>
          node.name.toLowerCase().includes(needle) ||
          (node.qualifiedName ?? '').toLowerCase().includes(needle) ||
          (node.filePath ?? '').toLowerCase().includes(needle) ||
          node.type === needle,
      );

    return {
      nodes: matched.slice(options.offset, options.offset + options.limit),
      total: matched.length,
    };
  }

  async traverse(
    projectId: string,
    options: {
      rootNodeId: string;
      depth: number;
      nodeTypes?: CodeNodeType[] | undefined;
      relationships?: CodeRelationship[] | undefined;
      direction?: GraphDirection | undefined;
      limit: number;
    },
  ): Promise<CodeGraph & { truncated: boolean }> {
    const nodes = this.nodesOf(projectId);
    const edges = this.edgesOf(projectId);
    const byId = new Map(nodes.map((node) => [node.id, node]));

    const allowedTypes = options.nodeTypes ? new Set(options.nodeTypes) : null;
    const allowedRelationships = options.relationships ? new Set(options.relationships) : null;

    const depths = new Map<string, number>();
    const root = byId.get(options.rootNodeId);
    if (!root) return { nodes: [], edges: [], truncated: false };

    depths.set(root.id, 0);
    const queue = [root.id];
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift() as string;
      const depth = depths.get(current) as number;
      if (depth >= options.depth) continue;

      const direction = options.direction ?? 'both';

      for (const edge of edges) {
        if (allowedRelationships && !allowedRelationships.has(edge.relationship)) continue;

        const leaves = edge.sourceNodeId === current && direction !== 'incoming';
        const arrives = edge.targetNodeId === current && direction !== 'outgoing';
        if (!leaves && !arrives) continue;

        const other = edge.sourceNodeId === current ? edge.targetNodeId : edge.sourceNodeId;
        if (depths.has(other)) continue;

        const node = byId.get(other);
        if (!node) continue;
        if (allowedTypes && !allowedTypes.has(node.type)) continue;

        if (depths.size >= options.limit) {
          truncated = true;
          continue;
        }

        depths.set(other, depth + 1);
        queue.push(other);
      }
    }

    return {
      nodes: nodes.filter((node) => depths.has(node.id)),
      edges: edges.filter(
        (edge) =>
          depths.has(edge.sourceNodeId) &&
          depths.has(edge.targetNodeId) &&
          (!allowedRelationships || allowedRelationships.has(edge.relationship)),
      ),
      truncated,
    };
  }

  async overview(
    projectId: string,
    options: {
      nodeTypes?: CodeNodeType[] | undefined;
      relationships?: CodeRelationship[] | undefined;
      priorityNodeTypes?: CodeNodeType[] | undefined;
      limit: number;
    },
  ): Promise<CodeGraph & { truncated: boolean }> {
    const relationships = new Set<CodeRelationship>(
      options.relationships ?? ['CALLS', 'REFERENCES', 'IMPLEMENTS', 'EXTENDS', 'IMPORTS'],
    );
    const edges = this.edgesOf(projectId).filter((edge) => relationships.has(edge.relationship));
    const degree = new Map<string, number>();

    for (const edge of edges) {
      degree.set(edge.sourceNodeId, (degree.get(edge.sourceNodeId) ?? 0) + 1);
      degree.set(edge.targetNodeId, (degree.get(edge.targetNodeId) ?? 0) + 1);
    }

    const allowedTypes = options.nodeTypes ? new Set(options.nodeTypes) : null;
    const priority = options.priorityNodeTypes ? new Set(options.priorityNodeTypes) : null;
    const rank = (node: CodeNode): number => (priority?.has(node.type) ? 0 : 1);

    const ranked = this.nodesOf(projectId)
      .filter((node) => degree.has(node.id))
      .filter((node) => !allowedTypes || allowedTypes.has(node.type))
      .sort(
        (a, b) => rank(a) - rank(b) || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0),
      );

    const selected = ranked.slice(0, options.limit);
    const ids = new Set(selected.map((node) => node.id));

    return {
      nodes: selected,
      edges: edges.filter((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId)),
      truncated: ranked.length > options.limit,
    };
  }

  private neighbours(
    projectId: string,
    nodeId: string,
    direction: 'incoming' | 'outgoing',
    relationship: CodeRelationship,
    limit: number,
  ): CodeNode[] {
    const nodes = new Map(this.nodesOf(projectId).map((node) => [node.id, node]));

    return this.edgesOf(projectId)
      .filter((edge) => edge.relationship === relationship)
      .filter((edge) =>
        direction === 'outgoing' ? edge.sourceNodeId === nodeId : edge.targetNodeId === nodeId,
      )
      .map((edge) => nodes.get(direction === 'outgoing' ? edge.targetNodeId : edge.sourceNodeId))
      .filter((node): node is CodeNode => node !== undefined)
      .slice(0, limit);
  }

  /**
   * Mirrors `GraphRepository.nodeRelations`: one sweep over the edges touching
   * the node, bucketed by relationship and direction.
   */
  async nodeRelations(
    projectId: string,
    nodeId: string,
    limitPerSection: number,
  ): Promise<{
    callers: CodeNode[];
    callees: CodeNode[];
    references: CodeNode[];
    dependencies: RelatedNode[];
    dependents: RelatedNode[];
    apis: RelatedNode[];
    databases: RelatedNode[];
  }> {
    const nodes = new Map(this.nodesOf(projectId).map((node) => [node.id, node]));

    const relations = {
      callers: [] as CodeNode[],
      callees: [] as CodeNode[],
      references: [] as CodeNode[],
      dependencies: [] as RelatedNode[],
      dependents: [] as RelatedNode[],
      apis: [] as RelatedNode[],
      databases: [] as RelatedNode[],
    };

    const dataRelationships = new Set<CodeRelationship>([
      'READS_FROM',
      'WRITES_TO',
      'PUBLISHES',
      'SUBSCRIBES',
    ]);
    const dataTypes = new Set<CodeNodeType>(['database', 'table', 'queue', 'event']);
    const dependencyRelationships = new Set<CodeRelationship>(DEPENDENCY_RELATIONSHIPS);

    const push = <T>(bucket: T[], value: T): void => {
      if (bucket.length < limitPerSection) bucket.push(value);
    };

    for (const edge of this.edgesOf(projectId)) {
      const outgoing = edge.sourceNodeId === nodeId;
      const incoming = edge.targetNodeId === nodeId;
      if (!outgoing && !incoming) continue;

      const other = nodes.get(outgoing ? edge.targetNodeId : edge.sourceNodeId);
      if (!other) continue;

      const related: RelatedNode = {
        ...other,
        relationship: edge.relationship,
        direction: outgoing ? 'outgoing' : 'incoming',
        ...(typeof edge.metadata?.confidence === 'string'
          ? { confidence: edge.metadata.confidence as RelatedNode['confidence'] }
          : {}),
        ...(typeof edge.metadata?.source === 'string'
          ? { evidenceSource: edge.metadata.source }
          : {}),
      };

      if (edge.relationship === 'CALLS') {
        push(outgoing ? relations.callees : relations.callers, other);
        continue;
      }
      if (edge.relationship === 'REFERENCES' && incoming) {
        push(relations.references, other);
        continue;
      }
      if (edge.relationship === 'ROUTES_TO' && other.type === 'api') {
        push(relations.apis, related);
        continue;
      }
      if (dataRelationships.has(edge.relationship) && dataTypes.has(other.type)) {
        push(relations.databases, related);
        continue;
      }
      if (dependencyRelationships.has(edge.relationship)) {
        push(outgoing ? relations.dependencies : relations.dependents, related);
      }
    }

    return relations;
  }

  async callers(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    return this.neighbours(projectId, nodeId, 'incoming', 'CALLS', limit);
  }

  async callees(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    return this.neighbours(projectId, nodeId, 'outgoing', 'CALLS', limit);
  }

  async references(projectId: string, nodeId: string, limit: number): Promise<CodeNode[]> {
    return this.neighbours(projectId, nodeId, 'incoming', 'REFERENCES', limit);
  }
}

export class StubHealthProbe {
  constructor(private readonly healthy: boolean) {}

  async ping(): Promise<boolean> {
    if (!this.healthy) throw new Error('database unreachable');
    return true;
  }
}
