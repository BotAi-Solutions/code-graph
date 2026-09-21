import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PROJECT_PATH_MAX_LENGTH, type ProjectResolution } from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';

/**
 * `resolve_project` — a filesystem path in, the indexed projects containing it
 * out.
 *
 * This is the first thing an agent calls and the reason the others can exist:
 * every other route in the graph API is addressed by project id, and an agent
 * starts life holding a working directory instead. It turns one into the other.
 *
 * The tool is an adapter and holds no resolution logic of its own. It calls
 * `GET /api/projects/resolve`, and the two things it adds are the two things
 * the API cannot do for it: an input schema an MCP client can validate against,
 * and a rendering of the answer that costs a model few tokens to read.
 */

const TOOL_NAME = 'resolve_project';

/**
 * Shaped for a model, not for a UI.
 *
 * Only the fields that change what the caller does next: the id it needs for
 * every subsequent call, the path form every other route speaks, and enough of
 * the run to tell a usable project from an empty one. The dashboard's node-type
 * histogram is left on the API side — it would be the longest thing here and
 * decides nothing.
 */
const matchSchema = {
  projectId: z.string().describe('Pass this to every other graph API call.'),
  name: z.string(),
  repositoryRoot: z.string().describe('Absolute directory this project was indexed from.'),
  relativePath: z
    .string()
    .describe(
      'The requested path relative to repositoryRoot, POSIX form. Empty when the path is the root itself. This is the form the source and search endpoints expect.',
    ),
  exact: z.boolean().describe('True when the requested path is the repository root.'),
  nodeCount: z.number().int(),
  edgeCount: z.number().int(),
  analysisStatus: z
    .string()
    .nullable()
    .describe('Status of the most recent indexing run, or null if it was never indexed.'),
};

const outputSchema = {
  path: z.string().describe('The requested path, normalised to absolute.'),
  matches: z
    .array(z.object(matchSchema))
    .describe('Every indexed project containing the path, most specific first. May be empty.'),
};

export function registerResolveProject(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Resolve project by path',
      description:
        'Find which indexed code knowledge graph projects contain a filesystem path. ' +
        'Call this first, before any other graph tool: everything else is addressed by project id, and this is where one comes from. ' +
        'Accepts a directory or a file path. More than one project can match — in a monorepo a package and the repository root may both be indexed — so matches are returned most specific first. ' +
        'An empty result means nothing indexed covers that path, in which case read the files directly or index the repository first.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(PROJECT_PATH_MAX_LENGTH)
          .describe(
            'Absolute path to a directory or file, usually the working directory. A relative path is resolved against the workspace root. The path is not read and need not exist.',
          ),
      },
      outputSchema,
      annotations: {
        // Nothing is written, nothing is destroyed, and the same path always
        // resolves the same way. Clients use these to decide what may run
        // without asking.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      let resolution: ProjectResolution;
      try {
        resolution = await api.get<ProjectResolution>('/api/projects/resolve', { path });
      } catch (error) {
        return failure(error);
      }

      const structuredContent = {
        path: resolution.path,
        matches: resolution.matches.map((match) => ({
          projectId: match.project.id,
          name: match.project.name,
          repositoryRoot: match.repositoryRoot,
          relativePath: match.relativePath,
          exact: match.exact,
          nodeCount: match.project.nodeCount,
          edgeCount: match.project.edgeCount,
          analysisStatus: match.project.latestAnalysis?.status ?? null,
        })),
      };

      return {
        content: [{ type: 'text', text: render(resolution) }],
        structuredContent,
      };
    },
  );
}

/**
 * The answer as prose, because prose is what a model actually reads.
 *
 * `structuredContent` carries the same facts for a client that wants fields,
 * but a model spends its attention on the text block, so this says what state
 * each project is in rather than leaving it to infer that from a status string
 * and a node count.
 */
function render(resolution: ProjectResolution): string {
  if (resolution.matches.length === 0) {
    return [
      `No indexed project contains ${resolution.path}.`,
      '',
      'Nothing is wrong — this path has simply not been indexed. Read the files directly,',
      'or index the repository first and call this tool again.',
    ].join('\n');
  }

  const lines: string[] = [];
  const count = resolution.matches.length;
  lines.push(
    count === 1
      ? `1 indexed project contains ${resolution.path}:`
      : `${String(count)} indexed projects contain ${resolution.path}, most specific first:`,
  );

  resolution.matches.forEach((match, index) => {
    const position = count === 1 ? '' : `${String(index + 1)}. `;
    lines.push('');
    lines.push(`${position}${match.project.name} — projectId: ${match.project.id}`);
    lines.push(`   repository root: ${match.repositoryRoot}`);
    lines.push(
      match.exact
        ? '   path within it:  the repository root itself'
        : `   path within it:  ${match.relativePath}`,
    );
    lines.push(`   graph:           ${describeGraph(match.project)}`);
  });

  if (count > 1) {
    lines.push('');
    lines.push(guidanceFor(resolution));
  }

  return lines.join('\n');
}

/**
 * How to choose, when there is a choice.
 *
 * Two shapes of ambiguity reach here and they call for opposite advice. Nested
 * roots mean a package inside a repository, where the narrower one is usually
 * the subject. Identical roots mean the same directory was indexed twice under
 * two projects, where "narrower" is meaningless and recency is the only thing
 * separating them — telling a model the first is the most specific would be
 * telling it something untrue.
 */
function guidanceFor(resolution: ProjectResolution): string {
  const roots = new Set(resolution.matches.map((match) => match.repositoryRoot));

  if (roots.size === 1) {
    return 'The same directory has been indexed more than once. They are listed newest first; prefer the one with the graph that looks complete.';
  }

  return 'Pick the one whose repository root is the subject of the question; the first is the narrowest.';
}

/** What state this project's graph is in, in one clause. */
function describeGraph(project: ProjectResolution['matches'][number]['project']): string {
  const status = project.latestAnalysis?.status ?? null;

  if (status === null) return 'never indexed — no analysis has been run';
  if (status === 'FAILED') return 'last indexing run FAILED — the graph may be stale or empty';
  if (status !== 'COMPLETED') {
    return `indexing in progress (${status}) — results may be incomplete`;
  }
  if (project.nodeCount === 0) return 'indexed, but the graph is empty';

  return `${String(project.nodeCount)} nodes, ${String(project.edgeCount)} edges`;
}

/**
 * A failed call, reported as a tool result rather than thrown.
 *
 * `isError` puts the message in front of the model, which can then do something
 * about it — read files directly, or tell the person their API is not running.
 * Throwing would surface a protocol error the model never sees.
 */
function failure(error: unknown): CallToolResult {
  const text =
    error instanceof ApiUnreachableError
      ? `${error.message}\n\nStart it with \`pnpm dev:api\`, or point MCP_API_BASE_URL at where it is running.`
      : error instanceof ApiError
        ? `The graph API refused the request (${error.code}): ${error.message}`
        : `Could not resolve that path: ${error instanceof Error ? error.message : String(error)}`;

  return { content: [{ type: 'text', text }], isError: true };
}
