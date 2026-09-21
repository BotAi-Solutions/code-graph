import { afterEach, describe, expect, it } from 'vitest';
import {
  apiFailure,
  codeNode,
  createMcpHarness,
  nodeDetail,
  ok,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  relatedNode,
  textOf,
  toolNamed,
  type McpHarness,
} from './helpers/harness.js';

/**
 * Inspecting one node.
 *
 * Three properties carry most of the weight here: that the lookup is addressed
 * to one project and refuses anything that is not, that a very connected node
 * cannot empty its neighbourhood into a model's context, and that the evidence
 * behind each relationship survives — without it "A depends on B" is a claim
 * with nothing behind it.
 */

let harness: McpHarness;

afterEach(async () => {
  await harness.close();
});

const NODE_ID = 'node-1';

const get = async (args: { projectId?: string; nodeId?: string } = {}) =>
  harness.client.callTool({
    name: 'get_node',
    arguments: { projectId: PROJECT_ID, nodeId: NODE_ID, ...args },
  });

describe('registration', () => {
  it('requires both a project id and a node id', async () => {
    harness = await createMcpHarness();

    const tool = await toolNamed(harness, 'get_node');

    expect((tool.inputSchema as { required: string[] }).required.sort()).toEqual([
      'nodeId',
      'projectId',
    ]);
  });
});

describe('get_node', () => {
  it('addresses the canonical route with both ids in the path', async () => {
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail()) }));

    await get();

    expect(harness.requests).toEqual([
      {
        path: `/api/projects/${PROJECT_ID}/graph/nodes/${NODE_ID}`,
        // One more than it keeps, so "there are more" is a fact and not a guess.
        query: { limit: '21' },
      },
    ]);
  });

  it('returns the node’s identity and where it is defined', async () => {
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail()) }));

    const result = await get();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      projectId: PROJECT_ID,
      node: {
        id: NODE_ID,
        type: 'class',
        name: 'AuthService',
        filePath: 'src/modules/auth/services/auth.service.ts',
        startLine: 12,
        endLine: 88,
        language: 'typescript',
        exported: true,
        role: 'service',
        category: 'code',
      },
    });
    const text = textOf(result);
    expect(text).toContain('AuthService');
    expect(text).toContain('src/modules/auth/services/auth.service.ts:12');
  });

  it('surfaces the signature and doc comment the indexer recorded', async () => {
    // Both live on the node's metadata; `symbol` does not carry them, and they
    // are the two things a reader most wants before opening the file.
    harness = await createMcpHarness(() => ({
      body: ok(
        nodeDetail({
          node: codeNode({
            metadata: {
              signature: 'async login(email: string, password: string): Promise<Session>',
              documentation: ['Authenticates a user.', 'Throws when the password is wrong.'],
            },
          }),
        }),
      ),
    }));

    const result = await get();

    expect(result.structuredContent).toMatchObject({
      node: {
        signature: 'async login(email: string, password: string): Promise<Session>',
        documentation: ['Authenticates a user.', 'Throws when the password is wrong.'],
      },
    });
    expect(textOf(result)).toMatch(/Signature: async login/);
    expect(textOf(result)).toMatch(/Authenticates a user\./);
  });

  it('reports an empty signature and documentation rather than inventing them', async () => {
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail()) }));

    const result = await get();

    expect(result.structuredContent).toMatchObject({
      node: { signature: null, documentation: [] },
    });
  });

  it('says plainly when a node has no relationships at all', async () => {
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail()) }));

    const result = await get();

    expect(textOf(result)).toMatch(/No relationships recorded for this node/);
  });
});

describe('relationships', () => {
  it('returns callers, callees and references', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        nodeDetail({
          callers: [codeNode({ id: 'ctrl', name: 'AuthController', filePath: 'src/auth.controller.ts' })],
          callees: [
            codeNode({ id: 'repo', name: 'UserRepository' }),
            codeNode({ id: 'hash', name: 'hashPassword', type: 'function' }),
          ],
          references: [codeNode({ id: 'ref', name: 'Session', type: 'interface' })],
        }),
      ),
    }));

    const result = await get();
    const rel = (result.structuredContent as { relationships: Record<string, { returned: number; items: { name: string }[] }> })
      .relationships;

    expect(rel.callers?.returned).toBe(1);
    expect(rel.callees?.items.map((item) => item.name)).toEqual(['UserRepository', 'hashPassword']);
    expect(rel.references?.returned).toBe(1);

    const text = textOf(result);
    expect(text).toMatch(/callers: 1/);
    expect(text).toMatch(/callees: 2/);
    expect(text).toMatch(/Top callers:/);
    expect(text).toContain('AuthController');
  });

  it('returns the containment chain in both directions', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(
        nodeDetail({
          parent: codeNode({ id: 'file-1', type: 'file', name: 'auth.service.ts' }),
          children: [codeNode({ id: 'm1', type: 'method', name: 'login' })],
        }),
      ),
    }));

    const result = await get();

    expect(result.structuredContent).toMatchObject({
      parent: { id: 'file-1', type: 'file' },
      relationships: { children: { returned: 1 } },
    });
    expect(textOf(result)).toMatch(/Contained by: auth\.service\.ts \[file\]/);
  });

  it('keeps every section present even when empty, so a consumer need not branch', async () => {
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail()) }));

    const result = await get();
    const rel = (result.structuredContent as { relationships: Record<string, unknown> }).relationships;

    expect(Object.keys(rel).sort()).toEqual([
      'apis',
      'callees',
      'callers',
      'children',
      'contracts',
      'databases',
      'dependencies',
      'dependents',
      'documentation',
      'implementations',
      'references',
    ]);
  });
});

