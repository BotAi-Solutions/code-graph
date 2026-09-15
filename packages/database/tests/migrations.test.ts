import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, loadMigrations } from '@ckg/database';

/**
 * Guards the migration contract itself. Anything needing a live server belongs
 * in an integration suite, not here.
 */
describe('migrations', () => {
  it('loads every .sql file in lexical order with a checksum', async () => {
    const migrations = await loadMigrations();

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((migration) => migration.name)).toEqual(
      [...migrations.map((migration) => migration.name)].sort(),
    );
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.sql.length).toBeGreaterThan(0);
    }
  });

  it('names migrations with a sortable numeric prefix', async () => {
    for (const migration of await loadMigrations()) {
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it('creates every table the application reads and writes', async () => {
    const sql = (await loadMigrations()).map((migration) => migration.sql).join('\n');

    for (const table of [
      'projects',
      'repositories',
      'analysis_jobs',
      'code_nodes',
      'code_edges',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('indexes the columns the graph API filters and joins on', async () => {
    const sql = (await loadMigrations()).map((migration) => migration.sql).join('\n');

    for (const index of [
      'idx_code_nodes_project_id',
      'idx_code_nodes_file_path',
      'idx_code_nodes_node_type',
      'idx_code_nodes_name',
      'idx_code_edges_source',
      'idx_code_edges_target',
      'idx_code_edges_relationship',
    ]) {
      expect(sql).toContain(index);
    }
  });

  it('constrains analysis status to the documented state machine', async () => {
    const sql = (await loadMigrations()).map((migration) => migration.sql).join('\n');

    for (const status of [
      'QUEUED',
      'INDEXING',
      'PARSING',
      'BUILDING_GRAPH',
      'PERSISTING',
      'COMPLETED',
      'FAILED',
    ]) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it('keeps schema/schema.sql in step with the migrations', async () => {
    const snapshot = await readFile(
      new URL('../schema/schema.sql', import.meta.url),
      'utf8',
    );
    const migrations = await loadMigrations();
    const combined = migrations.map((migration) => migration.sql).join('');

    expect(snapshot.replaceAll(/\s+/g, ' ').trim()).toBe(
      combined.replaceAll(/\s+/g, ' ').trim(),
    );
  });

  it('points MIGRATIONS_DIR at the shipped migrations folder', async () => {
    const entries = await readdir(MIGRATIONS_DIR);
    expect(entries.some((entry) => entry.endsWith('.sql'))).toBe(true);
  });
});
