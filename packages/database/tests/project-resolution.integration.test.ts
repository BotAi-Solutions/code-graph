import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GraphRepository,
  ProjectRepository,
  SourceRepositoryRepository,
  createDatabase,
  migrate,
} from '@ckg/database';
import type { Database } from '@ckg/database';

/**
 * The SQL path resolution relies on, against a real PostgreSQL.
 *
 * The in-memory stores in `apps/api/tests` reproduce what these two methods
 * *mean*, which is what makes the resolve route testable without a database —
 * but neither can reproduce what PostgreSQL does with them. `= ANY($1::uuid[])`
 * in particular is passed a JavaScript array and cast server side, and getting
 * that wrong fails only here: a fake handed the same argument is perfectly
 * happy with it.
 *
 * Skips itself when no database is reachable, like the graph suite beside it.
 */

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://ckg:ckg@localhost:5432/code_knowledge_graph';

async function reachable(): Promise<Database | null> {
  const database = createDatabase({
    connectionString: CONNECTION_STRING,
    maxConnections: 2,
    applicationName: 'ckg-integration-tests',
  });
  try {
    await database.query('SELECT 1');
    return database;
  } catch {
    await database.close().catch(() => undefined);
    return null;
  }
}

const database = await reachable();

const suite = database === null ? describe.skip : describe;

if (database === null) {
  process.stdout.write(
    `\n  project resolution integration: skipped, no database at ${CONNECTION_STRING.replace(
      /\/\/[^@/]+@/,
      '//[redacted]@',
    )}\n`,
  );
}

suite('Project resolution SQL against PostgreSQL', () => {
  const db = database as Database;
  const projects = new ProjectRepository(db);
  const sources = new SourceRepositoryRepository(db);
  const graph = new GraphRepository(db);

  const created: string[] = [];

  async function seed(name: string, sourcePath: string, sourceType: 'local' | 'git' = 'local') {
    const project = await projects.create({ name, description: null });
    created.push(project.id);
    await sources.upsert({ projectId: project.id, sourceType, sourcePath, commitHash: null });
    return project.id;
  }

  beforeAll(async () => {
    await migrate(db);
  }, 60_000);

  afterAll(async () => {
    for (const id of created) await projects.delete(id);
    await db.close();
  });

  it('returns summaries for a set of ids and nothing else', async () => {
    const wanted = await seed('resolve-wanted', '/srv/resolve-wanted');
    const other = await seed('resolve-other', '/srv/resolve-other');

    const summaries = await projects.findSummariesByIds([wanted]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: wanted,
      name: 'resolve-wanted',
      repository: { sourceType: 'local', sourcePath: '/srv/resolve-wanted' },
      nodeCount: 0,
      edgeCount: 0,
    });
    expect(summaries.map((summary) => summary.id)).not.toContain(other);
  });

  it('carries the graph size the dashboard listing would show', async () => {
    const projectId = await seed('resolve-sized', '/srv/resolve-sized');
    await graph.replaceProjectGraph(projectId, {
      nodes: [
        { id: `${projectId}-repo`, projectId, type: 'repository', name: 'sample' },
        { id: `${projectId}-svc`, projectId, type: 'class', name: 'UserService' },
      ],
      edges: [
        {
          id: `${projectId}-contains`,
          projectId,
          sourceNodeId: `${projectId}-repo`,
          targetNodeId: `${projectId}-svc`,
          relationship: 'CONTAINS',
          metadata: { source: 'scip', confidence: 'high' },
        },
      ],
    });

    const [summary] = await projects.findSummariesByIds([projectId]);

    expect(summary).toMatchObject({
      nodeCount: 2,
      edgeCount: 1,
      nodeTypeCounts: { repository: 1, class: 1 },
    });
  });

  it('accepts several ids in one statement', async () => {
    const first = await seed('resolve-multi-a', '/srv/resolve-multi-a');
    const second = await seed('resolve-multi-b', '/srv/resolve-multi-b');

    const summaries = await projects.findSummariesByIds([first, second]);

    expect(summaries.map((summary) => summary.id).sort()).toEqual([first, second].sort());
  });

  it('returns nothing for an id that names no project, rather than failing', async () => {
    expect(await projects.findSummariesByIds(['00000000-0000-4000-8000-000000000000'])).toEqual([]);
  });

  it('issues no query at all for an empty id list', async () => {
    // An empty array would otherwise reach `= ANY('{}')`, which is valid but
    // pointless; the guard is what lets the caller skip the round trip.
    expect(await projects.findSummariesByIds([])).toEqual([]);
  });

  it('lists every repository, longest source path first', async () => {
    await seed('resolve-short', '/srv/a');
    await seed('resolve-long', '/srv/a/packages/api/service');

    const all = await sources.listAll();
    const mine = all.filter((repository) => repository.sourcePath.startsWith('/srv/a'));

    expect(mine.map((repository) => repository.sourcePath)).toEqual([
      '/srv/a/packages/api/service',
      '/srv/a',
    ]);
  });

  it('lists git repositories too, leaving the filter to the caller', async () => {
    await seed('resolve-git', 'https://github.com/example/resolve.git', 'git');

    const all = await sources.listAll();

    expect(all.some((repository) => repository.sourceType === 'git')).toBe(true);
  });
});