describe('evidence', () => {
  it('preserves the whole evidence record, not just the relationship name', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(nodeDetail({ databases: [relatedNode()] })),
    }));

    const result = await get();
    const [entry] = (
      result.structuredContent as {
        relationships: { databases: { items: { relationship: string; evidence: unknown }[] } };
      }
    ).relationships.databases.items;

    expect(entry).toMatchObject({
      relationship: 'WRITES_TO',
      direction: 'outgoing',
      evidence: {
        source: 'database-analyzer',
        confidence: 'high',
        method: 'ast',
        file: 'src/repositories/user.repository.ts',
        line: 42,
        column: 4,
        matched: 'users',
      },
    });
  });

  it('shows the evidence in the text, so "why are these connected" is answerable', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(nodeDetail({ databases: [relatedNode()] })),
    }));

    const result = await get();

    expect(textOf(result)).toMatch(/Architectural links, with the evidence for each/);
    expect(textOf(result)).toMatch(
      /WRITES_TO postgresql\.users — database-analyzer\/high, src\/repositories\/user\.repository\.ts:42/,
    );
  });

  it('reports a line without a file rather than claiming no location', async () => {
    // Real analyzers do this: the file is implied by the node being read, so
    // the edge carries only a line.
    harness = await createMcpHarness(() => ({
      body: ok(
        nodeDetail({
          databases: [
            relatedNode({
              evidence: {
                source: 'database-analyzer',
                confidence: 'medium',
                line: 38,
              },
            }),
          ],
        }),
      ),
    }));

    const result = await get();

    expect(textOf(result)).toMatch(/database-analyzer\/medium, line 38/);
    expect(textOf(result)).not.toMatch(/no location recorded/);
  });

  it('carries a null evidence record through rather than fabricating one', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(nodeDetail({ dependencies: [relatedNode({ evidence: null })] })),
    }));

    const result = await get();

    expect(result.structuredContent).toMatchObject({
      relationships: { dependencies: { items: [{ evidence: null }] } },
    });
  });
});

describe('bounding the relationships', () => {
  it('keeps at most twenty per section and says there are more', async () => {
    // The API is asked for 21 and answers with 21, which is how the tool knows
    // the section is not complete — the node-detail endpoint reports no totals.
    const many = Array.from({ length: 21 }, (_, index) =>
      codeNode({ id: `caller-${String(index)}`, name: `Caller${String(index)}` }),
    );
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail({ callers: many })) }));

    const result = await get();

    expect(result.structuredContent).toMatchObject({
      relationships: { callers: { returned: 20, hasMore: true } },
    });
    const items = (
      result.structuredContent as { relationships: { callers: { items: unknown[] } } }
    ).relationships.callers.items;
    expect(items).toHaveLength(20);
  });

  it('marks a section that fits as complete', async () => {
    const some = Array.from({ length: 3 }, (_, index) => codeNode({ id: `c-${String(index)}` }));
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail({ callers: some })) }));

    const result = await get();

    expect(result.structuredContent).toMatchObject({
      relationships: { callers: { returned: 3, hasMore: false } },
    });
    expect(textOf(result)).toMatch(/callers: 3(?!\+)/);
  });

  it('tells the reader the shown count is a floor when a section is truncated', async () => {
    const many = Array.from({ length: 21 }, (_, index) => codeNode({ id: `c-${String(index)}` }));
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail({ callers: many })) }));

    const result = await get();

    // The important part: a model must not read "20" as "there are twenty".
    expect(textOf(result)).toMatch(/callers: 20\+/);
    expect(textOf(result)).toMatch(/a "\+" means more than 20 exist; the number shown is a floor/);
  });

  it('bounds a related section the same way', async () => {
    const many = Array.from({ length: 21 }, (_, index) => relatedNode({ id: `d-${String(index)}` }));
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail({ dependencies: many })) }));

    const result = await get();

    expect(result.structuredContent).toMatchObject({
      relationships: { dependencies: { returned: 20, hasMore: true } },
    });
  });

  it('never prints more than a handful of neighbours in the text', async () => {
    const many = Array.from({ length: 21 }, (_, index) =>
      codeNode({ id: `c-${String(index)}`, name: `Caller${String(index)}` }),
    );
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail({ callers: many })) }));

    const result = await get();
    const printed = textOf(result)
      .split('\n')
      .filter((line) => line.trimStart().startsWith('- Caller'));

    expect(printed.length).toBeLessThanOrEqual(5);
  });
});

