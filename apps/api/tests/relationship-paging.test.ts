import { beforeEach, describe, expect, it } from 'vitest';
import type { CodeGraph, NodeDetail, Project } from '@ckg/shared';
import { body, createHarness, type Harness } from './helpers/harness.js';

/**
 * Relationship sections, complete: exact totals beside every capped list, and
 * offset paging through the rest.
 *
 * The graph here is built so that every section is bigger than the page asked
 * for, which is the only situation in which a cap can hide something. Each
 * test then asks whether what the API reported is *all* of what the store
 * holds — by count, and by concatenating pages back into the whole.
 */

let harness: Harness;
let projectId: string;

/** `hub` with 7 callers, 3 callees, 5 references, 4 subclasses, 1 interface and 6 members. */
function hubGraph(project: string): CodeGraph {
  const node = (id: string, type: CodeGraph['nodes'][number]['type'], name: string, filePath = `src/${id}.ts`) => ({
    id,
    projectId: project,
    type,
    name,
    filePath,
    startLine: 1,
    endLine: 10,
  });
  const edge = (source: string, relationship: CodeGraph['edges'][number]['relationship'], target: string) => ({
    id: `${source}-${relationship}-${target}`,
    projectId: project,
    sourceNodeId: source,
    targetNodeId: target,
    relationship,
  });

  const callers = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  const callees = ['e1', 'e2', 'e3'];
  const refs = ['r1', 'r2', 'r3', 'r4', 'r5'];
  const subs = ['s1', 's2', 's3', 's4'];
  const members = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

  return {
    nodes: [
      node('hub', 'class', 'Hub'),
      node('iface', 'interface', 'HubContract'),
      node('t1', 'table', 'albums'),
      node('t2', 'table', 'assets'),
      node('t3', 'queue', 'jobs'),
      ...callers.map((id) => node(id, 'method', `Caller${id}`)),
      ...callees.map((id) => node(id, 'method', `Callee${id}`)),
      ...refs.map((id) => node(id, 'function', `Ref${id}`)),
      ...subs.map((id) => node(id, 'class', `Sub${id}`)),
      ...members.map((id, index) => ({ ...node(id, 'method', `member${id}`, 'src/hub.ts'), startLine: index + 2 })),
    ],
    edges: [
      ...callers.map((id) => edge(id, 'CALLS', 'hub')),
      ...callees.map((id) => edge('hub', 'CALLS', id)),
      ...refs.map((id) => edge(id, 'REFERENCES', 'hub')),
      ...subs.map((id) => edge(id, 'EXTENDS', 'hub')),
      edge('hub', 'IMPLEMENTS', 'iface'),
      ...members.map((id) => edge('hub', 'CONTAINS', id)),
      // An outgoing REFERENCES no section shows: must not be counted anywhere.
      edge('hub', 'REFERENCES', 'r1'),
      // Data links in both directions, for the databases section.
      edge('hub', 'WRITES_TO', 't1'),
      edge('hub', 'READS_FROM', 't2'),
      edge('t3', 'SUBSCRIBES', 'hub'),
    ],
  };
}

beforeEach(async () => {
  harness = await createHarness();
  const created = await harness.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'hub' } });
  projectId = (body<Project>(created).data as Project).id;
  harness.graph.setGraph(hubGraph(projectId));
});

async function get<T>(path: string) {
  const response = await harness.app.inject({ method: 'GET', url: `/api/projects/${projectId}${path}` });
  return { status: response.statusCode, envelope: body<T>(response) };
}

type Page = Array<{ id: string; direction?: string; relationship?: string }>;

describe('node detail totals', () => {
  it('reports the exact size of every section, however small the page', async () => {
    const { envelope } = await get<NodeDetail>('/graph/nodes/hub?limit=2');

    expect(envelope.data?.callers).toHaveLength(2);
    expect(envelope.data?.totals).toEqual({
      callers: 7,
      callees: 3,
      references: 5,
      dependencies: 0,
      dependents: 0,
      apis: 0,
      databases: 3,
      documentation: 0,
      contracts: 0,
      implementations: 5,
      children: 6,
    });
  });

  it('agrees with the lists when nothing was cut', async () => {
    const { envelope } = await get<NodeDetail>('/graph/nodes/hub?limit=100');
    const detail = envelope.data as NodeDetail;

    expect(detail.totals?.callers).toBe(detail.callers.length);
    expect(detail.totals?.callees).toBe(detail.callees.length);
    expect(detail.totals?.references).toBe(detail.references.length);
    expect(detail.totals?.implementations).toBe(detail.implementations.length);
    expect(detail.totals?.children).toBe(detail.children.length);
  });
});

