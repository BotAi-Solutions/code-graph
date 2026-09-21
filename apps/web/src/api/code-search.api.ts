import { api, queryString } from './client.js';
import type { CodeSearchMatch } from '../types/index.js';

/**
 * Literal text search over a project's source.
 *
 * Deliberately separate from `searchNodes`: that one matches the *names* the
 * indexer recorded, this one matches the characters in the files. Keeping them
 * apart in the client keeps them apart in the UI, which is the point of having
 * both.
 */

export interface CodeSearchMeta {
  /** Occurrences across every file searched, not the size of `matches`. */
  total: number;
  limit: number;
  /** True when more matches exist than were returned. The search still finished. */
  truncated: boolean;
  filesSearched: number;
  /** Files passed over for being too large. Above zero, `total` is a floor. */
  filesSkipped: number;
  /** True when the walk stopped early, which also makes `total` a floor. */
  scanTruncated: boolean;
}

export interface CodeSearchPage {
  matches: CodeSearchMatch[];
  meta: CodeSearchMeta;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

export async function searchCode(
  projectId: string,
  term: string,
  options: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<CodeSearchPage> {
  const limit = options.limit ?? 20;

  const { data, meta } = await api.get<CodeSearchMatch[]>(
    // `term` is passed through untouched: the search is literal and
    // case-sensitive, so anything this layer normalised would be a search for
    // something other than what was typed.
    `/api/projects/${projectId}/code/search${queryString({ q: term, limit })}`,
    signal,
  );

  return {
    matches: data,
    meta: {
      total: numberOr(meta.total, data.length),
      limit: numberOr(meta.limit, limit),
      truncated: meta.truncated === true,
      filesSearched: numberOr(meta.filesSearched, 0),
      filesSkipped: numberOr(meta.filesSkipped, 0),
      scanTruncated: meta.scanTruncated === true,
    },
  };
}
