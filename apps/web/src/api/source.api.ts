import { api, queryString } from './client.js';
import type { SourceWindow } from '../types/index.js';

/**
 * Reading source for an indexed project.
 *
 * Addressed by a repository-relative path, by a graph node, or by both — the
 * server resolves all three against the project's own repository root, so the
 * browser never holds or sends an absolute path.
 */
export interface SourceRequest {
  /** Repository-relative path. */
  file?: string;
  /** A graph node, whose indexed range becomes the window and the highlight. */
  nodeId?: string;
  startLine?: number;
  endLine?: number;
  /** Lines either side of a symbol range. Ignored for an explicit range. */
  context?: number;
}

export async function fetchSource(
  projectId: string,
  request: SourceRequest,
  signal?: AbortSignal,
): Promise<SourceWindow> {
  const { data } = await api.get<SourceWindow>(
    `/api/projects/${projectId}/source${queryString({
      ...(request.file ? { file: request.file } : {}),
      ...(request.nodeId ? { nodeId: request.nodeId } : {}),
      ...(request.startLine ? { startLine: request.startLine } : {}),
      ...(request.endLine ? { endLine: request.endLine } : {}),
      ...(request.context !== undefined ? { context: request.context } : {}),
    })}`,
    signal,
  );
  return data;
}