describe('project isolation', () => {
  it('looks the node up only in the project it was given', async () => {
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail()) }));

    await get({ projectId: OTHER_PROJECT_ID });

    expect(harness.requests[0]?.path).toBe(
      `/api/projects/${OTHER_PROJECT_ID}/graph/nodes/${NODE_ID}`,
    );
    expect(harness.requests[0]?.path).not.toContain(PROJECT_ID);
  });

  it('does not find a node that belongs to another project', async () => {
    // The API scopes by project_id, so a node id from project B reads as
    // missing in project A rather than being found.
    harness = await createMcpHarness((request) =>
      request.path.startsWith(`/api/projects/${PROJECT_ID}/`)
        ? { status: 404, body: apiFailure('NODE_NOT_FOUND', 'Graph node b-node was not found') }
        : { body: ok(nodeDetail({ node: codeNode({ id: 'b-node', projectId: OTHER_PROJECT_ID }) })) },
    );

    const inA = await get({ nodeId: 'b-node' });
    expect(inA.isError).toBe(true);
    expect(textOf(inA)).toMatch(/was not found in project/);
    expect(textOf(inA)).not.toContain(OTHER_PROJECT_ID);

    const inB = await get({ projectId: OTHER_PROJECT_ID, nodeId: 'b-node' });
    expect(inB.isError).toBeFalsy();
    expect(inB.structuredContent).toMatchObject({ projectId: OTHER_PROJECT_ID });
  });

  it('carries no project state between calls', async () => {
    harness = await createMcpHarness(() => ({ body: ok(nodeDetail()) }));

    await get({ projectId: PROJECT_ID });
    await get({ projectId: OTHER_PROJECT_ID });

    expect(harness.requests.map((request) => request.path)).toEqual([
      `/api/projects/${PROJECT_ID}/graph/nodes/${NODE_ID}`,
      `/api/projects/${OTHER_PROJECT_ID}/graph/nodes/${NODE_ID}`,
    ]);
  });

  it('refuses the whole response when the node belongs to another project', async () => {
    harness = await createMcpHarness(() => ({
      body: ok(nodeDetail({ node: codeNode({ projectId: OTHER_PROJECT_ID }) })),
    }));

    const result = await get();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Refusing to return this node/);
    expect(result.structuredContent).toBeUndefined();
  });

  it('refuses when a neighbour belongs to another project', async () => {
    // A backend invariant violation, not a filtering decision: the response is
    // rejected whole rather than quietly pruned.
    harness = await createMcpHarness(() => ({
      body: ok(nodeDetail({ callers: [codeNode({ id: 'leaked', projectId: OTHER_PROJECT_ID })] })),
    }));

    const result = await get();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Refusing to return this node/);
  });
});

describe('when the lookup fails', () => {
  it('reports a missing node without looking anywhere else', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('NODE_NOT_FOUND', 'Graph node node-1 was not found'),
    }));

    const result = await get();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Node "node-1" was not found in project/);
    // Exactly one request: no fallback lookup, no automatic search.
    expect(harness.requests).toHaveLength(1);
  });

  it('directs the agent to resolve_project for an unknown project', async () => {
    harness = await createMcpHarness(() => ({
      status: 404,
      body: apiFailure('PROJECT_NOT_FOUND', `Project ${PROJECT_ID} was not found`),
    }));

    const result = await get();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/There is no project with id/);
    expect(textOf(result)).toMatch(/Call resolve_project/);
  });

  it('passes another refusal through with the API’s code and nothing internal', async () => {
    harness = await createMcpHarness(() => ({
      status: 500,
      body: apiFailure('DATABASE_ERROR', 'the database rejected an operation'),
    }));

    const result = await get();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DATABASE_ERROR');
    expect(textOf(result)).not.toMatch(/at .+:\d+:\d+|postgres(ql)?:\/\/|SELECT /i);
  });

  it('says where the API was expected when it is not running', async () => {
    harness = await createMcpHarness();
    await harness.stopApi();

    const result = await get();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/could not be reached/);
  });

  it('rejects a project id that is not a uuid without troubling the API', async () => {
    harness = await createMcpHarness();

    const result = await get({ projectId: 'not-a-uuid' });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });

  it('rejects an empty node id without troubling the API', async () => {
    harness = await createMcpHarness();

    const result = await get({ nodeId: '   ' });

    expect(result.isError).toBe(true);
    expect(harness.requests).toEqual([]);
  });
});
