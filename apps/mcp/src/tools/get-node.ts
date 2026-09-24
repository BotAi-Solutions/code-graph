import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeNode, NodeDetail, NodeRelationshipTotals, RelatedNode } from '@ckg/shared';
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
 *
 * **Two modes, one tool.** Without `relationship` it returns the overview: the
 * node, the exact size of every relationship section, and the first entries of
 * each. With `relationship` it returns one page of that one section, from the
 * section's own route, so any list can be read to the end. Nothing is ever cut
 * without saying so: every section carries its total, and a list shorter than
 * its total says how to fetch the rest.
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

/**
 * Entries per section in the overview's text. The structured sections carry
 * up to MAX_PER_SECTION; the prose shows fewer, beside the exact total and the
 * call that returns the rest, which is what keeps a hub node readable.
 */
const TEXT_PER_SECTION = 10;

/** Page size when `relationship` is given without `limit`. */
const DEFAULT_PAGE = 50;

/** The API's own ceiling for one section page. */
const MAX_PAGE = 100;

/**
 * The sections that can be read page by page, and the route that serves each.
 *
 * `subtypes` and `supertypes` are the two halves of `implementations`: what
 * implements or extends this node, and what this node implements or extends.
 * They are named separately because "every subclass" is a question in its own
 * right, and asking for it should not return the other half mixed in.
 */
const PAGED_SECTIONS = {
  callers: { route: 'callers', query: {}, relationship: 'CALLS', direction: 'incoming' },
  callees: { route: 'callees', query: {}, relationship: 'CALLS', direction: 'outgoing' },
  references: { route: 'references', query: {}, relationship: 'REFERENCES', direction: 'incoming' },
  implementations: { route: 'implementations', query: {}, relationship: null, direction: null },
  subtypes: { route: 'implementations', query: { direction: 'incoming' }, relationship: null, direction: null },
  supertypes: { route: 'implementations', query: { direction: 'outgoing' }, relationship: null, direction: null },
  dependencies: { route: 'dependencies', query: {}, relationship: null, direction: null },
  dependents: { route: 'dependents', query: {}, relationship: null, direction: null },
  children: { route: 'children', query: {}, relationship: 'CONTAINS', direction: 'outgoing' },
  apis: { route: 'apis', query: {}, relationship: null, direction: null },
  databases: { route: 'databases', query: {}, relationship: null, direction: null },
  documentation: { route: 'documentation', query: {}, relationship: null, direction: null },
  contracts: { route: 'contracts', query: {}, relationship: null, direction: null },
} as const;

type PagedSectionName = keyof typeof PAGED_SECTIONS;
const PAGED_SECTION_NAMES = Object.keys(PAGED_SECTIONS) as [PagedSectionName, ...PagedSectionName[]];

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
      .describe('True when the section holds more than `items`. Fetch the rest with `relationship` and `offset`.'),
    total: z
      .number()
      .int()
      .nullable()
      .describe('Exact size of the section. Null only when the API did not report it; `returned` is then a floor.'),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe('The offset of the next unread entry, for a follow-up call with `relationship`. Null when nothing remains.'),
    items: z.array(z.object(item)),
  });
}

/** Any entry of a paged section: plain sections carry the relationship they were read along. */
const pageItemSchema = {
  ...nodeRefSchema,
  relationship: z.string().nullable(),
  direction: z.string().nullable(),
  evidence: evidenceSchema.nullable(),
};

const pageSchema = z.object({
  relationship: z.enum(PAGED_SECTION_NAMES),
  total: z.number().int().nullable().describe('Exact size of the whole section. Null when the API did not report it.'),
  offset: z.number().int(),
  limit: z.number().int(),
  returned: z.number().int(),
  hasMore: z.boolean().describe('True when entries remain after this page.'),
  nextOffset: z.number().int().nullable().describe('Pass as `offset` to read the next page. Null on the last page.'),
  items: z.array(z.object(pageItemSchema)),
});

const nodeSchema = z.object({
    ...nodeRefSchema,
    endLine: z.number().int().nullable(),
    language: z.string().nullable(),
    exported: z.boolean().nullable(),
    role: z.string().nullable().describe('controller, service, repository, model … where an analyzer recognised one.'),
    category: z.string().describe('code, architecture or knowledge.'),
    signature: z.string().nullable().describe('As the indexer recorded it.'),
    documentation: z.array(z.string()).describe('Doc comments the indexer carried. Empty when there were none.'),
});

const relationshipsSchema = z.object({
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
});

