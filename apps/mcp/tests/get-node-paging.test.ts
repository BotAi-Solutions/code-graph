import { afterEach, describe, expect, it } from 'vitest';
import type { CodeNode, NodeRelationshipTotals, RelatedNode } from '@ckg/shared';
import {
  codeNode,
  createMcpHarness,
  nodeDetail,
  ok,
  okPaged,
  PROJECT_ID,
  relatedNode,
  textOf,
  toolNamed,
  type McpHarness,
  type StubbedRequest,
} from './helpers/harness.js';

/**
 * Complete relationship sections through MCP.
 *
 * The stub API below stands in for a store holding a hub node with 67
 * callers, 14 callees, 8 references, 51 subclasses and one interface. It
 * answers the detail route capped at the tool's `limit`, with exact `totals`,
 * and each section route with real offset arithmetic and `meta.total` — the
 * contract the API suite verifies against the in-memory store and PostgreSQL.
 * Every test then asks the same question: can a model, using only the tool,
 * see that a list is incomplete and read all of it?
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const NODE_ID = 'hub';

const callers = Array.from({ length: 67 }, (_, i) =>
  codeNode({ id: `caller-${String(i).padStart(2, '0')}`, name: `Caller${String(i).padStart(2, '0')}`, type: 'method' }),
);
const callees = Array.from({ length: 14 }, (_, i) =>
  codeNode({ id: `callee-${String(i).padStart(2, '0')}`, name: `Callee${String(i).padStart(2, '0')}`, type: 'method' }),
);
const references = Array.from({ length: 8 }, (_, i) =>
  codeNode({ id: `ref-${String(i)}`, name: `useHub${String(i)}`, type: 'function' }),
);
const subtypes: RelatedNode[] = Array.from({ length: 51 }, (_, i) =>
  relatedNode({
    id: `sub-${String(i).padStart(2, '0')}`,
    name: `Service${String(i).padStart(2, '0')}`,
    qualifiedName: `Service${String(i).padStart(2, '0')}`,
    type: 'class',
    relationship: 'EXTENDS',
    direction: 'incoming',
  }),
);
const supertypes: RelatedNode[] = [
  relatedNode({ id: 'contract', name: 'HubContract', qualifiedName: 'HubContract', type: 'interface', relationship: 'IMPLEMENTS', direction: 'outgoing' }),
];
const implementations = [...subtypes, ...supertypes];

const TOTALS: NodeRelationshipTotals = {
  callers: 67,
  callees: 14,
  references: 8,
  dependencies: 0,
  dependents: 0,
  apis: 0,
  databases: 0,
  documentation: 0,
  contracts: 0,
  implementations: 52,
  children: 0,
};

const SECTIONS: Record<string, (query: Record<string, string>) => Array<CodeNode | RelatedNode>> = {
  callers: () => callers,
  callees: () => callees,
  references: () => references,
  implementations: (query) =>
    query.direction === 'incoming' ? subtypes : query.direction === 'outgoing' ? supertypes : implementations,
  dependencies: () => [],
  dependents: () => [],
  children: () => [],
};

/** The API, as the paging contract describes it. */
function api(request: StubbedRequest) {
  const base = `/api/projects/${PROJECT_ID}/graph/nodes/${NODE_ID}`;
  if (request.path === base) {
    const limit = Number(request.query.limit ?? '100');
    return {
      body: ok(
        nodeDetail({
          node: codeNode({ id: NODE_ID, name: 'BaseService', type: 'class' }),
          callers: callers.slice(0, limit),
          callees: callees.slice(0, limit),
          references: references.slice(0, limit),
          implementations: implementations.slice(0, limit),
          totals: TOTALS,
        }),
      ),
    };
  }

  const section = request.path.slice(base.length + 1);
  const all = SECTIONS[section]?.(request.query) ?? [];
  const limit = Number(request.query.limit ?? '100');
  const offset = Number(request.query.offset ?? '0');
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return {
    body: okPaged(items, {
      total: all.length,
      limit,
      offset,
      hasMore: next < all.length,
      nextOffset: next < all.length ? next : null,
    }),
  };
}

type Section = { returned: number; total: number | null; hasMore: boolean; nextOffset: number | null; items: Array<{ id: string }> };
type Page = {
  relationship: string;
  total: number | null;
  offset: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  items: Array<{ id: string; relationship: string | null; direction: string | null }>;
};

const overview = async () => harness.client.callTool({ name: 'get_node', arguments: { projectId: PROJECT_ID, nodeId: NODE_ID } });
const page = async (relationship: string, extra: Record<string, number> = {}) =>
  harness.client.callTool({ name: 'get_node', arguments: { projectId: PROJECT_ID, nodeId: NODE_ID, relationship, ...extra } });
const sectionOf = (result: { structuredContent?: unknown }, name: string) =>
  (result.structuredContent as { relationships: Record<string, Section> }).relationships[name] as Section;
