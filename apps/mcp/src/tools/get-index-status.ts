import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ANALYSIS_PHASE_BY_STATUS,
  ANALYSIS_PHASE_LABELS,
  analysisProgressFraction,
  type AnalysisJob,
} from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';

/**
 * `get_index_status` — is this project's graph worth asking questions about?
 *
 * The second half of the opening move: `resolve_project` says *which* project,
 * this says whether it is in a state to answer. Without it an agent has two
 * ways to be confidently wrong — querying a project that was never indexed and
 * reading "no results" as "no such code", or querying one mid-re-index and
 * reading a half-written graph as the whole truth.
 *
 * It calls `GET /api/projects/:projectId/analysis`, the existing endpoint that
 * lists a project's runs newest first, and adds no state of its own: every
 * judgement below is a reading of what that response already says.
 */

const TOOL_NAME = 'get_index_status';

/**
 * What the caller should do next, in one word.
 *
 * Deliberately four, matching the four situations that call for different
 * behaviour — ask away, wait, give up on the graph, or index first. The raw
 * `AnalysisStatus` is reported alongside, so nothing is hidden by the
 * simplification.
 */
const READINESS_STATES = ['ready', 'indexing', 'failed', 'never_indexed'] as const;
type Readiness = (typeof READINESS_STATES)[number];

const runSchema = {
  analysisId: z.string(),
  completedAt: z.string().nullable(),
  nodeCount: z.number().int().nullable(),
  edgeCount: z.number().int().nullable(),
};

const outputSchema = {
  projectId: z.string(),
  state: z.enum(READINESS_STATES).describe('ready: ask away. indexing: wait and retry. failed: do not trust the graph. never_indexed: nothing to query.'),
  usable: z
    .boolean()
    .describe(
      'True when a completed run has stored a graph that is still there — including while a later run is in progress or after a later run failed, since neither removes the previous graph.',
    ),
  status: z
    .string()
    .nullable()
    .describe('Raw status of the most recent run, or null when there has never been one.'),
  analysisId: z.string().nullable(),
  language: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  nodeCount: z.number().int().nullable(),
  edgeCount: z.number().int().nullable(),
  warningCount: z
    .number()
    .int()
    .describe('Files the run could not read or parse. A run completes in spite of these; the graph is missing whatever was in them.'),
  error: z.string().nullable(),
  progress: z
    .object({
      phase: z.string(),
      percent: z.number().int(),
      message: z.string(),
    })
    .nullable()
    .describe('Only while a run is in progress.'),
  lastSuccessfulRun: z
    .object(runSchema)
    .nullable()
    .describe(
      'The most recent completed run, when it is not the latest one. This is the graph that is still stored after a failed or in-flight re-index.',
    ),
};

/**
 * The status, typed by the schema the SDK validates it against.
 *
 * Derived rather than written out a second time: the SDK checks
 * `structuredContent` against `outputSchema` at runtime, so a hand-kept
 * interface that drifted from it would compile and then fail on every call.
 */
type IndexStatus = z.infer<typeof indexStatusObject>;

const indexStatusObject = z.object(outputSchema);

export function registerGetIndexStatus(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Get project index status',
      description:
        'Check whether a project’s knowledge graph is ready to be queried. ' +
        'Call this after resolve_project and before asking anything about the graph: it distinguishes a project that is indexed from one that is still indexing, one whose indexing failed, and one that was never indexed at all. ' +
        'Reading an empty result from a never-indexed project as "this code does not exist" is the mistake this prevents.',
      inputSchema: {
        projectId: z
          .uuid()
          .describe('A project id, as returned by resolve_project.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // Not idempotent in the useful sense: the whole point is that the
        // answer changes while a run is in flight, and a client that cached it
        // would defeat the tool.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectId }): Promise<CallToolResult> => {
      let runs: AnalysisJob[];
      try {
        runs = await api.get<AnalysisJob[]>(
          `/api/projects/${encodeURIComponent(projectId)}/analysis`,
        );
      } catch (error) {
        return failure(error, projectId);
      }

      const status = summarise(projectId, runs);

      return {
        content: [{ type: 'text', text: render(status) }],
        structuredContent: status,
      };
    },
  );
}


/**
 * The run list, read as a state.
 *
 * The API returns runs newest first, so the first is the one that decides the
 * headline. The rest are not noise: a failed or in-flight run says nothing
 * about whether a graph is *stored*, because the pipeline replaces a project's
 * graph in one step at the end of a run. Until that step lands, the previous
 * run's graph is still what a query would read — so an earlier completed run is
 * what separates "no graph" from "an older graph".
 */
