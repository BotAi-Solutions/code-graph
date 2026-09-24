import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PROJECT_PATH_MAX_LENGTH, indexProjectResultSchema, type IndexProjectResult } from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';

/**
 * `index_project` — make sure a local directory has a current graph.
 *
 * The way out of the two states `get_index_status` can only report: a project
 * that was never indexed, and one whose graph is stale. Without it an agent
 * that met either could only tell the person to go and open the web UI.
 *
 * It calls `POST /api/projects/index`, which composes the existing intake —
 * register the directory if it is new, queue a run through the same service the
 * UI uses, and let the worker do the rest. This tool adds no indexing of its
 * own and no decisions of its own: whether to create, re-index, or do nothing
 * is decided on the API side, where a second caller racing this one is seen.
 *
 * It returns as soon as the run is queued. Indexing takes seconds to minutes,
 * and a tool call that blocked for that long would hold the whole conversation;
 * `get_index_status` is how to wait.
 */

const TOOL_NAME = 'index_project';

const outputSchema = {
  action: z
    .enum(['started', 'already_indexing', 'up_to_date'])
    .describe('started: a run was queued. already_indexing: one was already active; no second run was queued. up_to_date: the graph already matches the files.'),
  projectCreated: z.boolean().describe('True when this call registered the directory as a new project.'),
  jobCreated: z.boolean(),
  projectId: z.string().describe('Pass this to every other graph tool.'),
  projectName: z.string(),
  repositoryRoot: z.string(),
  jobId: z.string().nullable().describe('The queued or active run. Null when nothing needed doing.'),
  jobStatus: z.string().nullable(),
  freshness: z
    .enum(['current', 'stale', 'unknown', 'not_indexed'])
    .nullable()
    .describe('What the freshness check found before deciding. Null for a new project or an active run.'),
  changedFiles: z.number().int().nullable(),
  reason: z.string(),
};

export function registerIndexProject(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Index a local project',
      description:
        'Index a local repository so the graph tools can answer questions about it, or re-index it when get_index_status reports it stale. ' +
        'Registers the directory as a project if it is new, then queues an indexing run — unless one is already running (that run is returned; a duplicate is never started) or the graph already matches the files (nothing is queued unless force is true). ' +
        'Returns immediately; poll get_index_status until its state is ready. ' +
        'Pass the repository root: if resolve_project already found a project covering the path, pass that project’s repositoryRoot rather than a subdirectory, or a separate project is created for the subdirectory.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(PROJECT_PATH_MAX_LENGTH)
          .describe('Absolute path to the repository root on this machine. Git URLs are not accepted.'),
        force: z
          .boolean()
          .optional()
          .describe('Re-index even if the graph is current. An active run is still never duplicated.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        // It never deletes anything: a re-index replaces the graph with a newer
        // one of the same files, and the source is only ever read.
        destructiveHint: false,
        // A repeat call does not queue a second run while the first is active,
        // but `force` after completion does queue another — so not idempotent.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, force }): Promise<CallToolResult> => {
      let raw: unknown;
      try {
        raw = await api.post<unknown>('/api/projects/index', { path, force: force ?? false });
      } catch (error) {
        return failure(error, path);
      }

      const parsed = indexProjectResultSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: 'The graph API returned an unexpected response to the index request; nothing is reported rather than a guess.' }],
          isError: true,
        };
      }

      const result = parsed.data;
      const structuredContent = {
        action: result.action,
        projectCreated: result.projectCreated,
        jobCreated: result.jobCreated,
        projectId: result.projectId,
        projectName: result.projectName,
        repositoryRoot: result.repositoryRoot,
        jobId: result.job?.id ?? null,
        jobStatus: result.job?.status ?? null,
        freshness: result.freshness?.state ?? null,
        changedFiles: result.freshness?.changedFiles ?? null,
        reason: result.reason,
      };

      return { content: [{ type: 'text', text: render(result) }], structuredContent };
    },
  );
}

function render(result: IndexProjectResult): string {
  const lines: string[] = [];
  const who = `${result.projectName} — projectId: ${result.projectId}`;

  switch (result.action) {
    case 'started':
      lines.push(
        result.projectCreated
          ? `Registered ${result.repositoryRoot} as a new project and queued its first indexing run.`
          : `Queued a re-index of ${result.repositoryRoot}.`,
      );
      lines.push('');
      lines.push(`   project:   ${who}`);
      if (result.job) lines.push(`   run:       ${result.job.id} (${result.job.status})`);
      lines.push(`   why:       ${result.reason}`);
      lines.push('');
      lines.push(
        'Indexing runs in the background and takes seconds to minutes. Poll get_index_status with this projectId until its state is ready. ' +
          'Until then graph results are missing or describe the previous run. If the run stays QUEUED, the worker is not running (`pnpm dev:all` starts it).',
      );
      break;

    case 'already_indexing':
      lines.push(`${result.repositoryRoot} is already being indexed; no second run was queued.`);
      lines.push('');
      lines.push(`   project:   ${who}`);
      if (result.job) lines.push(`   run:       ${result.job.id} (${result.job.status})`);
      lines.push('');
      lines.push('Poll get_index_status with this projectId until its state is ready.');
      break;

    case 'up_to_date':
      lines.push(`The graph for ${result.repositoryRoot} already matches the files on disk; nothing was queued.`);
      lines.push('');
      lines.push(`   project:   ${who}`);
      lines.push('');
      lines.push('Query it directly. Pass force: true only if a re-index is wanted anyway.');
      break;
  }

  return lines.join('\n');
}

/**
 * A refusal, in terms of what to do about it.
 *
 * The path errors each have their own wording because each has a different
 * fix, and "the API refused" would leave the model guessing which one it hit.
 */
function failure(error: unknown, requested: string): CallToolResult {
  let text: string;

  if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart CodeRAG with \`pnpm dev:all\` (Postgres, API and worker), or point MCP_API_BASE_URL at where the API is running.`;
  } else if (error instanceof ApiError) {
    switch (error.code) {
      case 'INVALID_PROJECT_PATH':
        text = `Cannot index ${requested}: ${error.message} Pass the absolute path of a directory on this machine.`;
        break;
      case 'DIRECTORY_NOT_FOUND':
        text = `Cannot index ${requested}: no such directory.`;
        break;
      case 'DIRECTORY_NOT_READABLE':
        text = `Cannot index ${requested}: permission denied. The API process cannot read that directory.`;
        break;
      case 'FILESYSTEM_ACCESS_DISABLED':
        text = 'This API has local filesystem access switched off (LOCAL_FILESYSTEM_ENABLED=false), so it cannot index local directories.';
        break;
      case 'VALIDATION_ERROR':
        text = `The index request was rejected as invalid: ${error.message}`;
        break;
      default:
        text = `Indexing could not be started (${error.code}): ${error.message}`;
    }
  } else {
    text = `Indexing could not be started: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
