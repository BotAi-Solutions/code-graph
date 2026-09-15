import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import type { ScipIndex } from '@ckg/scip';
import { ScipGraphBuilder, createNodeId, serializeGraph } from '@ckg/graph';
import type { CodeNode, CodeRelationship, GraphBuildResult } from '@ckg/graph';

const FIXTURE = fileURLToPath(
  new URL('../../scip/tests/fixtures/typescript-sample.scip', import.meta.url),
);
const SAMPLE_REPOSITORY = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/typescript-sample', import.meta.url)),
);

const IDENTITY = {
  projectId: '11111111-1111-4111-8111-111111111111',
  repositoryId: '22222222-2222-4222-8222-222222222222',
};

describe('ScipGraphBuilder', () => {
  let index: ScipIndex;
  let graph: GraphBuildResult;

  beforeAll(async () => {
    index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), {
      repositoryPath: SAMPLE_REPOSITORY,
    });
    graph = new ScipGraphBuilder({ identity: IDENTITY, repositoryName: 'typescript-sample' }).build(
      index,
    );
  });

  const find = (name: string, type?: string): CodeNode | undefined =>
    graph.nodes.find((node) => node.name === name && (type === undefined || node.type === type));

  const hasEdge = (from: string, relationship: CodeRelationship, to: string): boolean => {
    const source = find(from);
    const target = find(to);
    if (!source || !target) return false;
    return graph.edges.some(
      (edge) =>
        edge.sourceNodeId === source.id &&
        edge.targetNodeId === target.id &&
        edge.relationship === relationship,
    );
  };

  describe('symbols to nodes', () => {
    it('creates a repository root and the directory/file tree beneath it', () => {
      expect(graph.nodes.filter((node) => node.type === 'repository')).toHaveLength(1);
      expect(find('typescript-sample', 'repository')).toBeDefined();
      expect(find('src', 'directory')).toBeDefined();
      expect(find('services', 'directory')).toBeDefined();
      expect(find('user.service.ts', 'file')?.filePath).toBe('src/services/user.service.ts');
    });

    it('maps symbol kinds onto graph node types', () => {
      expect(find('UserService')?.type).toBe('class');
      expect(find('User')?.type).toBe('interface');
      expect(find('UserRole')?.type).toBe('type');
      expect(find('isAdmin')?.type).toBe('function');
      expect(find('getUser')?.type).toBe('method');
    });

    it('records file path and one-based line numbers', () => {
      const userService = find('UserService');

      expect(userService?.filePath).toBe('src/services/user.service.ts');
      // `export class UserService` is on line 13 of the source file.
      expect(userService?.startLine).toBe(13);
      expect(userService?.endLine).toBeGreaterThan(userService?.startLine ?? 0);
    });

    it('keeps the originating SCIP symbol in metadata for traceability', () => {
      expect(find('UserService')?.metadata?.scipSymbol).toContain('UserService#');
      expect(find('UserService')?.metadata?.language).toBe('typescript');
    });

    it('excludes parameters, type parameters and locals', () => {
      const names = graph.nodes.map((node) => node.name);

      expect(names).not.toContain('draft');
      expect(names).not.toContain('T');
      expect(names.every((name) => !/^\d+$/.test(name))).toBe(true);
    });
  });

  describe('references to edges', () => {
    it('contains files in directories and members in classes', () => {
      expect(hasEdge('src', 'CONTAINS', 'services')).toBe(true);
      expect(hasEdge('services', 'CONTAINS', 'user.service.ts')).toBe(true);
      expect(hasEdge('user.service.ts', 'CONTAINS', 'UserService')).toBe(true);
      expect(hasEdge('UserService', 'CONTAINS', 'getUser')).toBe(true);
    });

    it('creates CALLS edges from the enclosing definition to the callee', () => {
      // `UserService.getUser` calls `this.repository.findById(id)`; the call is
      // attributed to the method it sits inside, not to the file.
      const callers = graph.nodes.filter(
        (node) =>
          node.name === 'getUser' &&
          node.type === 'method' &&
          node.filePath === 'src/services/user.service.ts',
      );
      expect(callers).toHaveLength(1);

      const callees = graph.nodes.filter(
        (node) =>
          node.name === 'findById' &&
          node.type === 'method' &&
          node.filePath === 'src/repositories/user.repository.ts',
      );
      // The interface declares findById and the class implements it.
      expect(callees.length).toBeGreaterThanOrEqual(1);

      const calls = graph.edges.filter(
        (edge) =>
          edge.sourceNodeId === callers[0]?.id &&
          edge.relationship === 'CALLS' &&
          callees.some((callee) => callee.id === edge.targetNodeId),
      );

      expect(calls.length).toBeGreaterThan(0);
    });

    it('creates REFERENCES edges for non-callable targets', () => {
      expect(hasEdge('UserRepository', 'REFERENCES', 'User')).toBe(true);
    });

    it('creates IMPORTS edges between files that depend on each other', () => {
      expect(hasEdge('user.service.ts', 'IMPORTS', 'user.repository.ts')).toBe(true);
      expect(hasEdge('user.controller.ts', 'IMPORTS', 'user.service.ts')).toBe(true);
    });

    it('distinguishes EXTENDS from IMPLEMENTS by what is inherited', () => {
      expect(hasEdge('UserController', 'EXTENDS', 'BaseController')).toBe(true);
      expect(hasEdge('UserRepository', 'IMPLEMENTS', 'UserStore')).toBe(true);
    });

    it('lifts member-level edges to the classes that own them', () => {
      expect(hasEdge('UserController', 'CALLS', 'UserService')).toBe(true);
      expect(hasEdge('UserService', 'CALLS', 'UserRepository')).toBe(true);
    });

    it('can be told not to derive container-level edges', () => {
      const literal = new ScipGraphBuilder({
        identity: IDENTITY,
        repositoryName: 'typescript-sample',
        deriveContainerEdges: false,
      }).build(index);

      expect(literal.edges.some((edge) => edge.metadata?.derived === true)).toBe(false);
      expect(literal.edges.length).toBeLessThan(graph.edges.length);
    });

    it('counts repeated occurrences on one edge rather than duplicating it', () => {
      const ids = graph.edges.map((edge) => edge.id);
      expect(new Set(ids).size).toBe(ids.length);

      const repeated = graph.edges.filter(
        (edge) => Number(edge.metadata?.occurrences ?? 0) > 1,
      );
      expect(repeated.length).toBeGreaterThan(0);
    });

    it('drops references to symbols defined outside the repository', () => {
      // `UserNotFoundError extends Error` points at lib.es5.d.ts.
      expect(graph.nodes.some((node) => node.name === 'Error')).toBe(false);
      expect(graph.stats.unresolvedReferenceCount).toBeGreaterThan(0);
    });

    it('never emits an edge whose endpoints are not both nodes', () => {
      const ids = new Set(graph.nodes.map((node) => node.id));
      for (const edge of graph.edges) {
        expect(ids.has(edge.sourceNodeId)).toBe(true);
        expect(ids.has(edge.targetNodeId)).toBe(true);
      }
    });
  });

  describe('determinism', () => {
    it('produces identical output for identical input', () => {
      const builder = new ScipGraphBuilder({
        identity: IDENTITY,
        repositoryName: 'typescript-sample',
      });

      expect(serializeGraph(builder.build(index))).toBe(serializeGraph(builder.build(index)));
    });

    it('derives node ids from content, not from run order', () => {
      const expected = createNodeId(IDENTITY, {
        type: 'file',
        filePath: 'src/services/user.service.ts',
        symbolKey: 'src/services/user.service.ts',
      });

      expect(find('user.service.ts', 'file')?.id).toBe(expected);
    });

    it('scopes ids to the project and repository', () => {
      const other = new ScipGraphBuilder({
        identity: { projectId: IDENTITY.projectId, repositoryId: 'different-repository' },
        repositoryName: 'typescript-sample',
      }).build(index);

      const here = new Set(graph.nodes.map((node) => node.id));
      expect(other.nodes.some((node) => here.has(node.id))).toBe(false);
    });

    it('sorts nodes and edges by id', () => {
      const nodeIds = graph.nodes.map((node) => node.id);
      const edgeIds = graph.edges.map((edge) => edge.id);

      expect(nodeIds).toEqual([...nodeIds].sort((a, b) => a.localeCompare(b)));
      expect(edgeIds).toEqual([...edgeIds].sort((a, b) => a.localeCompare(b)));
    });
  });

  it('reports build statistics that match the emitted graph', () => {
    expect(graph.stats.documentCount).toBe(6);
    expect(graph.stats.nodeCount).toBe(graph.nodes.length);
    expect(graph.stats.edgeCount).toBe(graph.edges.length);
    expect(graph.stats.symbolCount).toBeGreaterThan(0);
  });
});
