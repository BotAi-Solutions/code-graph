import type { ApiErrorBody, ApiResponse } from '../types/index.js';

/**
 * Thin fetch wrapper over the API envelope.
 *
 * Every response is `{ success, data, error, meta }`, so unwrapping happens in
 * exactly one place and components never branch on the envelope themselves.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: ApiErrorBody['details'],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestResult<TData> {
  data: TData;
  meta: Record<string, unknown>;
}

async function request<TData>(
  path: string,
  init: RequestInit = {},
): Promise<RequestResult<TData>> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new ApiError(
      'NETWORK_ERROR',
      error instanceof Error ? error.message : 'The API could not be reached',
      0,
    );
  }

  let payload: ApiResponse<TData>;
  try {
    payload = (await response.json()) as ApiResponse<TData>;
  } catch {
    throw new ApiError('INVALID_RESPONSE', `Unexpected response from ${path}`, response.status);
  }

  if (!payload.success) {
    throw new ApiError(
      payload.error.code,
      payload.error.message,
      response.status,
      payload.error.details,
    );
  }

  return { data: payload.data, meta: payload.meta };
}

export const api = {
  get<TData>(path: string, signal?: AbortSignal): Promise<RequestResult<TData>> {
    return request<TData>(path, signal ? { signal } : {});
  },

  post<TData>(path: string, body?: unknown, signal?: AbortSignal): Promise<RequestResult<TData>> {
    return request<TData>(path, {
      method: 'POST',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  },

  delete<TData>(path: string, signal?: AbortSignal): Promise<RequestResult<TData>> {
    return request<TData>(path, { method: 'DELETE', ...(signal ? { signal } : {}) });
  },
};

/** Builds a query string, dropping empty values. Arrays become CSV. */
export function queryString(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
      continue;
    }
    search.set(key, String(value));
  }

  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
