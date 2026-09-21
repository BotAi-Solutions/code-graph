import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeNode, NodeDetail, RelatedNode } from '@ckg/shared';
import { ApiError, ApiUnreachableError, type ApiClient } from '../api-client.js';
import { evidenceSchema, locationOf, toEvidence } from '../evidence.js';

/**
 * `get_node` — everything the graph knows about one node.
 *
 * The end of the opening sequence: `search_graph` finds candidates by name,
 * this inspects the one that looked right. It is where an agent stops matching
 * strings and starts reading structure — what calls this, what it calls, what
 * it depends on, and the evidence for each of those claims.
 *
 * It calls `GET /api/projects/:projectId/graph/nodes/:nodeId`, the endpoint the
 * web inspector uses, and performs no lookup of its own.
 */

const TOOL_NAME = 'get_node';

/**
 * Entries per relationship section.
 *
 * The API applies its `limit` per section and defaults to 100, which is a fine
 * budget for a panel someone scrolls and a poor one for a model's context: a
 * hub node would arrive as a thousand neighbours across twelve sections. Twenty
 * is enough to see the shape of a node's connections and decide what to look at
 * next, which is what this tool is for.
 */
const MAX_PER_SECTION = 20;

/**
 * What is actually asked for.
 *
 * One more than is kept, so "there are more" is a fact rather than a guess. The
 * node-detail endpoint reports no totals, so asking for exactly twenty would
 * make a section of twenty indistinguishable from a section of two hundred —
 * and an agent that believed a node had twenty callers when it had two hundred
 * would draw exactly the wrong conclusion about how safe it is to change.
 */
const API_LIMIT = MAX_PER_SECTION + 1;

const nodeRefSchema = {
  id: z.string().describe('Pass to get_node to inspect this neighbour in turn.'),
  type: z.string(),
  name: z.string(),
  qualifiedName: z.string().nullable(),
  filePath: z.string().nullable(),
  startLine: z.number().int().nullable(),
};

const relatedRefSchema = {
  ...nodeRefSchema,
  relationship: z.string().describe('CALLS, WRITES_TO, DEPENDS_ON, DOCUMENTS, …'),
  direction: z.string().describe('outgoing: this node is the source. incoming: it is the target.'),
  evidence: evidenceSchema.nullable(),
};

/** A bounded slice of one relationship, with an honest "is that all of them". */
function section<TShape extends z.ZodRawShape>(item: TShape) {
  return z.object({
    returned: z.number().int(),
    hasMore: z
      .boolean()
      .describe(`True when more than ${String(MAX_PER_SECTION)} exist. The count here is a floor, not a total.`),
    items: z.array(z.object(item)),
  });
}

const outputSchema = {
  projectId: z.string().describe('The project this node was read from, and the only one it can belong to.'),
  node: z.object({
    ...nodeRefSchema,
    endLine: z.number().int().nullable(),
    language: z.string().nullable(),
    exported: z.boolean().nullable(),
    role: z.string().nullable().describe('controller, service, repository, model … where an analyzer recognised one.'),
    category: z.string().describe('code, architecture or knowledge.'),
    signature: z.string().nullable().describe('As the indexer recorded it.'),
    documentation: z.array(z.string()).describe('Doc comments the indexer carried. Empty when there were none.'),
  }),
  relationships: z.object({
    callers: section(nodeRefSchema),
    callees: section(nodeRefSchema),
    references: section(nodeRefSchema),
    dependencies: section(relatedRefSchema),
    dependents: section(relatedRefSchema),
    implementations: section(relatedRefSchema),
    apis: section(relatedRefSchema),
    databases: section(relatedRefSchema),
    documentation: section(relatedRefSchema).describe('What the repository writes about this node.'),
    contracts: section(relatedRefSchema).describe('What declares this node, and what fulfils it.'),
    children: section(nodeRefSchema),
  }),
  parent: z.object(nodeRefSchema).nullable().describe('What CONTAINS this node: its class, its file, its directory.'),
};

/**
 * The structured payload, typed by the schema the SDK validates it against.
 *
 * Derived rather than written out a second time: a hand-kept interface that
 * drifted from the schema would compile and then fail on every call.
 */
type NodeOutput = z.infer<typeof nodeOutputObject>;

const nodeOutputObject = z.object(outputSchema);