function summarise(projectId: string, runs: AnalysisJob[]): IndexStatus {
  const latest = runs[0];

  if (!latest) {
    return {
      projectId,
      state: 'never_indexed',
      usable: false,
      status: null,
      analysisId: null,
      language: null,
      startedAt: null,
      completedAt: null,
      nodeCount: null,
      edgeCount: null,
      warningCount: 0,
      error: null,
      progress: null,
      lastSuccessfulRun: null,
    };
  }

  const state = readinessOf(latest);
  const previous = runs.slice(1).find((run) => run.status === 'COMPLETED');

  return {
    projectId,
    state,
    usable: state === 'ready' ? true : previous !== undefined,
    status: latest.status,
    analysisId: latest.id,
    language: latest.language,
    startedAt: latest.startedAt,
    completedAt: latest.completedAt,
    // A run records what it persisted. Null on a run that has not got there
    // yet, and on one recorded before the pipeline measured it at all.
    nodeCount: latest.stats?.nodeCount ?? null,
    edgeCount: latest.stats?.edgeCount ?? null,
    warningCount: latest.errors.length,
    error: latest.error,
    progress: state === 'indexing' ? describeProgress(latest) : null,
    lastSuccessfulRun:
      state === 'ready' || !previous
        ? null
        : {
            analysisId: previous.id,
            completedAt: previous.completedAt,
            nodeCount: previous.stats?.nodeCount ?? null,
            edgeCount: previous.stats?.edgeCount ?? null,
          },
  };
}

function readinessOf(run: AnalysisJob): Readiness {
  if (run.status === 'COMPLETED') return 'ready';
  if (run.status === 'FAILED') return 'failed';
  return 'indexing';
}

/**
 * How far along, using the pipeline's own weighting.
 *
 * `analysisProgressFraction` lives in `@ckg/shared` because the web UI's
 * progress bar needs the same answer; reimplementing it here would be a second
 * opinion about the same run. A job with no finer progress record still has a
 * phase implied by its status, which is better than saying nothing.
 */
function describeProgress(run: AnalysisJob): { phase: string; percent: number; message: string } {
  const phase = run.progress?.phase ?? ANALYSIS_PHASE_BY_STATUS[run.status];
  const percent = run.progress ? Math.round(analysisProgressFraction(run.progress) * 100) : 0;

  return {
    phase,
    percent,
    message: run.progress?.message ?? ANALYSIS_PHASE_LABELS[phase],
  };
}

/** The answer as prose, leading with what to do rather than with a status code. */
function render(status: IndexStatus): string {
  const lines: string[] = [];

  switch (status.state) {
    case 'ready': {
      lines.push(`Project ${status.projectId} is indexed and ready to query.`);
      lines.push('');
      lines.push(`   graph:     ${describeGraph(status)}`);
      lines.push(`   language:  ${status.language ?? 'unrecorded'}`);
      lines.push(`   indexed:   ${status.completedAt ?? 'unrecorded'}`);
      if (status.warningCount > 0) {
        lines.push('');
        lines.push(
          `${String(status.warningCount)} file(s) could not be read or parsed during indexing. ` +
            'The run completed anyway, so whatever those files contained is missing from the graph — ' +
            'read them directly if a question turns on them.',
        );
      }
      break;
    }

    case 'indexing': {
      const progress = status.progress;
      lines.push(`Project ${status.projectId} is being indexed right now — do not trust results yet.`);
      lines.push('');
      lines.push(`   status:    ${status.status ?? 'unknown'}`);
      if (progress) {
        lines.push(`   phase:     ${progress.phase} — ${progress.message}`);
        lines.push(`   progress:  about ${String(progress.percent)}%`);
      }
      lines.push('');
      lines.push(
        status.usable
          ? 'A graph from an earlier run is still stored and can be queried, but it predates this run. Treat anything it says as possibly out of date.'
          : 'There is no earlier graph to fall back on. Wait for the run to finish, or read the files directly.',
      );
      break;
    }

    case 'failed': {
      lines.push(`Project ${status.projectId} failed to index.`);
      lines.push('');
      lines.push(`   error:     ${status.error ?? 'no reason recorded'}`);
      lines.push('');
      lines.push(
        status.lastSuccessfulRun
          ? `A graph from an earlier successful run (${status.lastSuccessfulRun.completedAt ?? 'date unrecorded'}) is still stored, so queries will return something — but it predates whatever change prompted this run. Prefer reading files directly for anything recent.`
          : 'No graph was ever stored for this project, so there is nothing to query. Read the files directly.',
      );
      break;
    }

    case 'never_indexed': {
      lines.push(`Project ${status.projectId} has never been indexed.`);
      lines.push('');
      lines.push(
        'No analysis run exists, so the graph is empty. An empty result from a graph query here means ' +
          '"nothing has been indexed", never "no such code" — read the files directly, or index the project first.',
      );
      break;
    }
  }

  return lines.join('\n');
}

function describeGraph(status: IndexStatus): string {
  if (status.nodeCount === null) return 'stored, but this run recorded no size';
  if (status.nodeCount === 0) return 'empty — the run completed but stored nothing';

  return `${String(status.nodeCount)} nodes, ${String(status.edgeCount ?? 0)} edges`;
}

/**
 * A failed call, reported as a tool result rather than thrown, so the model
 * sees it and can act.
 *
 * `PROJECT_NOT_FOUND` gets its own wording because it has an obvious cause and
 * an obvious fix: an id that did not come from `resolve_project`, or one whose
 * project has since been deleted.
 */
function failure(error: unknown, projectId: string): CallToolResult {
  let text: string;

  if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart it with \`pnpm dev:api\`, or point MCP_API_BASE_URL at where it is running.`;
  } else if (error instanceof ApiError && error.code === 'PROJECT_NOT_FOUND') {
    text = `There is no project ${projectId}. Call resolve_project to get a current project id — this one may have been deleted.`;
  } else if (error instanceof ApiError) {
    text = `The graph API refused the request (${error.code}): ${error.message}`;
  } else {
    text = `Could not read the index status: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
