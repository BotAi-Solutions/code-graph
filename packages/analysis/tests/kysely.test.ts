import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import { CodeGraphAssembler, ScipAnalyzer, type AssembledGraph, type CodeEdge, type CodeNode } from '@ckg/graph';
import { createDefaultAnalyzers, findKyselyTableAccesses, loadSourceFiles } from '@ckg/analysis';
import { ts } from '../src/source/ast.js';

/**
 * Kysely table access, in two layers.
 *
 * The detector against source text, for every shape of query the rule has to
 * get right — above all the CTE names that shadow real tables. Then the whole
 * pipeline over `test-repositories/kysely-sample` with a real SCIP index, which
 * is what proves the findings arrive as the database analyzer's existing table
 * nodes and READS_FROM / WRITES_TO edges, on the right methods, with evidence.
 */

function scan(body: string) {
  const source = `import { Kysely } from 'kysely';\n${body}`;
  return findKyselyTableAccesses(ts.createSourceFile('repo.ts', source, ts.ScriptTarget.Latest, true));
}

const tables = (result: ReturnType<typeof scan>) =>
  result.accesses.map((access) => `${access.statement} ${access.table}`);

describe('Kysely detector', () => {
  it('1. selectFrom reads the table', () => {
    expect(tables(scan(`db.selectFrom('album').selectAll().execute();`))).toEqual(['SELECT album']);
    expect(scan(`db.selectFrom('album');`).accesses[0]?.access).toBe('read');
  });

  it('2–4. insertInto, updateTable and deleteFrom write it', () => {
    const result = scan(`
      db.insertInto('album').values(v).execute();
      db.updateTable('album').set(v).execute();
      db.deleteFrom('album').where('id', '=', 1).execute();
    `);
    expect(tables(result)).toEqual(['INSERT album', 'UPDATE album', 'DELETE album']);
    expect(result.accesses.every((access) => access.access === 'write')).toBe(true);
  });

  it('5–7. several tables in one method, joins and a long chain', () => {
    const result = scan(`
      class R { m() {
        return this.db
          .selectFrom('asset')
          .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
          .leftJoin('stack', 'stack.id', 'asset.stackId')
          .crossJoin('user')
          .select(['asset.id'])
          .where('asset.ownerId', '=', id)
          .orderBy('asset.createdAt')
          .limit(10)
          .execute();
      } }
    `);
    expect(tables(result)).toEqual(['SELECT asset', 'JOIN asset_exif', 'JOIN stack', 'JOIN user']);
    expect(result.accesses.filter((access) => access.statement === 'JOIN').every((access) => access.access === 'read')).toBe(true);
  });

  it('strips an alias and a schema prefix, as the SQL detector does', () => {
    expect(tables(scan(`db.selectFrom('album as a').innerJoin('public.album_user as au', 'au.albumId', 'a.id');`))).toEqual([
      'SELECT album',
      'JOIN album_user',
    ]);
  });

  it('reads each literal of selectFrom([...])', () => {
    expect(tables(scan(`db.selectFrom(['asset', 'album']).selectAll();`))).toEqual(['SELECT asset', 'SELECT album']);
  });

  it('8. never guesses a table from a variable, a call or an interpolated template', () => {
    const result = scan(`
      db.selectFrom(table).selectAll();
      db.selectFrom(tableName()).selectAll();
      db.selectFrom(\`\${prefix}_album\`).selectAll();
      db.insertInto(this.table).values(v);
    `);
    expect(result.accesses).toEqual([]);
    expect(result.dynamicReferences).toBe(4);
  });

  it('9. a CTE alias is not a physical table', () => {
    const result = scan(`
      db.with('recent', (db) => db.selectFrom('asset').select('id'))
        .selectFrom('recent')
        .selectAll();
    `);
    expect(tables(result)).toEqual(['SELECT asset']);
    expect(result.cteReferences).toBe(1);
  });

  it('10. several CTEs: later ones see earlier ones, the main query sees all', () => {
    const result = scan(`
      db.with('moved', (db) => db.deleteFrom('album_asset').returning('assetId'))
        .with('owner', (db) => db.selectFrom('moved').innerJoin('album', 'album.id', 'moved.albumId'))
        .insertInto('album_asset')
        .expression((eb) => eb.selectFrom('moved').innerJoin('owner', (join) => join.onTrue()));
    `);
    expect(tables(result)).toEqual(['DELETE album_asset', 'JOIN album', 'INSERT album_asset']);
    expect(result.cteReferences).toBe(3);
  });

  it('11. a CTE named like a real table: its own body is the table, the rest of the query is the CTE', () => {
    // Immich's AlbumRepository.create, reduced.
    const result = scan(`
      db.with('album', (db) => db.insertInto('album').values(v).returningAll())
        .with('album_user', (db) => db.insertInto('album_user').expression((eb) => eb.selectFrom('album').select('album.id')))
        .selectFrom('album')
        .selectAll();
    `);
    expect(tables(result)).toEqual(['INSERT album', 'INSERT album_user']);
    expect(result.cteReferences).toBe(2);
  });

  it('keeps a CTE inside its own query: the same name elsewhere in the file is the table', () => {
    const result = scan(`
      class R {
        a() { return db.with('album', (db) => db.selectFrom('asset')).selectFrom('album'); }
        b() { return db.selectFrom('album'); }
      }
    `);
    expect(tables(result)).toEqual(['SELECT asset', 'SELECT album']);
    expect(result.accesses[1]?.line).toBe(5);
  });

  it('a recursive CTE sees its own name inside its body', () => {
    const result = scan(`
      db.withRecursive('descendants', (db) =>
        db.selectFrom('tag').unionAll((eb) => eb.selectFrom('tag').innerJoin('descendants', 'descendants.id', 'tag.parentId')),
      ).selectFrom('descendants');
    `);
    expect(tables(result)).toEqual(['SELECT tag', 'SELECT tag']);
    expect(result.cteReferences).toBe(2);
  });

  it('a CTE name with a column list is still the CTE', () => {
    const result = scan(`db.with('ranked(id, rank)', (db) => db.selectFrom('asset')).selectFrom('ranked');`);
    expect(tables(result)).toEqual(['SELECT asset']);
  });

  it('carries CTE names through a builder variable within the function', () => {
    const result = scan(`
      function upsert() {
        let query = db.with('existing', (db) => db.selectFrom('tag').select('id'));
        query = query.with('user', (db) => db.selectFrom('existing'));
        return query.selectFrom('user').selectAll();
      }
    `);
    expect(tables(result)).toEqual(['SELECT tag']);
    expect(result.cteReferences).toBe(2);
  });

  it('skips, rather than guesses, what an unreadable CTE name might shadow', () => {
    const result = scan(`db.with(name, (db) => db.selectFrom('asset')).selectFrom('album');`);
    expect(tables(result)).toEqual(['SELECT asset']);
    expect(result.undetermined).toBe(1);
  });

  it('12. subqueries in callbacks are found, and inherit the enclosing query’s CTEs', () => {
    const result = scan(`
      db.with('visible', (db) => db.selectFrom('asset'))
        .selectFrom('album')
        .where((eb) => eb.exists(eb.selectFrom('album_asset').whereRef('album_asset.albumId', '=', 'album.id')))
        .select((eb) => jsonArrayFrom(eb.selectFrom('visible').select('id')).as('assets'))
        .innerJoin((eb) => eb.selectFrom('user').select('id').as('u'), (join) => join.onTrue());
    `);
    expect(tables(result)).toEqual(['SELECT asset', 'SELECT album', 'SELECT album_asset', 'SELECT user']);
    expect(result.cteReferences).toBe(1);
  });

  it('finds builders inside unrelated calls, and ignores look-alike methods with no table', () => {
    const result = scan(`
      Promise.all([db.selectFrom('asset').execute(), other.list()]);
      Buffer.from('abc'); query.using('gist'); eb.table('asset_exif');
    `);
    expect(tables(result)).toEqual(['SELECT asset']);
  });

  it('14. records the line and column of the table literal', () => {
    const result = scan(`\nclass R {\n  m() {\n    return this.db\n      .insertInto('album')\n      .values(v);\n  }\n}`);
    // Line 1 is the import the helper adds.
    expect(result.accesses[0]).toMatchObject({ table: 'album', line: 6, column: 18 });
  });

  it('15. reports each occurrence; the graph merges them into one edge', () => {
    const result = scan(`db.selectFrom('album').execute(); db.selectFrom('album').execute();`);
    expect(tables(result)).toEqual(['SELECT album', 'SELECT album']);
  });
});

