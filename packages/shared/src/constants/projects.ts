/**
 * Limits on resolving a filesystem path back to the project indexed from it.
 *
 * Resolution answers "which indexed project covers this directory". In a
 * monorepo more than one can, because a repository root and a package inside it
 * may both have been indexed, so the answer is a ranked list rather than a
 * single project — bounded here for the same reason every other read in this
 * API is bounded.
 */

/**
 * Candidate paths one request may examine.
 *
 * Resolution walks every repository the installation knows about, which is a
 * number in the tens; the cap exists so that a pathological installation cannot
 * turn one lookup into an unbounded scan.
 */
export const PROJECT_RESOLUTION_MAX_CANDIDATES = 1000;

/**
 * Matches one response may carry.
 *
 * A path enclosed by twenty indexed projects means the projects are nested
 * twenty deep, which does not happen. This is a guard against a pathological
 * installation rather than a page size, so there is no paging and no truncation
 * flag to read: matches are ranked most specific first *before* the cap, so
 * anything it could drop is a match the caller would have read last.
 */
export const PROJECT_RESOLUTION_MAX_MATCHES = 20;

/** Longest path resolution will consider. Longer than any real project root. */
export const PROJECT_PATH_MAX_LENGTH = 4096;
