import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CodeGraph, CodeNode, NodeDetail, Project } from '@ckg/shared';
import { ScipGraphBuilder } from '@ckg/graph';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import { body, createHarness, type Harness } from './helpers/harness.js';

/**
 * Arrow-function helpers through the API routes the MCP `get_node` tool reads.
 *
 * The real-LLM validation found `AssetMediaService.uploadAsset` reporting 14
 * callees with nothing more to page, while the helpers it calls were missing:
 * they were declared `const f = () => {}` and stored as REFERENCES. This builds
 * the `function-values-sample` graph, which has the same shape, and asks the
 * API for the method's callees exactly as the tool does.
 */

const FIXTURE = fileURLToPath(
  new URL('../../../packages/scip/tests/fixtures/function-values-sample.scip', import.meta.url),
);
const SAMPLE_REPOSITORY = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/function-values-sample', import.meta.url)),
);

let harness: Harness;
let projectId: string;
let graph: CodeGraph;

beforeEach(async () => {
  harness = await createHarness();
  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'function-values' },
  });
  projectId = (body<Project>(created).data as Project).id;

  const index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), {
    repositoryPath: SAMPLE_REPOSITORY,
  });
  const built = new ScipGraphBuilder({
    identity: { projectId, repositoryId: '22222222-2222-4222-8222-222222222222' },
    repositoryName: 'function-values-sample',
  }).build(index);
  graph = { nodes: built.nodes, edges: built.edges };
  harness.graph.setGraph(graph);
});

async function get<T>(route: string) {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}${route}`,
  });
  return body<T>(response);
}

const idOf = (qualifiedName: string): string => {
  const found = graph.nodes.find((node) => (node.qualifiedName ?? node.name) === qualifiedName);
  if (!found) throw new Error(`no node ${qualifiedName}`);
  return found.id;
};

describe('callees of a method that calls arrow-function helpers', () => {
  it('lists every helper, and reports the list as complete only when it is', async () => {
    const envelope = await get<CodeNode[]>(
      `/graph/nodes/${idOf('UploadService.uploadAsset')}/callees?limit=50`,
    );

    const names = (envelope.data ?? []).map((node) => node.qualifiedName ?? node.name).sort();
    expect(names).toEqual([
      'AssetStore.create',
      'isChecksumConstraint',
      'onBeforeLink',
      'requireUploadAccess',
    ]);
    expect(envelope.meta).toMatchObject({ total: 4, nextOffset: null });
  });

  it('counts the helpers in the node overview totals', async () => {
    const envelope = await get<NodeDetail>(`/graph/nodes/${idOf('UploadService.uploadAsset')}`);

    expect(envelope.data?.totals?.callees).toBe(4);
  });

  it('shows the callers of a helper, and not the code that only passes it around', async () => {
    const envelope = await get<CodeNode[]>(`/graph/nodes/${idOf('formatName')}/callers?limit=50`);

    const names = (envelope.data ?? []).map((node) => node.qualifiedName ?? node.name).sort();
    expect(names).toEqual(['callsAndPasses', 'callsArrow']);
  });

  it('finds the access helpers with a function-type search', async () => {
    // The query the validation run made against Immich, which returned nothing.
    const envelope = await get<CodeNode[]>(
      '/graph/search?q=access&nodeTypes=function&file=src/access.ts&limit=50',
    );

    const names = (envelope.data ?? []).map((node) => node.name).sort();
    expect(names).toEqual(['checkAccess', 'isGranted', 'requireAccess', 'requireUploadAccess']);
  });
});
