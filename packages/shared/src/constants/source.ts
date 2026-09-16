/**
 * Limits on reading source back out of an indexed repository.
 *
 * Source retrieval exists so that a symbol in the graph can be read where it
 * was written; it is not a file server. Every one of these numbers is there to
 * keep it that way: a window rather than a whole tree, a bounded window rather
 * than a whole file, and a refusal rather than a multi-megabyte response.
 */

/** Lines shown either side of a symbol when a node id is asked about. */
export const SOURCE_DEFAULT_CONTEXT_LINES = 12;

/** Lines one response may carry, however wide a range is requested. */
export const SOURCE_MAX_LINES = 2000;

/**
 * Files larger than this are not read at all.
 *
 * A source file this size is a bundle, a lock file or a fixture — never
 * something anyone is reading in a viewer — and reading it would cost more
 * memory than the graph it belongs to.
 */
export const SOURCE_MAX_FILE_BYTES = 4 * 1024 * 1024;