const pageOf = (result: { structuredContent?: unknown }) => (result.structuredContent as { page: Page }).page;

describe('tool metadata', () => {
  it('offers relationship, limit and offset, and keeps projectId and nodeId the only required inputs', async () => {
    harness = await createMcpHarness(api);
    const tool = await toolNamed(harness, 'get_node');
    const schema = tool.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };

    expect(schema.required.sort()).toEqual(['nodeId', 'projectId']);
    expect(schema.properties.relationship?.enum).toEqual(
      expect.arrayContaining(['callers', 'callees', 'references', 'implementations', 'subtypes', 'supertypes', 'dependencies', 'dependents', 'children']),
    );
    expect(schema.properties).toHaveProperty('limit');
    expect(schema.properties).toHaveProperty('offset');
  });

  it('tells the model lists are pageable and that a first page is not the whole set', async () => {
    harness = await createMcpHarness(api);
    const tool = await toolNamed(harness, 'get_node');

    expect(tool.description).toMatch(/pageable/);
    expect(tool.description).toMatch(/do not treat the first page as the whole set/);
    expect(tool.description).toMatch(/nextOffset/);
  });
});

describe('overview', () => {
  it('1. returns the existing node', async () => {
    harness = await createMcpHarness(api);
    const result = await overview();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ projectId: PROJECT_ID, nodeId: NODE_ID, node: { id: NODE_ID, name: 'BaseService' } });
  });

  it('2–3. reports the complete caller and callee counts, not the page size', async () => {
    harness = await createMcpHarness(api);
    const result = await overview();

    expect(sectionOf(result, 'callers')).toMatchObject({ total: 67, returned: 20, hasMore: true, nextOffset: 20 });
    expect(sectionOf(result, 'callees')).toMatchObject({ total: 14, returned: 14, hasMore: false, nextOffset: null });
    expect(textOf(result)).toMatch(/callers: 67/);
    expect(textOf(result)).toMatch(/callees: 14/);
  });

  it('4–5. lists references and implementations in the text, with their totals', async () => {
    harness = await createMcpHarness(api);
    const text = textOf(await overview());

    expect(text).toMatch(/References:\n\s+- useHub0 \[function\]/);
    expect(text).toMatch(/Implementations and inheritance:\n\s+- HubContract \[interface\]\s+→ IMPLEMENTS|Implementations and inheritance:\n\s+- Service00 \[class\]\s+← EXTENDS/);
    expect(text).toMatch(/implementations: 52/);
    expect(text).toMatch(/showing 10 of 52; 42 more — get_node with relationship "implementations", offset 10/);
  });

  it('says, in the text, exactly how many callers are not shown and how to read them', async () => {
    harness = await createMcpHarness(api);
    const text = textOf(await overview());

    expect(text).toMatch(/showing 10 of 67; 57 more — get_node with relationship "callers", offset 10/);
    expect(text).toMatch(/\(exact totals\)/);
    expect(text).not.toMatch(/a "\+" means/);
  });
});

describe('architectural sections', () => {
  const tables: RelatedNode[] = Array.from({ length: 15 }, (_, i) =>
    relatedNode({
      id: `t-${String(i).padStart(2, '0')}`,
      name: `table${String(i).padStart(2, '0')}`,
      qualifiedName: `postgresql.table${String(i).padStart(2, '0')}`,
      type: 'table',
      relationship: 'WRITES_TO',
      direction: 'outgoing',
    }),
  );

  function withData(request: StubbedRequest) {
    const base = `/api/projects/${PROJECT_ID}/graph/nodes/${NODE_ID}`;
    if (request.path === base) {
      return { body: ok(nodeDetail({ node: codeNode({ id: NODE_ID }), databases: tables, totals: { ...TOTALS, databases: 15 } })) };
    }
    const offset = Number(request.query.offset ?? '0');
    const limit = Number(request.query.limit ?? '100');
    const items = tables.slice(offset, offset + limit);
    return { body: okPaged(items, { total: 15, limit, offset, hasMore: offset + items.length < 15 }) };
  }

  it('lists every data link up to the preview, says how many are left, and pages the rest from the right offset', async () => {
    harness = await createMcpHarness(withData);
    const text = textOf(await overview());

    expect(text).toMatch(/databases: 15/);
    expect(text.split('\n').filter((line) => line.includes('WRITES_TO postgresql.table'))).toHaveLength(10);
    expect(text).toMatch(/databases: showing 10 of 15 — get_node with relationship "databases", offset 10/);

    const rest = pageOf(await page('databases', { offset: 10 }));
    expect(harness.requests.at(-1)?.path).toBe(`/api/projects/${PROJECT_ID}/graph/nodes/${NODE_ID}/databases`);
    expect(rest).toMatchObject({ total: 15, offset: 10, returned: 5, hasMore: false });
    expect(rest.items[0]).toMatchObject({ id: 't-10', relationship: 'WRITES_TO', direction: 'outgoing' });
  });
});