export function registerGetNode(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Inspect one graph node',
      description:
        'Get everything the graph knows about one node: what it is, where it is defined, and what it is connected to — callers, callees, references, dependencies, the APIs and data stores it touches, and the documentation and contracts that mention it. ' +
        'Each connection carries the evidence it was derived from, so "why are these two connected" is answerable from the response. ' +
        'Requires a projectId from resolve_project and a nodeId from search_graph, and reads only that project.',
      inputSchema: {
        projectId: z.uuid().describe('The project the node belongs to, from resolve_project. Required; there is no default.'),
        nodeId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .describe('A node id, as search_graph returns in `results[].id`.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, nodeId }): Promise<CallToolResult> => {
      let detail: NodeDetail;
      try {
        // Both ids are in the path. The API scopes its SQL by the same project
        // id, so a node belonging to another project reads as missing here
        // rather than being found and returned.
        detail = await api.get<NodeDetail>(
          `/api/projects/${encodeURIComponent(projectId)}/graph/nodes/${encodeURIComponent(nodeId)}`,
          { limit: String(API_LIMIT) },
        );
      } catch (error) {
        return failure(error, projectId, nodeId);
      }

      // A post-condition, not a filter, exactly as in search_graph. Every node
      // in this response came from a query scoped to one project; one that
      // says otherwise means an invariant below has broken, and attributing
      // another project's code to this one is worse than answering nothing.
      const foreign = foreignNodeIn(detail, projectId);
      if (foreign) {
        return {
          content: [
            {
              type: 'text',
              text: `Refusing to return this node: a lookup in project ${projectId} came back carrying a node from project ${foreign}. Nothing in this response can be safely attributed to a project, so none of it is reported.`,
            },
          ],
          isError: true,
        };
      }

      const output = shape(projectId, detail);

      return { content: [{ type: 'text', text: render(output) }], structuredContent: output };
    },
  );
}

/** The first project id in the response that is not the one asked about. */
function foreignNodeIn(detail: NodeDetail, projectId: string): string | null {
  const everything: { projectId: string }[] = [
    detail.node,
    ...detail.callers,
    ...detail.callees,
    ...detail.references,
    ...detail.dependencies,
    ...detail.dependents,
    ...detail.implementations,
    ...detail.apis,
    ...detail.databases,
    ...detail.documentation,
    ...detail.contracts,
    ...detail.children,
    ...(detail.parent ? [detail.parent] : []),
  ];

  return everything.find((node) => node.projectId !== projectId)?.projectId ?? null;
}

function shape(projectId: string, detail: NodeDetail): NodeOutput {
  const metadata = detail.node.metadata ?? {};

  return {
    projectId,
    node: {
      ...nodeRef(detail.node),
      endLine: detail.node.endLine ?? null,
      language: detail.symbol.language,
      exported: detail.symbol.exported,
      role: detail.symbol.role,
      category: detail.symbol.category,
      // The indexer records these on the node; `symbol` does not carry them,
      // and they are the two things a reader most wants before opening a file.
      signature: typeof metadata.signature === 'string' ? metadata.signature : null,
      documentation: Array.isArray(metadata.documentation)
        ? metadata.documentation.filter((line): line is string => typeof line === 'string')
        : [],
    },
    relationships: {
      callers: plainSection(detail.callers),
      callees: plainSection(detail.callees),
      references: plainSection(detail.references),
      dependencies: relatedSection(detail.dependencies),
      dependents: relatedSection(detail.dependents),
      implementations: relatedSection(detail.implementations),
      apis: relatedSection(detail.apis),
      databases: relatedSection(detail.databases),
      documentation: relatedSection(detail.documentation),
      contracts: relatedSection(detail.contracts),
      children: plainSection(detail.children),
    },
    parent: detail.parent ? nodeRef(detail.parent) : null,
  };
}

function nodeRef(node: CodeNode): NodeOutput['relationships']['callers']['items'][number] {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    qualifiedName: node.qualifiedName ?? null,
    filePath: node.filePath ?? null,
    startLine: node.startLine ?? null,
  };
}

function plainSection(nodes: CodeNode[]): NodeOutput['relationships']['callers'] {
  const kept = nodes.slice(0, MAX_PER_SECTION);
  return { returned: kept.length, hasMore: nodes.length > MAX_PER_SECTION, items: kept.map(nodeRef) };
}

