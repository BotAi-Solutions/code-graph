import { api, queryString } from './client.js';
import type { DirectoryListing, ProjectMetadata, SelectedDirectory } from '../types/index.js';

/**
 * The local filesystem, as the browser is allowed to know it.
 *
 * Three calls, and the browser does no filesystem work itself: it cannot, and
 * it should not. `showDirectoryPicker()` would hand the tab a directory handle
 * and put a recursive walk of someone's disk inside a render loop; instead the
 * local API process — which is where every other filesystem operation in this
 * system already lives — opens the dialog, walks the tree and answers with
 * counts.
 */

export async function pickProjectDirectory(): Promise<SelectedDirectory | null> {
  const { data } = await api.post<SelectedDirectory | null>(
    '/api/filesystem/select-directory',
  );
  return data;
}

export async function browseDirectories(
  path?: string,
  signal?: AbortSignal,
): Promise<DirectoryListing> {
  const { data } = await api.get<DirectoryListing>(
    `/api/filesystem/directories${queryString(path ? { path } : {})}`,
    signal,
  );
  return data;
}

/** Sizes up a candidate project: files, directories and languages. */
export async function inspectProject(
  path: string,
  signal?: AbortSignal,
): Promise<ProjectMetadata> {
  const { data } = await api.get<ProjectMetadata>(
    `/api/filesystem/project${queryString({ path })}`,
    signal,
  );
  return data;
}
