import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CODE_SEARCH_DEFAULT_LIMIT,
  CODE_SEARCH_MAX_QUERY_LENGTH,
  type CodeSearchMatch,
} from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';

/**
 * `search_code` — find a literal string in a project's source text.
 *
 * The companion to `search_graph`, and deliberately a different question.
 * `search_graph` matches the *names* of things the indexer recorded; this
 * matches the characters in the files. A string in a comment, in a template
 * literal, in a YAML value, in a language nothing here can parse — none of
 * those is a graph node, and all of them are ordinary things to go looking for.
 *
 * It calls `GET /api/projects/:projectId/code/search` and does no searching of
 * its own. Everything about *how* the search works — which files are walked,
 * how they are read, what is skipped — lives behind that endpoint.
 */

const TOOL_NAME = 'search_code';

/**
 * Results one call may return.
 *
 * The API's own ceiling is 100. This is tighter for the same reason
 * `search_graph`'s is: these lines go into a model's context, and fifty source
 * locations is already more than anyone reads before narrowing the question.
 */
const MAX_LIMIT = 50;

const matchSchema = {
  filePath: z.string().describe('Repository-relative POSIX path.'),
  line: z.number().int().describe('1-based, as an editor counts.'),
  column: z.number().int().describe('0-based, matching startCharacter elsewhere in this graph.'),
  match: z.string().describe('The matched text, which for a literal search is the query itself.'),
  lineText: z.string().describe('The line the match sits on, windowed around it when very long.'),
  lineTruncated: z.boolean().describe('True when lineText is a window rather than the whole line.'),
};

const outputSchema = {
  projectId: z.string().describe('The project searched, and the only one these paths belong to.'),
  query: z.string(),
  results: z
    .array(z.object(matchSchema))
    .describe('One entry per occurrence, ordered by file path, then line, then column.'),
  meta: z.object({
    total: z
      .number()
      .int()
      .describe('Occurrences across every file searched — not the size of `results`, and not a count of matching lines.'),
    limit: z.number().int(),
    truncated: z
      .boolean()
      .describe('True when more matches exist than were returned. The search still completed.'),
    filesSearched: z.number().int(),
    filesSkipped: z
      .number()
      .int()
      .describe('Files passed over for exceeding the source-search size limit. Above zero, `total` is a floor.'),
    scanTruncated: z
      .boolean()
      .describe('True when the repository walk stopped early. `total` is then a floor, NOT an exact count.'),
  }),
};

/**
 * The structured payload, typed by the schema the SDK validates it against.
 *
 * Derived rather than written out a second time: a hand-kept interface that
 * drifted from the schema would compile and then fail on every call.
 */
type CodeSearchOutput = z.infer<typeof codeSearchOutputObject>;

const codeSearchOutputObject = z.object(outputSchema);

/** The `meta` block the canonical route sends beside its matches. */
interface CodeSearchMeta {
  total?: unknown;
  limit?: unknown;
  truncated?: unknown;
  query?: unknown;
  filesSearched?: unknown;
  filesSkipped?: unknown;
  scanTruncated?: unknown;
}

