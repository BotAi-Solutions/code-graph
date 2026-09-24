import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import { ScipGraphBuilder, createNodeId, neighbours } from '@ckg/graph';
import type { CodeEdge, CodeNode, CodeRelationship, GraphBuildResult } from '@ckg/graph';

/**
 * Function-valued variables in the graph: `const f = () => {}` is a `function`
 * node, calls to it are CALLS with a call-site location, and using it as a
 * value is still REFERENCES.
 *
 * `test-repositories/function-values-sample` holds one case per rule, plus the
 * shapes of Immich's `src/utils/access.ts` and `AssetMediaService.uploadAsset`,
 * which are where the gap was found.
 */

const FIXTURE = fileURLToPath(
  new URL('../../scip/tests/fixtures/function-values-sample.scip', import.meta.url),
);
const SAMPLE_REPOSITORY = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/function-values-sample', import.meta.url)),
);

const IDENTITY = {
  projectId: '11111111-1111-4111-8111-111111111111',
  repositoryId: '22222222-2222-4222-8222-222222222222',
};

describe('function-valued variables', () => {
  let graph: GraphBuildResult;

  beforeAll(async () => {
    const index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), {
      repositoryPath: SAMPLE_REPOSITORY,
    });
    graph = new ScipGraphBuilder({
      identity: IDENTITY,
      repositoryName: 'function-values-sample',
    }).build(index);
  });

  /** The one top-level node with this name, or a failure naming the problem. */
  const node = (name: string, file?: string): CodeNode => {
    const matches = graph.nodes.filter(
      (candidate) =>
        (candidate.qualifiedName ?? candidate.name) === name &&
        (file === undefined || candidate.filePath === `src/${file}`),
    );
    if (matches.length !== 1) throw new Error(`${String(matches.length)} nodes named ${name}`);
    return matches[0] as CodeNode;
  };

  const edgesBetween = (from: string, to: string): CodeEdge[] => {
    const source = node(from);
    const target = node(to);
    return graph.edges.filter(
      (edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id,
    );
  };

  const relationships = (from: string, to: string): CodeRelationship[] =>
    edgesBetween(from, to)
      .map((edge) => edge.relationship)
      .sort();

  describe('classification', () => {
    it('makes an arrow helper one function node, never a variable and a function', () => {
      const helper = node('formatName');

      expect(helper.type).toBe('function');
      expect(helper.metadata?.functionValue).toBe('arrow-function');
      expect(graph.nodes.filter((candidate) => candidate.name === 'formatName')).toHaveLength(1);
    });

    it('covers async arrows, arrows with parameters, generics and function expressions', () => {
      expect(node('loadUser').type).toBe('function');
      expect(node('double').type).toBe('function');
      expect(node('combine').type).toBe('function');
      expect(node('identity').type).toBe('function');
      expect(node('wrapped').type).toBe('function');
      expect(node('legacyFormat')).toMatchObject({
        type: 'function',
        metadata: expect.objectContaining({ functionValue: 'function-expression' }),
      });
      expect(node('legacyLoad').type).toBe('function');
    });

    it('leaves non-callable values as variables', () => {
      for (const name of ['settings', 'names', 'limit', 'label', 'formatters', 'mutable']) {
        expect(node(name, 'helpers.ts').type).toBe('variable');
        expect(node(name, 'helpers.ts').metadata?.functionValue).toBeUndefined();
      }
      expect(node('mimeTypes').type).toBe('variable');
    });

    it('keeps the id the node had as a variable', () => {
      const helper = node('formatName');

      expect(helper.id).toBe(
        createNodeId(IDENTITY, {
          type: 'variable',
          filePath: 'src/helpers.ts',
          symbolKey: String(helper.metadata?.scipSymbol),
        }),
      );
    });

    it('does not change declared functions', () => {
      const declared = node('callsArrow');

      expect(declared.type).toBe('function');
      expect(declared.metadata?.functionValue).toBeUndefined();
      expect(declared.id).toBe(
        createNodeId(IDENTITY, {
          type: 'function',
          filePath: 'src/callers.ts',
          symbolKey: String(declared.metadata?.scipSymbol),
        }),
      );
    });

    it('lists the Immich-style access helpers as functions', () => {
      const functions = graph.nodes
        .filter((candidate) => candidate.filePath === 'src/access.ts' && candidate.type === 'function')
        .map((candidate) => candidate.name)
        .sort();

      expect(functions).toEqual(['checkAccess', 'isGranted', 'requireAccess', 'requireUploadAccess']);
    });
  });

  describe('calls', () => {
    it('records a call of an arrow helper as CALLS', () => {
      expect(relationships('callsArrow', 'formatName')).toEqual(['CALLS']);
    });

    it('records an awaited call of an async arrow', () => {
      expect(relationships('awaitsAsyncArrow', 'loadUser')).toEqual(['CALLS']);
    });

    it('records calls of function expressions, sync and async', () => {
      expect(relationships('callsFunctionExpression', 'legacyFormat')).toEqual(['CALLS']);
      expect(relationships('awaitsAsyncFunctionExpression', 'legacyLoad')).toEqual(['CALLS']);
    });

    it('records returned, generic, parenthesised, optional and namespaced calls', () => {
      expect(relationships('returnsCall', 'double')).toEqual(['CALLS']);
      expect(relationships('callsGeneric', 'identity')).toEqual(['CALLS']);
      expect(relationships('callsParenthesized', 'wrapped')).toEqual(['CALLS']);
      expect(relationships('callsOptionally', 'combine')).toEqual(['CALLS']);
      expect(relationships('callsThroughNamespace', 'double')).toEqual(['CALLS']);
    });

    it('attributes a call to the declared function around it, past a local', () => {
      expect(relationships('callsLocal', 'double')).toEqual(['CALLS']);
      expect(graph.nodes.some((candidate) => candidate.name === 'inner')).toBe(false);
    });

    it('records calls between arrow helpers', () => {
      expect(relationships('requireAccess', 'checkAccess')).toEqual(['CALLS']);
      expect(relationships('checkAccess', 'isGranted')).toEqual(['CALLS']);
    });

    it('locates the call at the call expression', () => {
      const [call] = edgesBetween('callsArrow', 'formatName');

      // `  formatName();` is line 20 of src/callers.ts, the name at character 2.
      expect(call?.metadata).toMatchObject({
        source: 'scip',
        confidence: 'high',
        file: 'src/callers.ts',
        line: 20,
        column: 2,
      });
    });

    it('keeps calls of declared functions and methods exactly as before', () => {
      const methodCall = graph.edges.find(
        (edge) =>
          edge.sourceNodeId === node('UploadService.uploadAsset').id &&
          edge.targetNodeId === node('AssetStore.create').id,
      );

      expect(methodCall?.relationship).toBe('CALLS');
      expect(methodCall?.metadata?.line).toBeUndefined();
      // Passing a declared function as a value was, and is, a CALLS edge.
      expect(relationships('registersCallback', 'register')).toEqual(['CALLS']);
    });
  });

  describe('value uses', () => {
    it('keeps an alias of a helper as REFERENCES', () => {
      expect(relationships('src/callers.ts', 'formatName')).toEqual(['REFERENCES']);
    });

    it('keeps a helper passed as a callback as REFERENCES', () => {
      expect(relationships('registersCallback', 'combine')).toEqual(['REFERENCES']);
    });

    it('keeps a returned or bound helper as REFERENCES', () => {
      expect(relationships('returnsHelper', 'legacyFormat')).toEqual(['REFERENCES']);
      expect(relationships('bindsHelper', 'double')).toEqual(['REFERENCES']);
    });

    it('records both when a helper is called and also used as a value', () => {
      expect(relationships('callsAndPasses', 'formatName')).toEqual(['CALLS', 'REFERENCES']);
    });

    it('never records a call of a non-callable variable', () => {
      expect(relationships('readsObject', 'settings')).toEqual(['REFERENCES']);
      expect(relationships('readsPrimitive', 'label')).toEqual(['REFERENCES']);
      expect(relationships('callsObjectMember', 'formatters')).toEqual(['REFERENCES']);
      expect(relationships('callsMutable', 'mutable')).toEqual(['REFERENCES']);
    });
  });

  describe('the asset-upload shape', () => {
    it('lists the arrow helpers among the method callees', () => {
      const uploadAsset = node('UploadService.uploadAsset');
      const callees = neighbours(graph, uploadAsset.id, 'outgoing', ['CALLS']).map(
        (callee) => callee.qualifiedName ?? callee.name,
      );

      expect(callees).toEqual(['AssetStore.create', 'isChecksumConstraint', 'onBeforeLink', 'requireUploadAccess']);
    });

    it('keeps an object of functions a reference, since it is not itself called', () => {
      expect(relationships('UploadService.uploadAsset', 'mimeTypes')).toEqual(['REFERENCES']);
    });
  });
});
