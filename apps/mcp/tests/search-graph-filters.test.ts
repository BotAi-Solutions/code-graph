import { afterEach, describe, expect, it } from 'vitest';
import {
  codeNode,
  createMcpHarness,
  okPaged,
  PROJECT_ID,
  textOf,
  toolNamed,
  type McpHarness,
  type StubbedRequest,
} from './helpers/harness.js';

/**
 * `search_graph` narrowings: the API's own `nodeTypes` and `file` filters,
 * passed through, plus paging.
 *
 * The filtering itself is the API's and is tested there against the in-memory
 * store and PostgreSQL. What this suite holds the tool to is that each filter
 * reaches the API in the form it accepts, that nothing is filtered a second
 * time here, and that the model is told what was narrowed and what remains.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

/** A store holding a type-literal field, a test helper and the class, like Immich's SharedLink. */
const STORE = [
  codeNode({ id: 'field', type: 'variable', name: 'sharedLink', qualifiedName: 'AuthDto.typeLiteral4.sharedLink', filePath: 'src/dtos/auth.dto.ts' }),
  codeNode({ id: 'factory', type: 'method', name: 'sharedLink', qualifiedName: 'AuthFactory.sharedLink', filePath: 'test/factories/auth.factory.ts' }),
  codeNode({ id: 'service', type: 'class', name: 'SharedLinkService', filePath: 'src/services/shared-link.service.ts' }),
  codeNode({ id: 'controller', type: 'class', name: 'SharedLinkController', filePath: 'src/controllers/shared-link.controller.ts' }),
  codeNode({ id: 'get', type: 'method', name: 'get', qualifiedName: 'SharedLinkService.get', filePath: 'src/services/shared-link.service.ts' }),
];

/** Filters the way the API does: types exact, file a case-insensitive prefix, then pages. */
function api(request: StubbedRequest) {
  const q = (request.query.q ?? '').toLowerCase();
  const types = request.query.nodeTypes?.split(',');
  const file = request.query.file?.toLowerCase();
  const limit = Number(request.query.limit ?? '20');
  const offset = Number(request.query.offset ?? '0');
  const matched = STORE.filter(
    (node) =>
      (node.name.toLowerCase().includes(q) || (node.qualifiedName ?? '').toLowerCase().includes(q)) &&
      (!types || types.includes(node.type)) &&
      (!file || (node.filePath ?? '').toLowerCase().startsWith(file)),
  );
  return { body: okPaged(matched.slice(offset, offset + limit), { total: matched.length, limit, offset }) };
}

const search = (args: Record<string, unknown>) =>
  harness.client.callTool({ name: 'search_graph', arguments: { projectId: PROJECT_ID, ...args } });

describe('schema', () => {
  it('exposes nodeTypes, file and offset, and still requires only projectId and query', async () => {
    harness = await createMcpHarness(api);
    const tool = await toolNamed(harness, 'search_graph');
    const schema = tool.inputSchema as { properties: Record<string, { type?: string; items?: { enum?: string[] } }>; required: string[] };

    expect(schema.required.sort()).toEqual(['projectId', 'query']);
    expect(schema.properties.nodeTypes?.items?.enum).toEqual(expect.arrayContaining(['class', 'method', 'api', 'table']));
    expect(schema.properties.file?.type).toBe('string');
    expect(schema.properties).toHaveProperty('offset');
    expect(tool.description).toMatch(/nodeTypes/);
  });
});

describe('filters', () => {
  it('11. node type filter reaches the API as its CSV parameter and narrows the result', async () => {
    harness = await createMcpHarness(api);
    const result = await search({ query: 'SharedLink', nodeTypes: ['class'] });

    expect(harness.requests[0]?.query).toMatchObject({ q: 'SharedLink', nodeTypes: 'class' });
    expect((result.structuredContent as { results: Array<{ id: string }> }).results.map((node) => node.id)).toEqual([
      'service',
      'controller',
    ]);
    expect(textOf(result)).toMatch(/matching "SharedLink" \(types class\)/);
  });

  it('12. file filter reaches the API untouched and narrows to that path', async () => {
    harness = await createMcpHarness(api);
    const result = await search({ query: 'sharedLink', file: 'test/' });

    expect(harness.requests[0]?.query).toMatchObject({ file: 'test/' });
    expect(result.structuredContent).toMatchObject({ total: 1, results: [{ id: 'factory' }], filters: { file: 'test/', nodeTypes: null } });
  });

  it('13. query and several node types combine', async () => {
    harness = await createMcpHarness(api);
    const result = await search({ query: 'shared', nodeTypes: ['class', 'method'] });

    expect(harness.requests[0]?.query).toMatchObject({ nodeTypes: 'class,method' });
    expect(result.structuredContent).toMatchObject({ total: 4, filters: { nodeTypes: ['class', 'method'] } });
  });

  it('14. query and file combine: one file’s members only', async () => {
    harness = await createMcpHarness(api);
    const result = await search({ query: 'SharedLinkService', file: 'src/services/shared-link.service.ts' });

    expect((result.structuredContent as { results: Array<{ id: string }> }).results.map((node) => node.id)).toEqual(['service', 'get']);
  });

  it('pages with offset and reports where to continue', async () => {
    harness = await createMcpHarness(api);
    const first = await search({ query: 'shared', limit: 2 });
    const second = await search({ query: 'shared', limit: 2, offset: 2 });

    expect(first.structuredContent).toMatchObject({ total: 5, returned: 2, offset: 0, truncated: true, nextOffset: 2 });
    expect(textOf(first)).toMatch(/read on with offset 2/);
    expect(harness.requests[1]?.query).toMatchObject({ offset: '2' });
    expect(second.structuredContent).toMatchObject({ offset: 2, nextOffset: 4 });
    expect(textOf(second)).toMatch(/^3–4 of 5 nodes/);
  });

  it('does not send parameters that were not given', async () => {
    harness = await createMcpHarness(api);
    await search({ query: 'shared' });

    expect(Object.keys(harness.requests[0]?.query ?? {}).sort()).toEqual(['limit', 'q']);
  });
});

describe('invalid and empty', () => {
  it('15. rejects an unknown node type, an empty type list and an empty file without troubling the API', async () => {
    harness = await createMcpHarness(api);
    const unknownType = await search({ query: 'x', nodeTypes: ['klass'] });
    const noTypes = await search({ query: 'x', nodeTypes: [] });
    const blankFile = await search({ query: 'x', file: '   ' });
    const negative = await search({ query: 'x', offset: -1 });

    for (const result of [unknownType, noTypes, blankFile, negative]) expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('16. an empty filtered result says the filters applied and how file matches', async () => {
    harness = await createMcpHarness(api);
    const result = await search({ query: 'SharedLink', nodeTypes: ['table'] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 0, returned: 0, results: [] });
    expect(textOf(result)).toMatch(/No graph nodes matched "SharedLink" \(types table\)/);
    expect(textOf(result)).toMatch(/path prefix from the repository root/);
  });

  it('an offset past the end is reported as such, not as "no match"', async () => {
    harness = await createMcpHarness(api);
    const result = await search({ query: 'shared', offset: 10 });

    expect(textOf(result)).toMatch(/No matches at offset 10: .* has 5 match\(es\) in total/);
  });
});