/**
 * The overview carries `node`, `relationships` and `parent`; a page carries
 * `nodeId` and `page`. Optional rather than two tools, so "look at this node"
 * and "read the rest of its callers" stay one concept to a model.
 */
const outputSchema = {
  projectId: z.string().describe('The project this node was read from, and the only one it can belong to.'),
  nodeId: z.string(),
  node: nodeSchema.optional().describe('Overview only.'),
  relationships: relationshipsSchema.optional().describe('Overview only. Every section, each with its exact total.'),
  parent: z.object(nodeRefSchema).nullable().optional().describe('What CONTAINS this node: its class, its file, its directory.'),
  page: pageSchema.optional().describe('Page mode only: one page of the requested relationship.'),
};

/**
 * The two payloads, typed from the schemas the SDK validates them against —
 * written as the overview and the page rather than one all-optional shape, so
 * the code building each cannot forget a field its mode requires.
 */
type NodeOutput = {
  projectId: string;
  nodeId: string;
  node: z.infer<typeof nodeSchema>;
  relationships: z.infer<typeof relationshipsSchema>;
  parent: NodeRef | null;
};
type NodeRef = z.infer<z.ZodObject<typeof nodeRefSchema>>;
type PageOutput = { projectId: string; nodeId: string; page: z.infer<typeof pageSchema> };