export function registerSearchCode(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Search a project’s source text',
      description:
        'Find literal occurrences of a string in one project’s source files. ' +
        'Case-sensitive literal substring matching — not a regular expression, not a glob, not semantic: `obj.method(arg)` matches those exact characters, and `UserRepository` does not match `userRepository`. ' +
        'Use this when search_graph finds nothing: it reaches comments, strings, config values and languages the indexer cannot parse, none of which are graph nodes. ' +
        'Requires a projectId from resolve_project, and searches only that project.',
      inputSchema: {
        projectId: z.uuid().describe('The project to search, from resolve_project. Required; there is no default.'),
        query: z
          .string()
          .min(1)
          .max(CODE_SEARCH_MAX_QUERY_LENGTH)
          // Deliberately not trimmed: leading and trailing whitespace are part
          // of a literal search term, and normalising the query would mean
          // searching for something other than what was asked for.
          .describe('A literal string, 1–200 characters. Passed to the search unchanged, whitespace included.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Matches to return, 1–${String(MAX_LIMIT)}. Defaults to ${String(CODE_SEARCH_DEFAULT_LIMIT)}.`),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, query, limit }): Promise<CallToolResult> => {
      let matches: CodeSearchMatch[];
      let meta: CodeSearchMeta;

      try {
        const result = await api.getWithMeta<CodeSearchMatch[]>(
          `/api/projects/${encodeURIComponent(projectId)}/code/search`,
          {
            // Unchanged: not lowercased, not trimmed, not escaped.
            q: query,
            limit: String(limit ?? CODE_SEARCH_DEFAULT_LIMIT),
          },
        );
        matches = result.data;
        meta = result.meta as CodeSearchMeta;
      } catch (error) {
        return failure(error, projectId);
      }

      // The only post-condition available here. Unlike a graph node, a code
      // match carries no project id — just a repository-relative path — so
      // there is nothing to check it against, and inventing one would be
      // asserting something this response never said. The project-scoped
      // endpoint is the isolation mechanism; what can be checked is that the
      // answer is to the question that was asked.
      if (typeof meta.query === 'string' && meta.query !== query) {
        return {
          content: [
            {
              type: 'text',
              text: `Refusing to return these results: a search for ${JSON.stringify(query)} was answered with results for ${JSON.stringify(meta.query)}. These are matches for a different question, so they are not reported.`,
            },
          ],
          isError: true,
        };
      }

      const output: CodeSearchOutput = {
        projectId,
        query,
        // Order, occurrences and coordinates exactly as the API produced them:
        // nothing here deduplicates, merges by line, re-sorts or shifts a
        // column.
        results: matches.map((match) => ({
          filePath: match.filePath,
          line: match.line,
          column: match.column,
          match: match.match,
          lineText: match.lineText,
          lineTruncated: match.lineTruncated,
        })),
        meta: {
          total: count(meta.total, matches.length),
          limit: count(meta.limit, limit ?? CODE_SEARCH_DEFAULT_LIMIT),
          truncated: flag(meta.truncated),
          filesSearched: count(meta.filesSearched, 0),
          filesSkipped: count(meta.filesSkipped, 0),
          scanTruncated: flag(meta.scanTruncated),
        },
      };

      return { content: [{ type: 'text', text: render(output) }], structuredContent: output };
    },
  );
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function flag(value: unknown): boolean {
  return value === true;
}

/**
 * The answer as prose: how much was found, then where.
 *
 * The heading is the part that has to be exact. "Found 53 matches" and "showing
 * 20 of 53" are both claims about a completed search; when the walk stopped
 * early, neither is true, and saying either would hand a model a count it would
 * reason from as though it were the whole repository.
 */
function render(output: CodeSearchOutput): string {
  const { meta, results, query } = output;

  if (results.length === 0) {
    const lines = [`No code matches ${JSON.stringify(query)} in this project.`];

    if (meta.scanTruncated || meta.filesSkipped > 0) {
      lines.push('');
      lines.push(
        'Note that the search did not cover the whole repository — see the warning below — so this is not proof the string is absent.',
      );
      lines.push(...warnings(meta));
    } else {
      lines.push('');
      lines.push(
        'Matching is literal and case-sensitive, so try a different spelling or case. If you expected a symbol rather than a string, search_graph matches indexed names instead.',
      );
    }

    return lines.join('\n');
  }

  const lines: string[] = [];

  if (meta.scanTruncated) {
    // Never "of N": N is a floor, and the shortfall is unknown.
    lines.push(
      `Showing ${String(results.length)} match${results.length === 1 ? '' : 'es'} for ${JSON.stringify(query)}. The repository scan was truncated, so more matches may exist beyond the ${String(meta.total)} counted.`,
    );
  } else if (meta.truncated) {
    lines.push(
      `Showing ${String(results.length)} of ${String(meta.total)} matches for ${JSON.stringify(query)}.`,
    );
  } else {
    lines.push(
      `Found ${String(meta.total)} match${meta.total === 1 ? '' : 'es'} for ${JSON.stringify(query)}.`,
    );
  }

  lines.push('');

  results.forEach((result, index) => {
    lines.push(
      `${String(index + 1)}. ${result.filePath}:${String(result.line)}:${String(result.column)}`,
    );
    lines.push(`   ${result.lineText}${result.lineTruncated ? '  […line truncated]' : ''}`);
  });

  const notes = warnings(meta);
  if (notes.length > 0) {
    lines.push('');
    lines.push(...notes);
  }

  return lines.join('\n');
}

/**
 * What the count is not a statement about.
 *
 * Both of these make `total` a floor, and both are reported with their numbers
 * rather than as a vague caveat — an agent deciding whether an absence is
 * meaningful needs to know which files were not looked at.
 */
function warnings(meta: CodeSearchOutput['meta']): string[] {
  const notes: string[] = [];

  if (meta.scanTruncated) {
    notes.push(
      `The repository walk stopped before the whole tree was examined (${String(meta.filesSearched)} files searched), so the count above is a floor rather than a total.`,
    );
  }

  if (meta.filesSkipped > 0) {
    notes.push(
      `${String(meta.filesSkipped)} file${meta.filesSkipped === 1 ? ' was' : 's were'} skipped for exceeding the source-search size limit, so a match inside ${meta.filesSkipped === 1 ? 'it' : 'them'} would not appear here.`,
    );
  }

  return notes;
}

/**
 * A failed search, reported as a tool result rather than thrown.
 *
 * `SOURCE_NOT_READABLE` gets its own wording because it is the one an agent is
 * most likely to meet and most likely to misread: it means the source cannot be
 * searched at all, which is a different thing from finding nothing. There is no
 * fallback to the graph — they answer different questions, and quietly
 * substituting one for the other would be worse than saying so.
 */
function failure(error: unknown, projectId: string): CallToolResult {
  let text: string;

  if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart it with \`pnpm dev:api\`, or point MCP_API_BASE_URL at where it is running.`;
  } else if (error instanceof ApiError && error.code === 'PROJECT_NOT_FOUND') {
    text = `There is no project with id "${projectId}". Call resolve_project to obtain a current project id — this one may have been deleted.`;
  } else if (error instanceof ApiError && error.code === 'SOURCE_NOT_READABLE') {
    text = `The source of project ${projectId} cannot be searched: ${error.message}. This is not a zero-result search — no file was read. A repository indexed from a git URL has no source kept on disk; search_graph still works, but it matches indexed names rather than file contents.`;
  } else if (error instanceof ApiError && error.code === 'REPOSITORY_PATH_NOT_FOUND') {
    text = `The source directory of project ${projectId} is no longer readable, so nothing could be searched. It may have been moved or deleted since indexing.`;
  } else if (error instanceof ApiError) {
    text = `The graph API refused the search (${error.code}): ${error.message}`;
  } else {
    text = `Could not search the source: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
