import { describe, expect, it } from 'vitest';
import {
  CODE_NODE_COLUMNS,
  toAnalysisJob,
  toCodeEdge,
  toCodeNode,
  toProject,
  toRelatedNode,
} from '@ckg/database';

/**
 * Rows are snake_case with `Date` timestamps; the domain model is camelCase
 * with ISO strings and no null-valued optionals. These mappers are the only
 * place that conversion happens, so they carry their own tests.
 */
describe('row mappers', () => {
  const createdAt = new Date('2026-01-02T03:04:05.000Z');

  it('converts timestamps to ISO strings', () => {
    const project = toProject({
      id: 'p1',
      name: 'demo',
      description: null,
      created_at: createdAt,
      updated_at: createdAt,
    });

    expect(project).toEqual({
      id: 'p1',
      name: 'demo',
      description: null,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('keeps nullable analysis timestamps null rather than inventing a date', () => {
    const job = toAnalysisJob({
      id: 'j1',
      project_id: 'p1',
      repository_id: 'r1',
      status: 'QUEUED',
      language: null,
      started_at: null,
      completed_at: null,
      error: null,
      stats: null,
      created_at: createdAt,
      updated_at: createdAt,
    });

    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.language).toBeNull();
    expect(job.status).toBe('QUEUED');
  });

  it('omits optional node fields instead of emitting nulls', () => {
    const node = toCodeNode({
      id: 'n1',
      project_id: 'p1',
      node_type: 'class',
      name: 'UserService',
      qualified_name: null,
      file_path: null,
      start_line: null,
      start_character: null,
      end_line: null,
      end_character: null,
      metadata: {},
    });

    expect(node).toEqual({ id: 'n1', projectId: 'p1', type: 'class', name: 'UserService' });
    expect('filePath' in node).toBe(false);
    expect('metadata' in node).toBe(false);
  });

  it('carries through the fields that are present', () => {
    const node = toCodeNode({
      id: 'n2',
      project_id: 'p1',
      node_type: 'method',
      name: 'getUser',
      qualified_name: 'UserService.getUser',
      file_path: 'src/services/user.service.ts',
      start_line: 18,
      start_character: 2,
      end_line: 25,
      end_character: 3,
      metadata: { scipKind: 'method' },
    });

    expect(node).toMatchObject({
      qualifiedName: 'UserService.getUser',
      filePath: 'src/services/user.service.ts',
      startLine: 18,
      startCharacter: 2,
      endLine: 25,
      endCharacter: 3,
      metadata: { scipKind: 'method' },
    });
  });

  it('maps an architectural node the analyzers produced', () => {
    const table = toCodeNode({
      id: 'n3',
      project_id: 'p1',
      node_type: 'table',
      name: 'users',
      qualified_name: 'postgresql.users',
      // A table belongs to no file, and that is not a missing value.
      file_path: null,
      start_line: null,
      start_character: null,
      end_line: null,
      end_character: null,
      metadata: { provider: 'postgresql' },
    });

    expect(table).toEqual({
      id: 'n3',
      projectId: 'p1',
      type: 'table',
      name: 'users',
      qualifiedName: 'postgresql.users',
      metadata: { provider: 'postgresql' },
    });
  });

  it('carries the relationship and its evidence on a related node', () => {
    const related = toRelatedNode({
      id: 'n4',
      project_id: 'p1',
      node_type: 'table',
      name: 'users',
      qualified_name: 'postgresql.users',
      file_path: null,
      start_line: null,
      start_character: null,
      end_line: null,
      end_character: null,
      metadata: {},
      relationship: 'WRITES_TO',
      direction: 'outgoing',
      edge_metadata: { source: 'database-analyzer', confidence: 'high', statement: 'INSERT' },
    });

    expect(related).toMatchObject({
      type: 'table',
      relationship: 'WRITES_TO',
      direction: 'outgoing',
      confidence: 'high',
      evidenceSource: 'database-analyzer',
    });
  });

  it('leaves confidence off a related node whose edge carries none', () => {
    const related = toRelatedNode({
      id: 'n5',
      project_id: 'p1',
      node_type: 'class',
      name: 'UserService',
      qualified_name: null,
      file_path: null,
      start_line: null,
      start_character: null,
      end_line: null,
      end_character: null,
      metadata: null,
      relationship: 'CALLS',
      direction: 'incoming',
      edge_metadata: null,
    });

    expect('confidence' in related).toBe(false);
    expect(related.direction).toBe('incoming');
  });

  it('selects every column the node mapper reads', () => {
    for (const column of [
      'id',
      'project_id',
      'node_type',
      'name',
      'qualified_name',
      'file_path',
      'start_line',
      'start_character',
      'end_line',
      'end_character',
      'metadata',
    ]) {
      expect(CODE_NODE_COLUMNS.split(', ')).toContain(column);
    }
  });

  it('maps edges and drops empty metadata', () => {
    expect(
      toCodeEdge({
        id: 'e1',
        project_id: 'p1',
        source_node_id: 'n1',
        target_node_id: 'n2',
        relationship: 'CALLS',
        metadata: {},
      }),
    ).toEqual({
      id: 'e1',
      projectId: 'p1',
      sourceNodeId: 'n1',
      targetNodeId: 'n2',
      relationship: 'CALLS',
    });
  });
});
