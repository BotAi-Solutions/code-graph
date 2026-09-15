import { describe, expect, it } from 'vitest';
import { toAnalysisJob, toCodeEdge, toCodeNode, toProject } from '@ckg/database';

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
      file_path: null,
      start_line: null,
      end_line: null,
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
      file_path: 'src/services/user.service.ts',
      start_line: 18,
      end_line: 25,
      metadata: { scipKind: 'method' },
    });

    expect(node).toMatchObject({
      filePath: 'src/services/user.service.ts',
      startLine: 18,
      endLine: 25,
      metadata: { scipKind: 'method' },
    });
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
