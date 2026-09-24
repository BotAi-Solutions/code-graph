import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PROJECT_PATH_MAX_LENGTH } from '@ckg/shared';
import { ApiError, ApiUnreachableError } from '../api-client.js';
import { ProjectRootError } from '../project-root.js';
import {
  UnexpectedResponseError,
  type EnsureOutcome,
  type ProjectEnsurer,
} from '../project-ensurer.js';
import { READINESS_STATES } from './get-index-status.js';

/**
 * `ensure_project` — the current repository, registered and indexed if it
 * needs to be, and its project id.
 *
 * The one-call opening move for a session that does not yet know whether the
 * repository it is in has a graph: it composes `resolve_project`,
 * `get_index_status` and `index_project` (see `project-ensurer.ts`) and adds
 * no indexing or status logic of its own. Those three tools stay as they are,
 * for callers that want each step.
 *
 * Returns as soon as any run is queued; `get_index_status` is how to wait.
 */

const TOOL_NAME = 'ensure_project';

const outputSchema = {
  projectId: z.string().describe('Pass this to every other graph tool.'),
  projectName: z.string(),
  rootPath: z.string().describe('The project’s repository root.'),
  requestedPath: z
    .string()
    .describe('The directory asked about. Differs from rootPath when it lies inside an enclosing project.'),
  rootSource: z
    .string()
    .describe('Where the directory came from: argument, or the environment variable that named it.'),
  action: z
    .enum(['registered', 'started', 'already_indexing', 'up_to_date', 'none'])
    .describe(
      'registered: new project, first run queued. started: re-index queued (stale or never indexed). already_indexing: the active run is reported; none queued. up_to_date: nothing to do. none: nothing queued automatically — see reason.',
    ),
  status: z
    .enum(READINESS_STATES)
    .describe('The project’s state now, as get_index_status reports it.'),
  registered: z.boolean().describe('The project is registered with CodeRAG.'),
  projectCreated: z.boolean().describe('This call registered it.'),
  indexingStarted: z.boolean().describe('This call queued an indexing run.'),
  indexed: z.boolean().describe('A graph is stored and can be queried (possibly an older one while a run is active).'),
  indexing: z.boolean(),
  indexingJobId: z.string().nullable().describe('The queued or in-progress run, when there is one.'),
  stale: z.boolean().nullable(),
  indexedCommit: z.string().nullable(),
  currentCommit: z.string().nullable(),
  changedFiles: z.number().int().nullable(),
  changedPaths: z.array(z.string()),
  error: z.string().nullable().describe('Why the last run failed, when status is failed.'),
  reason: z.string(),
};

export function registerEnsureProject(server: McpServer, projects: ProjectEnsurer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Ensure the current project is registered and indexed',
      description:
        'Make sure the repository open in this session is registered with CodeRAG and has a knowledge graph, and get its projectId. ' +
        'With no arguments it uses the current project directory from the client (CLAUDE_PROJECT_DIR under Claude Code). ' +
        'It registers the directory if it is new, checks whether the graph is indexed and current, and queues indexing only when the project was never indexed or is stale — never a second run while one is active, and nothing when the graph is current. ' +
        'Returns immediately; if indexing is running, poll get_index_status until ready. ' +
        'Call it once when it is uncertain whether the repository is ready for graph queries, typically before the first repository-wide exploration in a session — not before every query. ' +
        'The server already runs this check on startup, so a single call is usually enough to learn the projectId and state.',
      inputSchema: {
        rootPath: z
          .string()
          .min(1)
          .max(PROJECT_PATH_MAX_LENGTH)
          .optional()
          .describe(
            'Absolute path to a repository to ensure instead of the current project. Omit to use the directory the session was opened in.',
          ),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // A repeat call never queues a second active run, and does nothing
        // once the graph is current.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ rootPath }): Promise<CallToolResult> => {
      let outcome: EnsureOutcome;
      try {
        outcome = await projects.ensure(rootPath);
      } catch (error) {
        return failure(error);
      }

      return { content: [{ type: 'text', text: render(outcome) }], structuredContent: { ...outcome } };
    },
  );
}

function render(outcome: EnsureOutcome): string {
  const lines: string[] = [];

  switch (outcome.action) {
    case 'registered':
      lines.push(`Registered ${outcome.rootPath} with CodeRAG and queued its first indexing run.`);
      break;
    case 'started':
      lines.push(
        outcome.stale
          ? `The graph for ${outcome.rootPath} was stale; queued a re-index.`
          : `Queued an indexing run for ${outcome.rootPath}.`,
      );
      break;
    case 'already_indexing':
      lines.push(`${outcome.rootPath} is already being indexed; no second run was queued.`);
      break;
    case 'up_to_date':
      lines.push(`${outcome.rootPath} is indexed and current — ready to query.`);
      break;
    case 'none':
      lines.push(`${outcome.rootPath} is registered; nothing was queued.`);
      break;
  }

  lines.push('');
  lines.push(`   project:   ${outcome.projectName} — projectId: ${outcome.projectId}`);
  if (outcome.requestedPath !== outcome.rootPath) {
    lines.push(`   opened at: ${outcome.requestedPath} (inside this project)`);
  }
  lines.push(`   status:    ${outcome.status}`);
  if (outcome.indexingJobId) lines.push(`   run:       ${outcome.indexingJobId}`);
  if (outcome.indexedCommit || outcome.currentCommit) {
    lines.push(`   commit:    ${outcome.indexedCommit ?? 'unknown'} indexed, ${outcome.currentCommit ?? 'unknown'} now`);
  }
  if (outcome.stale && outcome.changedFiles !== null) {
    lines.push(`   changed:   ${String(outcome.changedFiles)} file(s)${outcome.changedPaths.length ? ` — ${outcome.changedPaths.join(', ')}` : ''}`);
  }
  if (outcome.action !== 'up_to_date' && outcome.action !== 'registered') {
    lines.push(`   why:       ${outcome.reason}`);
  }

  lines.push('');
  lines.push(nextStep(outcome));

  return lines.join('\n');
}

function nextStep(outcome: EnsureOutcome): string {
  if (outcome.indexing) {
    return outcome.indexed
      ? 'An earlier graph can be queried meanwhile, but it predates this run. Poll get_index_status with this projectId until its state is ready.'
      : 'There is no graph yet. Poll get_index_status with this projectId until its state is ready, or read files directly meanwhile. If the run stays QUEUED, the worker is not running (`pnpm dev:all`).';
  }
  if (outcome.status === 'failed') {
    return outcome.indexed
      ? 'An earlier graph is still stored and can be queried, but may predate recent changes.'
      : 'There is no graph to query. Read files directly.';
  }
  return 'Pass this projectId to the graph tools.';
}

function failure(error: unknown): CallToolResult {
  let text: string;

  if (error instanceof ProjectRootError) {
    text = `Cannot ensure the project (${error.code}): ${error.message}`;
  } else if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart CodeRAG with \`pnpm dev:all\` (Postgres, API and worker), or point MCP_API_BASE_URL at where the API is running.`;
  } else if (error instanceof ApiError) {
    text =
      error.code === 'FILESYSTEM_ACCESS_DISABLED'
        ? 'This API has local filesystem access switched off (LOCAL_FILESYSTEM_ENABLED=false), so it cannot register or index local directories.'
        : `The graph API refused the request (${error.code}): ${error.message}`;
  } else if (error instanceof UnexpectedResponseError) {
    text = `${error.message} Nothing is reported rather than a guess.`;
  } else {
    text = `Could not ensure the project: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
