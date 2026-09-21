import type { ApiMeta, ApiResponse } from '@ckg/shared';

/**
 * The MCP server's one way of reaching the graph: the same HTTP API the web
 * client uses.
 *
 * This file exists so that the tools do not each re-implement the envelope, the
 * timeout and the failure vocabulary. It is transport only — it knows about
 * `{ success, data, error, meta }` and about nothing in the graph — which is
 * what keeps every piece of domain knowledge on the API side of the boundary.
 *
 * There is deliberately no database client anywhere in this app. If a question
 * cannot be answered through this class, the answer is a new API route, not a
 * second path into the data.
 */

/** A call that reached the API and was refused, carrying the API's own stable code. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A call that never got an answer: the API is down, unreachable, or too slow. */
export class ApiUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly reason: string,
  ) {
    super(`The graph API at ${baseUrl} could not be reached: ${reason}`);
    this.name = 'ApiUnreachableError';
  }
}

/** An unwrapped response, with the envelope's `meta` kept. */
export interface ApiResult<TData> {
  data: TData;
  /**
   * Whatever the route puts beside its payload — paging totals, the filters it
   * actually applied. A paged route's `total` is the full match count rather
   * than the page's, so a caller can say how much it did not fetch.
   */
  meta: ApiMeta;
}

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /**
   * One GET, unwrapped, keeping only the payload.
   *
   * `query` is passed as values rather than a pre-built string so that a path
   * with a `?` or a `#` in it cannot escape its parameter — which matters here,
   * because the first tool's only argument is a filesystem path.
   */
  async get<TData>(path: string, query: Record<string, string> = {}): Promise<TData> {
    return (await this.getWithMeta<TData>(path, query)).data;
  }

  /**
   * The same call, keeping the envelope's `meta`.
   *
   * Separate from `get` rather than replacing it because most routes say
   * everything in `data`; a paged one does not, and a tool that reported a
   * page as though it were the whole answer would be quietly wrong.
   */
  async getWithMeta<TData>(
    path: string,
    query: Record<string, string> = {},
  ): Promise<ApiResult<TData>> {
    const url = new URL(`${this.options.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    return this.send<TData>(url, { headers: { Accept: 'application/json' } });
  }

  /**
   * One POST with a JSON body, unwrapped.
   *
   * Reading over POST is unusual but right where the request is a structured
   * query rather than an identifier — the path search takes two node ids and a
   * set of filters, which is a body, not a query string.
   */
  async post<TData>(path: string, body: unknown): Promise<TData> {
    return (
      await this.send<TData>(new URL(`${this.options.baseUrl}${path}`), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).data;
  }

  /** The one place a request is made and the envelope is unwrapped. */
  private async send<TData>(url: URL, init: RequestInit): Promise<ApiResult<TData>> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new ApiUnreachableError(this.options.baseUrl, reasonFor(error));
    }

    let payload: ApiResponse<TData>;
    try {
      payload = (await response.json()) as ApiResponse<TData>;
    } catch {
      // Something answered on that port, but it was not this API. Worth saying
      // plainly: the usual cause is a base URL pointing at the wrong service.
      throw new ApiError(
        'INVALID_RESPONSE',
        `${url.pathname} did not return the API's response envelope`,
        response.status,
      );
    }

    if (!payload.success) {
      throw new ApiError(payload.error.code, payload.error.message, response.status);
    }

    return { data: payload.data, meta: payload.meta };
  }
}

function reasonFor(error: unknown): string {
  if (error instanceof Error) {
    // `AbortSignal.timeout` rejects with a TimeoutError; saying "timed out"
    // points at a slow or wedged API rather than at a wrong address.
    if (error.name === 'TimeoutError') return 'the request timed out';
    return error.message;
  }
  return 'unknown error';
}
