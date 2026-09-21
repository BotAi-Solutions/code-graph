import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  GRAPH_DEFAULT_PATH_DEPTH,
  GRAPH_MAX_PATH_DEPTH,
  type CodeNode,
  type GraphPath,
} from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';
import { evidenceSchema, locationOf, toEvidence } from '../evidence.js';

/**
 * `trace_path` — how one node reaches another.
 *
 * The question `get_node` cannot answer in one call: "how does a request get
 * from this controller to that table". An agent could walk it by hand, one
 * `get_node` at a time, rebuilding the graph in its own context and guessing
 * which neighbour to follow — this asks the server, which already knows.
 *
 * It calls `POST /api/projects/:projectId/graph/path` and does no traversal of
 * its own. The search is breadth-first and server-side, so the route is the
 * shortest one; nothing is inferred, and every hop is an edge that is in the
 * graph, with the evidence it was written with.
 */

const TOOL_NAME = 'trace_path';

const pathNodeSchema = {
  id: z.string().describe('Pass to get_node to inspect this node in turn.'),
  type: z.string(),
  name: z.string(),
  qualifiedName: z.string().nullable(),
  filePath: z.string().nullable(),
  startLine: z.number().int().nullable(),
};

/**
 * One hop.
 *
 * `steps[i]` is the hop *out of* `nodes[i]`, which is the canonical API's own
 * pairing — so the last node has no step, and the two arrays are read together
 * rather than zipped by guesswork.
 */
const stepSchema = {
  edgeId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  relationship: z.string().describe('CALLS, ROUTES_TO, WRITES_TO, …'),
  reversed: z
    .boolean()
    .describe('True when the route crossed this edge against its direction, which only happens in an undirected search.'),
  evidence: evidenceSchema.nullable(),
};

const outputSchema = {
  projectId: z.string().describe('The project traced, and the only one these nodes can belong to.'),
  from: z.string(),
  to: z.string(),
  found: z.boolean(),
  depth: z.number().int().describe('Hops on the route. Zero when from and to are the same node.'),
  undirected: z
    .boolean()
    .describe('True when no directed route existed and the search ignored direction to find one. The two are related, but one does not reach the other.'),
  truncated: z
    .boolean()
    .describe('True when the search spent its node budget before it could conclude. With found=false this means "could not prove it", NOT "no route exists".'),
  maxDepth: z
    .number()
    .int()
    .describe('The hop limit this search was bounded by — what a no-path answer is a statement about.'),
  nodes: z.array(z.object(pathNodeSchema)).describe('The route in order, from `from` to `to`. Empty when no route was found.'),
  steps: z.array(z.object(stepSchema)).describe('The edges crossed, in order. steps[i] leaves nodes[i].'),
  relationships: z.array(z.string()).describe('Distinct relationships along the route, in order of first use — the shape of the trace.'),
};

/**
 * The structured payload, typed by the schema the SDK validates it against.
 *
 * Derived rather than written out a second time: a hand-kept interface that
 * drifted from the schema would compile and then fail on every call.
 */
type PathOutput = z.infer<typeof pathOutputObject>;

const pathOutputObject = z.object(outputSchema);