describe('paging one section', () => {
  it('6. first page: the requested window, the total and where to continue', async () => {
    harness = await createMcpHarness(api);
    const result = await page('callers', { limit: 20 });

    expect(harness.requests.at(-1)).toMatchObject({
      path: `/api/projects/${PROJECT_ID}/graph/nodes/${NODE_ID}/callers`,
      query: { limit: '20', offset: '0' },
    });
    expect(pageOf(result)).toMatchObject({ relationship: 'callers', total: 67, offset: 0, returned: 20, hasMore: true, nextOffset: 20 });
    expect(textOf(result)).toMatch(/callers of node hub: 1–20 of 67/);
    expect(textOf(result)).toMatch(/Incomplete: 47 more\. Next page: relationship "callers", offset 20\./);
  });

  it('7. second page continues exactly where the first stopped', async () => {
    harness = await createMcpHarness(api);
    const first = pageOf(await page('callers', { limit: 20 }));
    const second = pageOf(await page('callers', { limit: 20, offset: first.nextOffset ?? -1 }));

    expect(second).toMatchObject({ offset: 20, returned: 20, nextOffset: 40 });
    expect(second.items[0]?.id).toBe('caller-20');
    expect(first.items.map((i) => i.id)).not.toContain(second.items[0]?.id);
  });

  it('8–10. following nextOffset to the end returns every stored caller exactly once, and says it is complete', async () => {
    harness = await createMcpHarness(api);
    const seen: string[] = [];
    let offset: number | null = 0;
    let last: Awaited<ReturnType<typeof page>> | null = null;

    while (offset !== null) {
      last = await page('callers', { limit: 25, offset });
      const current = pageOf(last);
      expect(current.total).toBe(67);
      seen.push(...current.items.map((item) => item.id));
      expect(current.hasMore).toBe(current.nextOffset !== null);
      offset = current.nextOffset;
    }

    expect(seen).toEqual(callers.map((node) => node.id));
    expect(textOf(last as never)).toMatch(/Complete: this is the end of callers\./);
  });

  it('reads every subclass, and only subclasses, through `subtypes`', async () => {
    harness = await createMcpHarness(api);
    const first = pageOf(await page('subtypes', { limit: 50 }));
    const rest = pageOf(await page('subtypes', { limit: 50, offset: 50 }));

    expect(harness.requests.at(-1)?.query).toMatchObject({ direction: 'incoming' });
    expect(first.total).toBe(51);
    expect([...first.items, ...rest.items]).toHaveLength(51);
    expect(new Set([...first.items, ...rest.items].map((item) => `${String(item.relationship)} ${String(item.direction)}`))).toEqual(
      new Set(['EXTENDS incoming']),
    );
    expect(rest).toMatchObject({ returned: 1, hasMore: false, nextOffset: null });
  });

  it('labels plain sections with the relationship they were read along', async () => {
    harness = await createMcpHarness(api);
    const result = pageOf(await page('references', { limit: 3 }));

    expect(result.items[0]).toMatchObject({ relationship: 'REFERENCES', direction: 'incoming' });
  });

  it('uses a default page of 50 and a default offset of 0', async () => {
    harness = await createMcpHarness(api);
    await page('callers');

    expect(harness.requests.at(-1)?.query).toMatchObject({ limit: '50', offset: '0' });
  });

  it('says so past the end rather than returning an empty page silently', async () => {
    harness = await createMcpHarness(api);
    const result = await page('callees', { offset: 100 });

    expect(pageOf(result)).toMatchObject({ total: 14, returned: 0, hasMore: false });
    expect(textOf(result)).toMatch(/Past the end of this section/);
  });

  it('rejects a page larger than the API serves and a negative offset, without troubling the API', async () => {
    harness = await createMcpHarness(api);
    const tooBig = await page('callers', { limit: 101 });
    const negative = await page('callers', { offset: -1 });

    expect(tooBig.isError).toBe(true);
    expect(negative.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('falls back to "a full page may mean more" against an API that reports no total', async () => {
    harness = await createMcpHarness(() => ({ body: ok(callers.slice(0, 5)) }));
    const result = await page('callers', { limit: 5 });

    expect(pageOf(result)).toMatchObject({ total: null, hasMore: true, nextOffset: 5 });
    expect(textOf(result)).toMatch(/did not report a total/);
  });

  it('refuses a page carrying a node from another project', async () => {
    harness = await createMcpHarness(() => ({
      body: okPaged([codeNode({ id: 'x', projectId: '7c1f2b34-5d6e-4f80-9a1b-2c3d4e5f6071' })], { total: 1, hasMore: false }),
    }));
    const result = await page('callers');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Refusing to return this page/);
  });
});
