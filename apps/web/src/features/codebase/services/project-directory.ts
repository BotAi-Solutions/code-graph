import { ApiError } from '../../../api/client.js';
import { pickProjectDirectory } from '../../../api/filesystem.api.js';
import type { SelectedDirectory } from '../../../types/index.js';

/**
 * "Let the user choose a project folder", as one call.
 *
 * Everything the UI needs to know about how a folder gets chosen is in this
 * file. Components ask for a directory and handle three answers; they never
 * learn that a dialog was involved, which platform it belonged to, or that
 * there is a fallback at all.
 *
 * The three answers are genuinely different things and none of them is an
 * error:
 *
 * - `selected` — a folder, ready to inspect.
 * - `cancelled` — the dialog was dismissed. Nothing should change on screen.
 * - `unavailable` — this host has no folder dialog to show (a container, a
 *   remote server, a desktop with neither zenity nor kdialog). The caller
 *   opens the in-app directory browser instead.
 */

export type DirectorySelection =
  | { outcome: 'selected'; directory: SelectedDirectory }
  | { outcome: 'cancelled' }
  | { outcome: 'unavailable'; reason: string };

/** Error codes the API uses to say "there is no dialog here". */
const NO_DIALOG_CODES = new Set(['DIRECTORY_PICKER_UNAVAILABLE', 'FILESYSTEM_ACCESS_DISABLED']);

export async function selectProjectDirectory(): Promise<DirectorySelection> {
  try {
    const directory = await pickProjectDirectory();
    return directory ? { outcome: 'selected', directory } : { outcome: 'cancelled' };
  } catch (error) {
    if (error instanceof ApiError && NO_DIALOG_CODES.has(error.code)) {
      return { outcome: 'unavailable', reason: error.message };
    }
    throw error;
  }
}