export function registerTracePath(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Trace a path between two nodes',
      description:
        'Find the shortest route between two nodes in one project — "how does this controller reach that table". ' +
        'Requires a projectId from resolve_project and two node ids from search_graph, and traces only within that project. ' +
        'Every hop is a real edge with the evidence it was derived from; nothing is inferred. ' +
        'Prefer this over walking the graph with repeated get_node calls.',
      inputSchema: {
        projectId: z.uuid().describe('The project to trace within, from resolve_project. Both nodes must belong to it.'),
        fromNodeId: z.string().trim().min(1).max(512).describe('Where the route starts. A node id from search_graph.'),
        toNodeId: z.string().trim().min(1).max(512).describe('Where the route ends. A node id from search_graph.'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(GRAPH_MAX_PATH_DEPTH)
          .optional()
          .describe(
            `Longest route to consider, 1–${String(GRAPH_MAX_PATH_DEPTH)}. Defaults to ${String(GRAPH_DEFAULT_PATH_DEPTH)}. Raise it only after a search failed at the default: a longer route through a hub node is rarely the explanation anyone wanted.`,
          ),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, fromNodeId, toNodeId, maxDepth }): Promise<CallToolResult> => {
      let path: GraphPath;
      try {
        // The project is in the path and both node ids are in the body. The API
        // resolves each id within this project before searching, so a node from
        // elsewhere is a not-found rather than a silently different route.
        path = await api.post<GraphPath>(
          `/api/projects/${encodeURIComponent(projectId)}/graph/path`,
          {
            from: fromNodeId,
            to: toNodeId,
            ...(maxDepth === undefined ? {} : { maxDepth }),
          },
        );
      } catch (error) {
        return failure(error, projectId, fromNodeId, toNodeId);
      }

      const violation = invariantViolation(path, projectId, fromNodeId, toNodeId);
      if (violation) {
        return { content: [{ type: 'text', text: violation }], isError: true };
      }

      const output: PathOutput = {
        projectId,
        from: path.from,
        to: path.to,
        found: path.found,
        depth: path.depth,
        undirected: path.undirected,
        truncated: path.truncated,
        maxDepth: maxDepth ?? GRAPH_DEFAULT_PATH_DEPTH,
        nodes: path.nodes.map(pathNode),
        steps: path.steps.map((step) => ({
          edgeId: step.edgeId,
          sourceNodeId: step.sourceNodeId,
          targetNodeId: step.targetNodeId,
          relationship: step.relationship,
          reversed: step.reversed,
          evidence: toEvidence(step.evidence),
        })),
        relationships: [...path.relationships],
      };

      return { content: [{ type: 'text', text: render(output) }], structuredContent: output };
    },
  );
}

function pathNode(node: CodeNode): PathOutput['nodes'][number] {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    qualifiedName: node.qualifiedName ?? null,
    filePath: node.filePath ?? null,
    startLine: node.startLine ?? null,
  };
}

/**
 * The two things that must be true of any answer, checked before it is
 * reported.
 *
 * Both are post-conditions rather than filters, as in `search_graph` and
 * `get_node`: a response that fails either means an invariant below has broken,
 * and a route that is subtly not the one that was asked for is worse than no
 * route at all — an agent would act on it without any reason to doubt it.
 *
 * Returns the message to refuse with, or null when the answer is sound.
 */
function invariantViolation(
  path: GraphPath,
  projectId: string,
  fromNodeId: string,
  toNodeId: string,
): string | null {
  // Edges are checked as well as nodes even though they are not reported: they
  // are part of the answer's provenance, and a foreign one means the same
  // broken scoping.
  const foreign =
    path.nodes.find((node) => node.projectId !== projectId)?.projectId ??
    path.edges.find((edge) => edge.projectId !== projectId)?.projectId;

  if (foreign !== undefined) {
    return `Refusing to return this path: a trace within project ${projectId} came back carrying a graph object from project ${foreign}. Nothing in this response can be safely attributed to a project, so none of it is reported.`;
  }

  if (path.from !== fromNodeId || path.to !== toNodeId) {
    return `Refusing to return this path: a trace from "${fromNodeId}" to "${toNodeId}" was answered with a route from "${path.from}" to "${path.to}". This is a path for a different question, so it is not reported.`;
  }

  if (!path.found) return null;

  const first = path.nodes[0];
  const last = path.nodes[path.nodes.length - 1];

  if (first === undefined || last === undefined) {
    return `Refusing to return this path: it was reported as found but carries no nodes.`;
  }

  if (first.id !== fromNodeId || last.id !== toNodeId) {
    return `Refusing to return this path: the route runs from "${first.id}" to "${last.id}", which is not the "${fromNodeId}" to "${toNodeId}" that was asked for.`;
  }

  return null;
}

/**
 * The answer as prose: the route on one line, then each node with the hop that
 * leaves it.
 *
 * The shape first, because that is what answers the question — the detail under
 * each node is for deciding what to open next.
 */