// --- end to end -------------------------------------------------------------

const FIXTURE = fileURLToPath(new URL('../../scip/tests/fixtures/kysely-sample.scip', import.meta.url));
const SAMPLE = path.resolve(fileURLToPath(new URL('../../../test-repositories/kysely-sample', import.meta.url)));

describe('Kysely through the database analyzer, over kysely-sample', () => {
  let graph: AssembledGraph;
  let byId: Map<string, CodeNode>;

  beforeAll(async () => {
    const index = await new TypeScriptSymbolRefiner().refine(await readScipIndexFile(FIXTURE), { repositoryPath: SAMPLE });
    graph = await new CodeGraphAssembler({
      identity: { projectId: '11111111-1111-4111-8111-111111111111', repositoryId: '22222222-2222-4222-8222-222222222222' },
      repositoryName: 'kysely-sample',
      repositoryPath: SAMPLE,
      language: 'typescript',
      sources: await loadSourceFiles(SAMPLE),
      analyzers: [new ScipAnalyzer({ index }), ...createDefaultAnalyzers()],
    }).assemble();
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });

  const label = (id: string) => {
    const node = byId.get(id);
    return node?.qualifiedName ?? node?.name ?? id;
  };
  const dataEdges = (from: string): CodeEdge[] =>
    graph.edges.filter(
      (edge) => ['READS_FROM', 'WRITES_TO'].includes(edge.relationship) && label(edge.sourceNodeId) === from,
    );
  const summary = (from: string) =>
    dataEdges(from)
      .map((edge) => `${edge.relationship} ${byId.get(edge.targetNodeId)?.name ?? '?'}`)
      .sort();

  it('produces the existing table node type, one per physical table, and no CTE tables', () => {
    const tableNames = graph.nodes.filter((node) => node.type === 'table').map((node) => node.name).sort();
    expect(tableNames).toEqual(['album', 'album_asset', 'album_user', 'tag']);
    for (const cte of ['moved', 'owner', 'descendants', 'existing', 'user']) expect(tableNames).not.toContain(cte);
  });

  it('13. attributes each access to the enclosing method, with the existing relationships', () => {
    expect(summary('AlbumRepository.getById')).toEqual(['READS_FROM album', 'READS_FROM album_user']);
    expect(summary('AlbumRepository.update')).toEqual(['WRITES_TO album']);
    expect(summary('AlbumRepository.delete')).toEqual(['WRITES_TO album']);
    expect(summary('AlbumRepository.countAssets')).toEqual([
      'READS_FROM album',
      'READS_FROM album_asset',
      'READS_FROM album_user',
    ]);
  });

  it('writes, not reads, for a CTE that shadows the table it inserts into', () => {
    expect(summary('AlbumRepository.create')).toEqual(['WRITES_TO album', 'WRITES_TO album_user']);
  });

  it('keeps writes and reads apart in one method using several CTEs', () => {
    expect(summary('AlbumRepository.moveAssets')).toEqual(['READS_FROM album', 'WRITES_TO album_asset']);
  });

  it('reads only the physical table through a recursive CTE and a carried one', () => {
    expect(summary('TagRepository.descendants')).toEqual(['READS_FROM tag']);
    expect(summary('TagRepository.upsertWithCarriedCte')).toEqual(['READS_FROM tag']);
  });

  it('shares the table node with the SQL detector: one `album`, reached both ways', () => {
    const [sqlEdge] = dataEdges('AlbumRepository.countRaw');
    const [kyselyEdge] = dataEdges('AlbumRepository.delete');
    expect(sqlEdge?.metadata).toMatchObject({ detector: 'sql', statement: 'SELECT' });
    expect(kyselyEdge?.metadata).toMatchObject({ detector: 'kysely', statement: 'DELETE' });
    expect(sqlEdge?.targetNodeId).toBe(kyselyEdge?.targetNodeId);
    expect(byId.get(kyselyEdge?.targetNodeId ?? '')).toMatchObject({ type: 'table', name: 'album' });
  });

  it('produces nothing for a table named by a variable', () => {
    expect(summary('AlbumRepository.countIn')).toEqual([]);
  });

  it('merges repeated access into one edge, counting occurrences', () => {
    const edges = dataEdges('AlbumRepository.touchTwice');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.metadata).toMatchObject({ occurrences: 2, detector: 'kysely', statement: 'SELECT' });
  });

  it('carries the existing evidence record, pointing at the table literal', () => {
    const edge = dataEdges('AlbumRepository.update')[0];
    expect(edge?.metadata).toMatchObject({
      source: 'database-analyzer',
      confidence: 'high',
      method: 'ast',
      file: 'src/repositories/album.repository.ts',
      line: 34,
      column: 31,
      matched: 'album',
    });
  });

  it('lifts each method’s access to its class, as for SQL', () => {
    expect(summary('AlbumRepository')).toEqual([
      'READS_FROM album',
      'READS_FROM album_asset',
      'READS_FROM album_user',
      'WRITES_TO album',
      'WRITES_TO album_asset',
      'WRITES_TO album_user',
    ]);
  });

  it('connects the controller to the table through the call graph', () => {
    const calls = (from: string, to: string) =>
      graph.edges.some((edge) => edge.relationship === 'CALLS' && label(edge.sourceNodeId) === from && label(edge.targetNodeId) === to);
    expect(calls('AlbumController.createAlbum', 'AlbumService.create')).toBe(true);
    expect(calls('AlbumService.create', 'AlbumRepository.create')).toBe(true);
    expect(summary('AlbumRepository.create')).toContain('WRITES_TO album');
  });
});