describe('section routes page through the whole section', () => {
  it.each([
    ['callers', 7],
    ['callees', 3],
    ['references', 5],
    ['implementations', 5],
    ['children', 6],
    ['databases', 3],
  ] as const)('%s: pages concatenate to exactly the full section, with no repeats', async (section, total) => {
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;

    while (offset !== null) {
      const { status, envelope } = await get<Page>(`/graph/nodes/hub/${section}?limit=2&offset=${String(offset)}`);
      expect(status).toBe(200);
      expect(envelope.meta).toMatchObject({ total, limit: 2, offset });
      seen.push(...(envelope.data ?? []).map((item) => `${item.id}:${item.direction ?? ''}`));
      offset = (envelope.meta as { nextOffset: number | null }).nextOffset;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(total);
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    const everything = await get<Page>(`/graph/nodes/hub/${section}?limit=100`);
    expect(seen).toEqual((everything.envelope.data ?? []).map((item) => `${item.id}:${item.direction ?? ''}`));
  });

  it('reports hasMore and nextOffset on the first page, and neither on the last', async () => {
    const first = await get<Page>('/graph/nodes/hub/callers?limit=5');
    expect(first.envelope.meta).toMatchObject({ total: 7, offset: 0, hasMore: true, nextOffset: 5 });

    const last = await get<Page>('/graph/nodes/hub/callers?limit=5&offset=5');
    expect(last.envelope.data).toHaveLength(2);
    expect(last.envelope.meta).toMatchObject({ total: 7, offset: 5, hasMore: false, nextOffset: null });
  });

  it('keeps the total past the end, where a page is empty', async () => {
    const { envelope } = await get<Page>('/graph/nodes/hub/callers?limit=5&offset=50');
    expect(envelope.data).toEqual([]);
    expect(envelope.meta).toMatchObject({ total: 7, hasMore: false });
  });

  it('narrows implementations to one side', async () => {
    const incoming = await get<Page>('/graph/nodes/hub/implementations?direction=incoming');
    expect(incoming.envelope.meta).toMatchObject({ total: 4 });
    expect(new Set((incoming.envelope.data ?? []).map((item) => item.relationship))).toEqual(new Set(['EXTENDS']));

    const outgoing = await get<Page>('/graph/nodes/hub/implementations?direction=outgoing');
    expect(outgoing.envelope.meta).toMatchObject({ total: 1 });
    expect(outgoing.envelope.data?.[0]).toMatchObject({ id: 'iface', relationship: 'IMPLEMENTS' });
  });

  it('rejects a negative offset and an unknown direction', async () => {
    expect((await get('/graph/nodes/hub/callers?offset=-1')).status).toBe(400);
    expect((await get('/graph/nodes/hub/implementations?direction=sideways')).status).toBe(400);
  });
});

describe('search file filter', () => {
  it('applies the path prefix before paging, so a match past the first page is not lost', async () => {
    // "Caller" matches seven methods in seven files. Narrowed to one file, the
    // match must be found even though it is not on the first unfiltered page.
    const unfiltered = await get<Page>('/graph/search?q=caller&limit=2');
    expect(unfiltered.envelope.data?.map((node) => node.id)).not.toContain('c7');

    const filtered = await get<Page>('/graph/search?q=caller&limit=2&file=src/c7.ts');
    expect(filtered.envelope.data?.map((node) => node.id)).toEqual(['c7']);
    expect(filtered.envelope.meta).toMatchObject({ total: 1, file: 'src/c7.ts' });
  });

  it('counts what the filter keeps, not the page', async () => {
    const { envelope } = await get<Page>('/graph/search?q=member&limit=2&file=src/hub.ts');
    expect(envelope.data).toHaveLength(2);
    expect(envelope.meta).toMatchObject({ total: 6 });
  });

  it('treats the prefix case-insensitively and ignores surrounding slashes', async () => {
    const { envelope } = await get<Page>('/graph/search?q=caller&file=/SRC/C3.TS/');
    expect(envelope.data?.map((node) => node.id)).toEqual(['c3']);
  });
});
