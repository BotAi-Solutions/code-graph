import { afterEach, describe, expect, it } from 'vitest';
import {
  TEST_DATABASE_ENV,
  UnsafeTestDatabaseError,
  connectTestDatabase,
  databaseUrlsInEnvFile,
  describeTarget,
  testDatabaseUrl,
  unsafeReason,
} from './helpers/test-database.js';

/**
 * The guard in front of every database-backed suite. No database needed:
 * these run on every `pnpm test`. The one connection attempt is to a loopback
 * port nothing listens on, to prove an unreachable test database fails.
 */

const DEV = 'postgresql://user:secret@localhost:5433/code_knowledge_graph';

describe('the test database guard', () => {
  it('accepts a database whose name says it is for tests', () => {
    expect(unsafeReason('postgresql://u:p@localhost:5433/ckg_test', [DEV])).toBeNull();
    expect(unsafeReason('postgresql://u:p@db.internal/code_knowledge_graph_test', [DEV])).toBeNull();
  });

  it('refuses the development database by name, whatever the server', () => {
    expect(unsafeReason('postgresql://u:p@elsewhere:6000/code_knowledge_graph', [])).toMatch(/development database/);
  });

  it('refuses a database whose name does not contain "test"', () => {
    expect(unsafeReason('postgresql://u:p@localhost:5433/scratch', [DEV])).toMatch(/contains "test"/);
  });

  it('refuses the same host, port and database as DATABASE_URL, treating loopback names as one host', () => {
    const devTest = 'postgresql://other:pw@localhost:5433/ckg_test';
    expect(unsafeReason('postgresql://u:p@127.0.0.1:5433/ckg_test', [devTest])).toMatch(/same database as DATABASE_URL/);
    // A different port is a different server.
    expect(unsafeReason('postgresql://u:p@127.0.0.1:5434/ckg_test', [devTest])).toBeNull();
  });

  it('compares the host and port pg will actually use, including ?host= and ?port=', () => {
    const dev = 'postgresql://u:p@localhost:5433/ckg_test';
    expect(unsafeReason('postgresql://u:p@elsewhere:9999/ckg_test?host=localhost&port=5433', [dev])).toMatch(
      /same database as DATABASE_URL/,
    );
  });

  it('reads DATABASE_URL out of .env text without loading it', () => {
    const text = ['# comment', 'PORT=3001', "export DATABASE_URL='postgresql://a@h:1/db_one'", 'DATABASE_URL="postgresql://b@h:2/db_two"  ', 'OTHER_DATABASE_URL=x'].join('\n');
    expect(databaseUrlsInEnvFile(text)).toEqual(['postgresql://a@h:1/db_one', 'postgresql://b@h:2/db_two']);
  });

  it('refuses a URL that names no database or is not a URL', () => {
    expect(unsafeReason('postgresql://u:p@localhost:5433/', [])).toMatch(/names no database/);
    expect(() => unsafeReason('not a url', [])).toThrow(UnsafeTestDatabaseError);
  });

  it('refuses any scheme but postgres:// and postgresql://, where pg reads the database from elsewhere', () => {
    // pg takes this one's database from ?db=, so the path name would mislead the check.
    expect(() => unsafeReason('socket:/var/run/pg_test?db=code_knowledge_graph', [])).toThrow(/postgres:\/\//);
    expect(unsafeReason('postgres://u:p@localhost:5433/ckg_test', [DEV])).toBeNull();
  });

  it('prints host, port and database only, never credentials', () => {
    const shown = describeTarget('postgresql://user:secret@localhost:5433/ckg_test');
    expect(shown).toBe('localhost:5433/ckg_test');
    expect(shown).not.toContain('secret');
  });

  describe('testDatabaseUrl', () => {
    const saved = process.env[TEST_DATABASE_ENV];
    afterEach(() => {
      if (saved === undefined) delete process.env[TEST_DATABASE_ENV];
      else process.env[TEST_DATABASE_ENV] = saved;
    });

    it('skips (returns null) when the variable is unset, and never falls back to DATABASE_URL', () => {
      delete process.env[TEST_DATABASE_ENV];
      const savedDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5433/ckg_test';
      try {
        expect(testDatabaseUrl('guard unit test')).toBeNull();
      } finally {
        if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = savedDatabaseUrl;
      }
    });

    it('fails, rather than skipping, when an explicit test database cannot be reached', async () => {
      // Port 1 on loopback: nothing listens there, so the connection is refused at once.
      process.env[TEST_DATABASE_ENV] = 'postgresql://u:p@127.0.0.1:1/ckg_unreachable_test';
      await expect(connectTestDatabase('guard unit test')).rejects.toThrow(/cannot be reached/);
    });

    it('throws, rather than skipping, when the variable names an unsafe database', () => {
      process.env[TEST_DATABASE_ENV] = 'postgresql://u:p@localhost:5433/code_knowledge_graph';
      expect(() => testDatabaseUrl('guard unit test')).toThrow(/refusing to run/);
    });
  });
});
