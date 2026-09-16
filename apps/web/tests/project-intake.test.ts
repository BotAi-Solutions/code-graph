import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectProjectDirectory } from '../src/features/codebase/services/project-directory.js';

/**
 * The folder-picker abstraction, at the seam where the UI meets it.
 *
 * `selectProjectDirectory()` exists so that no component ever has to know how a
 * folder gets chosen. That is only true if it resolves *every* way the attempt
 * can end into one of its three outcomes — and the two that are not "here is a
 * folder" are the ones worth pinning down, because getting either wrong shows
 * the user an error where nothing went wrong.
 *
 * `fetch` is stubbed rather than a server being started: what is under test is
 * the mapping from response to outcome, and a real server would only make that
 * harder to provoke.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Replies with the API's envelope, as the real API would. */
function stubApi(status: number, payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

const ok = (data: unknown) => ({ success: true, data, error: null, meta: {} });
const failed = (code: string, message: string) => ({
  success: false,
  data: null,
  error: { code, message },
  meta: {},
});

describe('selectProjectDirectory', () => {
  it('returns the folder the dialog produced', async () => {
    stubApi(200, ok({ path: '/Users/dev/projects/api', name: 'api' }));

    await expect(selectProjectDirectory()).resolves.toEqual({
      outcome: 'selected',
      directory: { path: '/Users/dev/projects/api', name: 'api' },
    });
  });

  it('reads a dismissed dialog as cancelled, not as a failure', async () => {
    stubApi(200, ok(null));

    await expect(selectProjectDirectory()).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('reads "this host has no dialog" as a reason to offer the browser', async () => {
    stubApi(501, failed('DIRECTORY_PICKER_UNAVAILABLE', 'no native folder dialog is available'));

    await expect(selectProjectDirectory()).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'no native folder dialog is available',
    });
  });

  it('reads a disabled filesystem the same way, because the way in is the same', async () => {
    stubApi(403, failed('FILESYSTEM_ACCESS_DISABLED', 'Local filesystem access is disabled'));

    const result = await selectProjectDirectory();
    expect(result.outcome).toBe('unavailable');
  });

  it('lets a genuine failure through rather than hiding it as a cancellation', async () => {
    stubApi(500, failed('INTERNAL_ERROR', 'An unexpected error occurred'));

    await expect(selectProjectDirectory()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('lets an unreachable API through, so the UI can say the API is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(selectProjectDirectory()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});
