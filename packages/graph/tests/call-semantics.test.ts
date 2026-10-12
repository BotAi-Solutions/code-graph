import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import { ScipGraphBuilder } from '@ckg/graph';
import type { CodeNode, CodeRelationship, GraphBuildResult } from '@ckg/graph';

/**
 * Invocations, value uses and imports, on `test-repositories/call-semantics-sample`.
 *
 * Three different things share one SCIP role, because scip-typescript records
 * an identifier the same way wherever it appears: `format(1)` calls format,
 * `register(format)` passes it, and `import { format }` binds it. The graph
 * must keep them apart. The full expectations for this fixture are in the
 * benchmark's ground truth; these tests pin the rules down where a regression
 * would land.
 */

const FIXTURE = fileURLToPath(
  new URL('../../scip/tests/fixtures/call-semantics-sample.scip', import.meta.url),
);
const SAMPLE_REPOSITORY = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/call-semantics-sample', import.meta.url)),
);

const IDENTITY = {
  projectId: '11111111-1111-4111-8111-111111111111',
  repositoryId: '22222222-2222-4222-8222-222222222222',
};

describe('call semantics', () => {
  let graph: GraphBuildResult;

  beforeAll(async () => {
    const index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), {
      repositoryPath: SAMPLE_REPOSITORY,
    });
    graph = new ScipGraphBuilder({
      identity: IDENTITY,
      repositoryName: 'call-semantics-sample',
    }).build(index);
  });

  const node = (name: string): CodeNode => {
    const matches = graph.nodes.filter((candidate) => (candidate.qualifiedName ?? candidate.name) === name);
    if (matches.length !== 1) throw new Error(`${String(matches.length)} nodes named ${name}`);
    return matches[0] as CodeNode;
  };

  const relationships = (from: string, to: string): CodeRelationship[] => {
    const source = node(from);
    const target = node(to);
    return graph.edges
      .filter((edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id)
      .map((edge) => edge.relationship)
      .sort();
  };

  describe('invocations are CALLS', () => {
    it('a direct call', () => {
      expect(relationships('invokes', 'format')).toEqual(['CALLS']);
    });

    it('a call through a namespace import', () => {
      expect(relationships('callsThroughNamespace', 'format')).toEqual(['CALLS']);
    });

    it('a call at module level, attributed to the file', () => {
      expect(relationships('src/index.ts', 'invokes')).toEqual(['CALLS']);
    });

    it('a constructor call through new', () => {
      expect(relationships('buildsSquare', 'Square.<constructor>')).toEqual(['CALLS']);
    });
  });

  describe('import and export specifiers are neither calls nor references', () => {
    it('an imported function the file only calls elsewhere adds no edge from the file', () => {
      // registry.ts imports format; only its functions call it.
      expect(relationships('src/registry.ts', 'format')).toEqual([]);
      expect(relationships('src/registry.ts', 'Square')).toEqual([]);
    });

    it('a re-export adds no edge to what it forwards', () => {
      expect(relationships('src/index.ts', 'format')).toEqual([]);
    });

    it('a type-only import adds no edge to the type', () => {
      expect(relationships('src/geometry.ts', 'NamedShape')).toEqual([]);
    });

    it('still makes the importing file depend on the imported one', () => {
      expect(relationships('src/registry.ts', 'src/geometry.ts')).toEqual(['IMPORTS']);
      expect(relationships('src/index.ts', 'src/geometry.ts')).toEqual(['IMPORTS']);
      expect(relationships('src/geometry.ts', 'src/contracts.ts')).toEqual(['IMPORTS']);
    });
  });

  describe('value uses', () => {
    it('using a class as a value is a reference', () => {
      expect(relationships('callsStatic', 'Square')).toEqual(['REFERENCES']);
    });

    // Known defect, recorded in the benchmark ground truth: every reference to
    // a declared function or method is a CALLS edge, whatever the syntax. When
    // this starts passing, remove `.fails` and the knownFalsePositives entries
    // in packages/benchmark/ground-truth/call-semantics-sample/edges.json.
    it.fails('passing a declared function as an argument is a reference, not a call', () => {
      expect(relationships('passesAsValue', 'format')).toEqual(['REFERENCES']);
    });

    it.fails('assigning a declared function at module level is a reference, not a call', () => {
      expect(relationships('src/index.ts', 'register')).toEqual(['REFERENCES']);
    });
  });
});