export function registerGetNode(server: McpServer, api: ApiClient): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Inspect one graph node',
      description:
        'Get everything the graph knows about one node: what it is, where it is defined, and what it is connected to — callers, callees, references, implementations and subclasses, dependencies, members, the APIs and data stores it touches, and the documentation and contracts that mention it. ' +
        'Each connection carries the evidence it was derived from. ' +
        'Relationship lists are pageable: the default response gives every section\'s exact total and its first entries. A list shorter than its total is incomplete — do not treat the first page as the whole set. ' +
        'When a question needs completeness (every caller, every subclass, impact of a change), call again with `relationship` and `offset` until `nextOffset` is null; otherwise the first page is usually enough. ' +
        'Requires a projectId from resolve_project and a nodeId from search_graph, and reads only that project.',
      inputSchema: {
        projectId: z.uuid().describe('The project the node belongs to, from resolve_project. Required; there is no default.'),
        nodeId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .describe('A node id, as search_graph returns in `results[].id`.'),
        relationship: z
          .enum(PAGED_SECTION_NAMES)
          .optional()
          .describe(
            'Read one relationship section page by page instead of the overview. subtypes: what implements or extends this node. supertypes: what it implements or extends. implementations: both.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE)
          .optional()
          .describe(`Page size with \`relationship\`, 1–${String(MAX_PAGE)}. Defaults to ${String(DEFAULT_PAGE)}. Ignored without it.`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('First entry to return with `relationship`, from a previous `nextOffset`. Defaults to 0.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, nodeId, relationship, limit, offset }): Promise<CallToolResult> => {
      if (relationship) {
        return readPage(api, projectId, nodeId, relationship, limit ?? DEFAULT_PAGE, offset ?? 0);
      }

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

      const output = shape(projectId, nodeId, detail);

      return { content: [{ type: 'text', text: render(output) }], structuredContent: output };
    },
  );
}

/**
 * One page of one section, from that section's own route.
 *
 * The route reports the exact total in `meta`, which is what makes "20 of 67"
 * a fact. An API too old to report it still pages; the total is then null and
 * `hasMore` falls back to "the page was full", which is said out loud.
 */
async function readPage(
  api: ApiClient,
  projectId: string,
  nodeId: string,
  name: PagedSectionName,
  limit: number,
  offset: number,
): Promise<CallToolResult> {
  const spec = PAGED_SECTIONS[name];
  let items: Array<CodeNode | RelatedNode>;
  let meta: Record<string, unknown>;

  try {
    const result = await api.getWithMeta<Array<CodeNode | RelatedNode>>(
      `/api/projects/${encodeURIComponent(projectId)}/graph/nodes/${encodeURIComponent(nodeId)}/${spec.route}`,
      { ...spec.query, limit: String(limit), offset: String(offset) },
    );
    items = result.data;
    meta = result.meta as Record<string, unknown>;
  } catch (error) {
    return failure(error, projectId, nodeId);
  }

  const foreign = items.find((item) => item.projectId !== projectId);
  if (foreign) {
    return {
      content: [
        {
          type: 'text',
          text: `Refusing to return this page: a lookup in project ${projectId} came back carrying a node from project ${foreign.projectId}. Nothing in it can be safely attributed to a project, so none of it is reported.`,
        },
      ],
      isError: true,
    };
  }

  const total = typeof meta.total === 'number' && 'hasMore' in meta ? meta.total : null;
  const end = offset + items.length;
  const hasMore = total === null ? items.length === limit : end < total;

  const output: PageOutput = {
    projectId,
    nodeId,
    page: {
      relationship: name,
      total,
      offset,
      limit,
      returned: items.length,
      hasMore,
      nextOffset: hasMore ? end : null,
      items: items.map((item) => {
        const related = 'relationship' in item ? (item as RelatedNode) : null;
        return {
          ...nodeRef(item),
          relationship: related?.relationship ?? spec.relationship,
          direction: related?.direction ?? spec.direction,
          evidence: related ? toEvidence(related.evidence) : null,
        };
      }),
    },
  };

  return { content: [{ type: 'text', text: renderPage(output) }], structuredContent: output };
}

function renderPage(output: PageOutput): string {
  const { page } = output;
  const lines: string[] = [];
  const range =
    page.returned === 0 ? 'none' : `${String(page.offset + 1)}–${String(page.offset + page.returned)}`;
  const of = page.total === null ? '' : ` of ${String(page.total)}`;

  lines.push(`${page.relationship} of node ${output.nodeId}: ${range}${of}`);
  if (page.total === null) {
    lines.push('(the API did not report a total; a full page may mean there are more)');
  }

  page.items.forEach((item, index) => {
    const link = item.relationship && item.direction ? `  ${arrow(item.direction)} ${item.relationship}` : '';
    lines.push(`${String(page.offset + index + 1)}. ${item.qualifiedName ?? item.name} [${item.type}]${link}`);
    lines.push(`   ${where(item)}`);
  });

  lines.push('');
  if (page.hasMore && page.nextOffset !== null) {
    const remaining = page.total === null ? 'more may exist' : `${String(page.total - page.nextOffset)} more`;
    lines.push(`Incomplete: ${remaining}. Next page: relationship "${page.relationship}", offset ${String(page.nextOffset)}.`);
  } else if (page.returned === 0 && page.offset > 0) {
    lines.push('Past the end of this section; nothing remains.');
  } else {
    lines.push(`Complete: this is the end of ${page.relationship}.`);
  }

  return lines.join('\n');
}

/** The order the paged routes use for related sections: direction, relationship, name, id. */
function routeOrder(a: { direction: string; relationship: string; name: string; id: string }, b: typeof a): number {
  return (
    a.direction.localeCompare(b.direction) ||
    a.relationship.localeCompare(b.relationship) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

function arrow(direction: string): string {
  return direction === 'incoming' ? '←' : '→';
}

function where(node: NodeRef): string {
  if (!node.filePath) return 'no file — derived, not read from source';
  return node.startLine === null ? node.filePath : `${node.filePath}:${String(node.startLine)}`;
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

function shape(projectId: string, nodeId: string, detail: NodeDetail): NodeOutput {
  const metadata = detail.node.metadata ?? {};
  const totals = detail.totals ?? null;

  return {
    projectId,
    nodeId,
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
      callers: plainSection(detail.callers, totalOf(totals, 'callers')),
      callees: plainSection(detail.callees, totalOf(totals, 'callees')),
      references: plainSection(detail.references, totalOf(totals, 'references')),
      dependencies: relatedSection(detail.dependencies, totalOf(totals, 'dependencies')),
      dependents: relatedSection(detail.dependents, totalOf(totals, 'dependents')),
      implementations: relatedSection(detail.implementations, totalOf(totals, 'implementations')),
      apis: relatedSection(detail.apis, totalOf(totals, 'apis')),
      databases: relatedSection(detail.databases, totalOf(totals, 'databases')),
      documentation: relatedSection(detail.documentation, totalOf(totals, 'documentation')),
      contracts: relatedSection(detail.contracts, totalOf(totals, 'contracts')),
      children: plainSection(detail.children, totalOf(totals, 'children')),
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

function totalOf(totals: NodeRelationshipTotals | null, name: keyof NodeRelationshipTotals): number | null {
  return totals ? totals[name] : null;
}

/**
 * How much of a section is shown, and what is left.
 *
 * With a total from the API the answer is exact. Without one — an older API —
 * the one-extra-row probe is all there is, and the section says it is a floor.
 */
function accounting(fetched: number, kept: number, total: number | null) {
  const hasMore = total === null ? fetched > kept : total > kept;
  return { returned: kept, hasMore, total, nextOffset: hasMore ? kept : null };
}

function plainSection(nodes: CodeNode[], total: number | null): NodeOutput['relationships']['callers'] {
  const kept = nodes.slice(0, MAX_PER_SECTION);
  return { ...accounting(nodes.length, kept.length, total), items: kept.map(nodeRef) };
}

function relatedSection(nodes: RelatedNode[], total: number | null): NodeOutput['relationships']['dependencies'] {
  const kept = nodes.slice(0, MAX_PER_SECTION);

  return {
    ...accounting(nodes.length, kept.length, total),
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
    .filter(([, value]) => value.returned > 0 || (value.total ?? 0) > 0)
    .map(([name, value]) =>
      value.total === null
        ? `${name}: ${String(value.returned)}${value.hasMore ? '+' : ''}`
        : `${name}: ${String(value.total)}`,
    );

  lines.push('');
  lines.push(counts.length > 0 ? counts.join('   ') : 'No relationships recorded for this node.');
  if (counts.some((entry) => entry.endsWith('+'))) {
    lines.push(`(a "+" means more than ${String(MAX_PER_SECTION)} exist; the number shown is a floor)`);
  } else if (counts.length > 0) {
    lines.push('(exact totals)');
  }

  if (node.documentation.length > 0) {
    lines.push('');
    lines.push('Documentation:');
    for (const line of node.documentation) lines.push(`  ${line}`);
  }

  const listed: Array<[string, PagedSectionName, Array<NodeRef & { relationship?: string; direction?: string }>, NodeOutput['relationships']['callers'] | NodeOutput['relationships']['dependencies']]> = [
    ['Top callers', 'callers', relationships.callers.items, relationships.callers],
    ['Top callees', 'callees', relationships.callees.items, relationships.callees],
    ['References', 'references', relationships.references.items, relationships.references],
    ['Implementations and inheritance', 'implementations', relationships.implementations.items, relationships.implementations],
    ['Members', 'children', relationships.children.items, relationships.children],
  ];

  for (const [title, name, entries, sectionInfo] of listed) {
    if (entries.length === 0) continue;
    const shown = entries.slice(0, TEXT_PER_SECTION);
    lines.push('');
    lines.push(`${title}:`);
    for (const entry of shown) {
      const link = entry.relationship && entry.direction ? `  ${arrow(entry.direction)} ${entry.relationship}` : '';
      lines.push(`  - ${entry.qualifiedName ?? entry.name} [${entry.type}]${link}${entry.filePath ? `  ${entry.filePath}` : ''}`);
    }
    const total = sectionInfo.total;
    if (total !== null && total > shown.length) {
      lines.push(
        `  … showing ${String(shown.length)} of ${String(total)}; ${String(total - shown.length)} more — get_node with relationship "${name}", offset ${String(shown.length)}`,
      );
    } else if (total === null && (sectionInfo.hasMore || entries.length > shown.length)) {
      lines.push(`  … more exist — get_node with relationship "${name}", offset ${String(shown.length)}`);
    }
  }

  const linked = (['dependencies', 'dependents', 'apis', 'databases', 'contracts', 'documentation'] as const).filter(
    (name) => relationships[name].items.length > 0,
  );

  if (linked.length > 0) {
    lines.push('');
    lines.push('Architectural links, with the evidence for each:');
    for (const name of linked) {
      const sectionInfo = relationships[name];
      const complete = sectionInfo.total !== null && sectionInfo.total <= sectionInfo.items.length;
      // A complete section is re-sorted into its paged route's order, so an
      // offset continues it exactly; a partial one can only be read from 0.
      const ordered = complete ? [...sectionInfo.items].sort(routeOrder) : sectionInfo.items;
      const shown = ordered.slice(0, TEXT_PER_SECTION);

      for (const entry of shown) {
        const evidence = entry.evidence
          ? `${entry.evidence.source}/${entry.evidence.confidence}, ${locationOf(entry.evidence)}`
          : 'no evidence recorded';
        lines.push(`  - ${entry.relationship} ${entry.qualifiedName ?? entry.name} — ${evidence}`);
      }

      const total = sectionInfo.total ?? (sectionInfo.hasMore ? null : sectionInfo.items.length);
      if (total === null || total > shown.length) {
        const count = total === null ? 'more exist' : `showing ${String(shown.length)} of ${String(total)}`;
        const from = complete ? shown.length : 0;
        lines.push(`  … ${name}: ${count} — get_node with relationship "${name}", offset ${String(from)}`);
      }
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
