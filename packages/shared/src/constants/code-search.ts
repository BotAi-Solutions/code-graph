/**
 * Limits on searching a project's source text.
 *
 * Code search is the one read in this system that touches every file rather
 * than one, so each of these numbers exists to keep a single request from
 * becoming a repository-sized amount of work or a repository-sized response.
 */

/** Matches one response carries when the caller says nothing. */
export const CODE_SEARCH_DEFAULT_LIMIT = 20;

/** Matches one response may carry at all. */
export const CODE_SEARCH_MAX_LIMIT = 100;

/**
 * Longest query.
 *
 * The same ceiling graph search uses, for the same reason: a search term longer
 * than this is not a term, and matching it against every line of a repository
 * is work nobody asked for.
 */
export const CODE_SEARCH_MAX_QUERY_LENGTH = 200;

/**
 * Characters of the matching line a result carries.
 *
 * A minified bundle is one line of two megabytes, and returning it because a
 * term appeared in it would be worse than returning nothing. The window is
 * centred on the match so the match is always visible, and the result says when
 * it was cut rather than letting a caller believe it saw the whole line.
 */
export const CODE_SEARCH_MAX_LINE_TEXT = 200;
