import type {
  ApiResponse,
  CodeNode,
  CodeSearchMatch,
  GraphPath,
  NodeDetail,
  ProjectResolution,
  SourceWindow,
} from '@ckg/shared';

/**
 * The evaluator's only way of reaching the system: the public HTTP API.
 *
 * Deliberately not `@ckg/graph`, not `@ckg/database`, not the source service.
 * The question this package exists to answer is whether the *public retrieval
 * interface* is sufficient, and an evaluator that reached past it would answer
 * a different and much less interesting question — one about the database,
 * which we already know the answer to.
 *
 * So it behaves like any other client: HTTP, the response envelope, and the
 * same project-scoped routes an agent or the web app uses.
 */

export class RetrievalApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RetrievalApiError';
  }
}

export interface ResolvedProject {
  projectId: string;
  name: string;
  nodeCount: number;
}

/**
 * Everything the runner needs, as an interface.
 *
 * An interface rather than the class so the runner's own tests can drive it
 * with recorded answers — the matching and aggregation rules deserve
 * exhaustive checks, and those must not need a server.
 */
export interface RetrievalClient {
  resolveProject(repositoryPath: string): Promise<ResolvedProject | null>;
  searchCode(projectId: string, query: string, limit?: number): Promise<CodeSearchMatch[]>;
  searchGraph(projectId: string, query: string, limit?: number): Promise<CodeNode[]>;
  nodeDetail(projectId: string, nodeId: string): Promise<NodeDetail>;
  findPath(
    projectId: string,
    from: string,
    to: string,
    maxDepth?: number,
  ): Promise<GraphPath>;
  source(
    projectId: string,
    file: string,
    range?: { startLine?: number; endLine?: number },
  ): Promise<SourceWindow>;
}

export class HttpRetrievalClient implements RetrievalClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async resolveProject(repositoryPath: string): Promise<ResolvedProject | null> {
    const resolution = await this.get<ProjectResolution>('/api/projects/resolve', {
      path: repositoryPath,
    });

    // The API ranks matches most specific first, and a repository indexed twice
    // legitimately produces two. Taking the first is deterministic, and the
    // report names what it took so a reader can see which graph was scored.
    const match = resolution.matches[0];
    if (!match) return null;

    return {
      projectId: match.project.id,
      name: match.project.name,
      nodeCount: match.project.nodeCount,
    };
  }

  async searchCode(projectId: string, query: string, limit?: number): Promise<CodeSearchMatch[]> {
    return this.get<CodeSearchMatch[]>(`/api/projects/${projectId}/code/search`, {
      // Verbatim. The backend search is literal and case-sensitive, and an
      // evaluator that normalised the query would be scoring a different search.
      q: query,
      ...(limit === undefined ? {} : { limit: String(limit) }),
    });
  }

  async searchGraph(projectId: string, query: string, limit?: number): Promise<CodeNode[]> {
    return this.get<CodeNode[]>(`/api/projects/${projectId}/graph/search`, {
      q: query,
      ...(limit === undefined ? {} : { limit: String(limit) }),
    });
  }

  async nodeDetail(projectId: string, nodeId: string): Promise<NodeDetail> {
    return this.get<NodeDetail>(
      `/api/projects/${projectId}/graph/nodes/${encodeURIComponent(nodeId)}`,
      {},
    );
  }

  async findPath(
    projectId: string,
    from: string,
    to: string,
    maxDepth?: number,
  ): Promise<GraphPath> {
    return this.post<GraphPath>(`/api/projects/${projectId}/graph/path`, {
      from,
      to,
      ...(maxDepth === undefined ? {} : { maxDepth }),
    });
  }

  async source(
    projectId: string,
    file: string,
    range: { startLine?: number; endLine?: number } = {},
  ): Promise<SourceWindow> {
    return this.get<SourceWindow>(`/api/projects/${projectId}/source`, {
      file,
      ...(range.startLine === undefined ? {} : { startLine: String(range.startLine) }),
      ...(range.endLine === undefined ? {} : { endLine: String(range.endLine) }),
    });
  }

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return this.send<T>(url, { headers: { Accept: 'application/json' } });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(new URL(`${this.baseUrl}${path}`), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async send<T>(url: URL, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new RetrievalApiError(
        'UNREACHABLE',
        `${this.baseUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }

    let payload: ApiResponse<T>;
    try {
      payload = (await response.json()) as ApiResponse<T>;
    } catch {
      throw new RetrievalApiError(
        'INVALID_RESPONSE',
        `${url.pathname} did not return the API's response envelope`,
        response.status,
      );
    }

    if (!payload.success) {
      throw new RetrievalApiError(payload.error.code, payload.error.message, response.status);
    }

    return payload.data;
  }
}