function relatedSection(nodes: RelatedNode[]): NodeOutput['relationships']['dependencies'] {
  const kept = nodes.slice(0, MAX_PER_SECTION);

  return {
    returned: kept.length,
    hasMore: nodes.length > MAX_PER_SECTION,
    items: kept.map((node) => ({
      ...nodeRef(node),
      relationship: node.relationship,
      direction: node.direction,
      evidence: toEvidence(node.evidence),
    })),
  };
}

/**
 * The answer as prose: identity, then how connected it is, then a look at the
 * connections that usually matter.
 *
 * Counts for every section, entries for only a few. A model deciding what to
 * open next needs to know that a node has thirty callers far more than it needs
 * all thirty names, and `structuredContent` has them when it does.
 */
function render(output: NodeOutput): string {
  const { node, relationships } = output;
  const lines: string[] = [];

  lines.push(node.qualifiedName ?? node.name);
  lines.push(`Type: ${node.type}${node.role ? ` (${node.role})` : ''}`);
  if (node.filePath) {
    lines.push(`File: ${node.filePath}${node.startLine === null ? '' : `:${String(node.startLine)}`}`);
  } else {
    lines.push('File: none — this node was derived, not read from source');
  }
  if (node.signature) lines.push(`Signature: ${node.signature}`);
  if (output.parent) lines.push(`Contained by: ${output.parent.qualifiedName ?? output.parent.name} [${output.parent.type}]`);

  const counts = Object.entries(relationships)
    .filter(([, value]) => value.returned > 0)
    .map(([name, value]) => `${name}: ${String(value.returned)}${value.hasMore ? '+' : ''}`);

  lines.push('');
  lines.push(counts.length > 0 ? counts.join('   ') : 'No relationships recorded for this node.');
  if (counts.some((entry) => entry.endsWith('+'))) {
    lines.push(`(a "+" means more than ${String(MAX_PER_SECTION)} exist; the number shown is a floor)`);
  }

  if (node.documentation.length > 0) {
    lines.push('');
    lines.push('Documentation:');
    for (const line of node.documentation) lines.push(`  ${line}`);
  }

  for (const [title, entries] of [
    ['Top callers', relationships.callers.items],
    ['Top callees', relationships.callees.items],
  ] as const) {
    if (entries.length === 0) continue;
    lines.push('');
    lines.push(`${title}:`);
    for (const entry of entries.slice(0, 5)) {
      lines.push(`  - ${entry.qualifiedName ?? entry.name} [${entry.type}]${entry.filePath ? `  ${entry.filePath}` : ''}`);
    }
  }

  const evidenced = relationships.dependencies.items
    .concat(relationships.databases.items, relationships.apis.items)
    .filter((entry) => entry.evidence !== null)
    .slice(0, 5);

  if (evidenced.length > 0) {
    lines.push('');
    lines.push('Architectural links, with the evidence for each:');
    for (const entry of evidenced) {
      const where = locationOf(entry.evidence);
      lines.push(
        `  - ${entry.relationship} ${entry.qualifiedName ?? entry.name} — ${String(entry.evidence?.source)}/${String(entry.evidence?.confidence)}, ${where}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * A failed lookup, reported as a tool result rather than thrown.
 *
 * A node that is not in this project reads as missing, which is the same answer
 * the API gives and the right one: it neither confirms the node exists
 * elsewhere nor goes looking.
 */
function failure(error: unknown, projectId: string, nodeId: string): CallToolResult {
  let text: string;

  if (error instanceof ApiUnreachableError) {
    text = `${error.message}\n\nStart it with \`pnpm dev:api\`, or point MCP_API_BASE_URL at where it is running.`;
  } else if (error instanceof ApiError && error.code === 'PROJECT_NOT_FOUND') {
    text = `There is no project with id "${projectId}". Call resolve_project to obtain a current project id — this one may have been deleted.`;
  } else if (error instanceof ApiError && error.code === 'NODE_NOT_FOUND') {
    text = `Node "${nodeId}" was not found in project ${projectId}. Node ids are project-specific, so one from another project will not resolve here — use search_graph in this project to find the node you want.`;
  } else if (error instanceof ApiError) {
    text = `The graph API refused the lookup (${error.code}): ${error.message}`;
  } else {
    text = `Could not read that node: ${error instanceof Error ? error.message : String(error)}`;
  }

  return { content: [{ type: 'text', text }], isError: true };
}