function render(output: PathOutput): string {
  if (!output.found) return renderNoPath(output);

  const lines: string[] = [];
  const names = output.nodes.map((node) => node.qualifiedName ?? node.name);

  if (output.depth === 0) {
    lines.push(`"${output.from}" and "${output.to}" are the same node: ${names[0] ?? output.from}.`);
    lines.push('');
    lines.push('There is no route to trace between a node and itself.');
    return lines.join('\n');
  }

  lines.push(`Path found: ${names.join(' → ')}`);
  lines.push('');
  lines.push(`Length: ${String(output.depth)} edge${output.depth === 1 ? '' : 's'}`);

  if (output.undirected) {
    lines.push('');
    lines.push(
      'No directed route exists, so this one ignores edge direction: the two are related, but the first does not reach the second by following the flow. Hops marked "against direction" were crossed backwards.',
    );
  }

  lines.push('');

  output.nodes.forEach((node, index) => {
    lines.push(`${String(index + 1)}. ${node.qualifiedName ?? node.name}  [${node.type}]`);
    lines.push(`   ${where(node)}`);

    const step = output.steps[index];
    if (!step) return;

    lines.push('');
    lines.push(
      `   ↓ ${step.relationship}${step.reversed ? ' (against direction)' : ''} — ${describeEvidence(step)}`,
    );
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * No route — but "no route" and "could not tell" are different answers.
 *
 * `truncated` means the breadth-first search spent its node budget before it
 * could conclude. Reporting that as "there is no path" would be a confident
 * claim the server never made.
 */
function renderNoPath(output: PathOutput): string {
  if (output.truncated) {
    return [
      `Could not determine whether a path exists from "${output.from}" to "${output.to}".`,
      '',
      'The search ran out of its node budget before it could conclude — this does not mean no route exists.',
      'Try a smaller maxDepth, or trace between two nodes that are closer together.',
    ].join('\n');
  }

  return [
    `No path exists from "${output.from}" to "${output.to}" in this project, within ${String(output.maxDepth)} hop${output.maxDepth === 1 ? '' : 's'}.`,
    '',
    'Both nodes exist — they are simply not connected by any chain of recorded relationships,',
    'in either direction, that short. A longer maxDepth may find one, though a route that long',
    'is rarely the explanation anyone wanted.',
  ].join('\n');
}

function where(node: PathOutput['nodes'][number]): string {
  if (node.filePath === null) return 'no file — this node was derived, not read from source';
  return node.startLine === null ? node.filePath : `${node.filePath}:${String(node.startLine)}`;
}

function describeEvidence(step: PathOutput['steps'][number]): string {
  if (!step.evidence) return 'no evidence recorded';
  return `${step.evidence.source}/${step.evidence.confidence}, ${locationOf(step.evidence)}`;
}

/**
 * A failed trace, reported as a tool result rather than thrown.
 *
 * A node that is not in this project reads as missing, which is what the API
 * says and the right answer: it neither confirms the node exists elsewhere nor
 * goes looking. Note that "no path" never arrives here — that is a successful
 * answer with `found: false`.
 */
function failure(
  error: unknown,
  projectId: string,
  fromNodeId: string,
  toNodeId: string,
): CallToolResult {
  let text: string;

  if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart it with \`pnpm dev:api\`, or point MCP_API_BASE_URL at where it is running.`;
  } else if (error instanceof ApiError && error.code === 'PROJECT_NOT_FOUND') {
    text = `There is no project with id "${projectId}". Call resolve_project to obtain a current project id — this one may have been deleted.`;
  } else if (error instanceof ApiError && error.code === 'NODE_NOT_FOUND') {
    // The API resolves both endpoints before searching and names the one it
    // could not find; passing its message through says which.
    text = `${error.message}. Both "${fromNodeId}" and "${toNodeId}" must be nodes in project ${projectId} — node ids are project-specific, so one from another project will not resolve here. Use search_graph in this project to find the right ids.`;
  } else if (error instanceof ApiError) {
    text = `The graph API refused the trace (${error.code}): ${error.message}`;
  } else {
    text = `Could not trace that path: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
