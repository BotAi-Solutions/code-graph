import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, loadEnvFile } from '@ckg/shared/node';

/**
 * The worker's working directory depends on how it was started — `pnpm dev`
 * gives it `apps/worker`, `node dist/worker.js` gives it whatever the operator
 * was in. Repository paths must not move with it.
 */
describe('findWorkspaceRoot', () => {
  it('finds the monorepo root from inside a package', () => {
    const root = findWorkspaceRoot();

    expect(path.basename(root)).toBe('code-graph');
    expect(root).not.toContain(path.join('apps', 'worker'));
  });

  it('is the same wherever the walk starts inside the workspace', () => {
    const fromWorker = findWorkspaceRoot(path.resolve('apps/worker/src/services'));
    const fromPackages = findWorkspaceRoot(path.resolve('packages/graph/src'));

    expect(fromWorker).toBe(fromPackages);
  });

  it('falls back to the working directory outside a workspace', () => {
    expect(findWorkspaceRoot('/')).toBe(process.cwd());
  });
});

describe('loadEnvFile', () => {
  const added: string[] = [];

  afterEach(() => {
    for (const key of added) delete process.env[key];
    added.length = 0;
  });

  it('returns null when there is no env file', () => {
    expect(loadEnvFile({ filePath: path.join(tmpdir(), 'ckg-absent-.env') })).toBeNull();
  });

  it('loads variables from the file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ckg-env-'));
    const filePath = path.join(directory, '.env');
    await writeFile(filePath, 'CKG_TEST_ONLY_A=from_file\n', 'utf8');
    added.push('CKG_TEST_ONLY_A');

    expect(loadEnvFile({ filePath })).toBe(filePath);
    expect(process.env.CKG_TEST_ONLY_A).toBe('from_file');
  });

  it('lets a real environment variable win over the file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ckg-env-'));
    const filePath = path.join(directory, '.env');
    await writeFile(filePath, 'CKG_TEST_ONLY_B=from_file\n', 'utf8');

    process.env.CKG_TEST_ONLY_B = 'from_shell';
    added.push('CKG_TEST_ONLY_B');

    loadEnvFile({ filePath });
    expect(process.env.CKG_TEST_ONLY_B).toBe('from_shell');
  });
});
