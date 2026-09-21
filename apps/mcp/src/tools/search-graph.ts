import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GRAPH_DEFAULT_SEARCH_LIMIT, type CodeNode } from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';

/**
 * `search_graph` — find nodes in one project's graph by name.
 *
 * The third step of the opening sequence: `resolve_project` says which project,
 * `get_index_status` says whether it can answer, and this asks it something.
 *
 * It calls `GET /api/projects/:projectId/graph/search` and adds no search of
 * its own. The matching is the API's: case-insensitive substring across `name`,
 * `qualifiedName` and `filePath`, ranked by a fixed ladder so the same term
 * always produces the same page. There is no embedding, no similarity score and
 * no interpretation of the query here or there — a term that does not appear in
 * a name does not match, and saying so plainly is more useful to an agent than
 * a plausible near-miss.
 */

const TOOL_NAME = 'search_graph';

/**
 * Results one call may return.
 *
 * The API's own ceiling is 100. This is tighter on purpose: these results go
 * into a model's context, and fifty nodes is already more than anyone reads
 * before narrowing the question. The API's default of 20 is kept, so an agent
 * that passes no limit gets the same page the UI's search box would.
 */
const MAX_LIMIT = 50;

const resultSchema = {
  /** The node id, which later tools address a node by. */
  id: z.string(),
  type: z.string().describe('Node type: class, method, function, file, api, table, document, …'),
  name: z.string(),
  qualifiedName: z
    .string()
    .nullable()
    .describe('Dotted path within its scope, e.g. UserService.getUser. Null when it would only repeat name.'),
  filePath: z.string().nullable().describe('Repository-relative. Null for a node with no file, such as a table.'),
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
};

const outputSchema = {
  projectId: z.string().describe('The project that was searched, and the only one these results can come from.'),
  query: z.string(),
  /** Full match count, not the page — so a caller knows what it did not see. */
  total: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean().describe('True when total exceeds returned; narrow the query or raise limit.'),
  results: z.array(z.object(resultSchema)),
};

/**
 * The structured payload, typed by the schema the SDK validates it against.
 *
 * Derived rather than written out a second time: a hand-kept interface that
 * drifted from the schema would compile and then fail on every call.
 */
type SearchOutput = z.infer<typeof searchOutputObject>;

const searchOutputObject = z.object(outputSchema);

export function registerSearchGraph(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Search a project’s code graph',
      description:
        'Search one indexed project for nodes whose name, qualified name or file path contains a term. ' +
        'Requires a projectId from resolve_project, and searches only that project. ' +
        'Matching is literal and case-insensitive substring, not semantic: search for identifiers you expect to exist (`UserService`, `user.service.ts`, `src/services`, `POST /users`), not for concepts. ' +
        'No match means no node contains that text — check get_index_status before reading that as "no such code".',
      inputSchema: {
        projectId: z.uuid().describe('The project to search, from resolve_project. Required; there is no default and no cross-project search.'),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('A literal substring of a name, qualified name or file path.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Results to return, 1–${String(MAX_LIMIT)}. Defaults to ${String(GRAPH_DEFAULT_SEARCH_LIMIT)}.`),
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
      let nodes: CodeNode[];
      let total: number;

      try {
        // The project is in the path, which is what makes the scope structural:
        // there is no request this tool can build that is not addressed to one
        // project, and the API scopes its SQL by the same id.
        const result = await api.getWithMeta<CodeNode[]>(
          `/api/projects/${encodeURIComponent(projectId)}/graph/search`,
          {
            q: query,
            limit: String(limit ?? GRAPH_DEFAULT_SEARCH_LIMIT),
          },
        );
        nodes = result.data;
        total = typeof result.meta.total === 'number' ? result.meta.total : result.data.length;
      } catch (error) {
        return failure(error, projectId);
      }

      // A post-condition, not a filter. The request named one project and the
      // API scopes by it, so a node from elsewhere would mean one of those two
      // things is broken — which is worth refusing over, because the whole
      // value of a project-scoped answer is that it can be trusted as one.
      const foreign = nodes.find((node) => node.projectId !== projectId);
      if (foreign) {
        return {
          content: [
            {
              type: 'text',
              text: `Refusing to return these results: the API answered a search of project ${projectId} with a node belonging to ${foreign.projectId}. Nothing here is safe to attribute to a project, so no results are reported.`,
            },
          ],
          isError: true,
        };
      }

      const output: SearchOutput = {
        projectId,
        query,
        total,
        returned: nodes.length,
        truncated: total > nodes.length,
        results: nodes.map((node) => ({
          id: node.id,
          type: node.type,
          name: node.name,
          qualifiedName: node.qualifiedName ?? null,
          filePath: node.filePath ?? null,
          startLine: node.startLine ?? null,
          endLine: node.endLine ?? null,
        })),
      };

      return { content: [{ type: 'text', text: render(output) }], structuredContent: output };
    },
  );
}

/**
 * The answer as prose: one line of accounting, then one entry per node.
 *
 * Two lines each rather than a field dump — what it is and where it lives is
 * what an agent picks from. Everything else is in `structuredContent` for a
 * caller that wants it.
 */
function render(output: SearchOutput): string {
  if (output.results.length === 0) {
    return [
      `No graph nodes matched "${output.query}" in project ${output.projectId}.`,
      '',
      'Matching is literal substring, so try a shorter or differently spelled term —',
      'part of an identifier, a file name, or a directory. If the project may not be',
      'indexed, check get_index_status: an empty result there means nothing was indexed,',
      'not that the code does not exist.',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(
    output.truncated
      ? `${String(output.returned)} of ${String(output.total)} nodes matching "${output.query}" in project ${output.projectId}:`
      : `${String(output.total)} node(s) matching "${output.query}" in project ${output.projectId}:`,
  );
  lines.push('');

  output.results.forEach((node, index) => {
    const label = node.qualifiedName ?? node.name;
    lines.push(`${String(index + 1)}. ${label}  [${node.type}]`);
    lines.push(`   ${location(node)}`);
  });

  if (output.truncated) {
    lines.push('');
    lines.push(
      `${String(output.total - output.returned)} more match. Narrow the query, or raise limit (max ${String(MAX_LIMIT)}).`,
    );
  }

  return lines.join('\n');
}

function location(node: SearchOutput['results'][number]): string {
  if (node.filePath === null) return 'no file — this node was derived, not read from source';
  return node.startLine === null ? node.filePath : `${node.filePath}:${String(node.startLine)}`;
}

/**
 * A failed call, reported as a tool result rather than thrown, so the model
 * sees it and can act. Nothing internal is echoed: the API's stable code and
 * its own message, and no more.
 */
function failure(error: unknown, projectId: string): CallToolResult {
  let text: string;

  if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart it with \`pnpm dev:api\`, or point MCP_API_BASE_URL at where it is running.`;
  } else if (error instanceof ApiError && error.code === 'PROJECT_NOT_FOUND') {
    text = `There is no project with id "${projectId}". Call resolve_project to obtain a current project id — this one may have been deleted.`;
  } else if (error instanceof ApiError) {
    text = `The graph API refused the search (${error.code}): ${error.message}`;
  } else {
    text = `Could not search the graph: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
