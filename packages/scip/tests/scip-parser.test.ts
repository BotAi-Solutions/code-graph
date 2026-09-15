import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TypeScriptSymbolRefiner, readScipIndexFile } from '@ckg/scip';
import type { ScipIndex } from '@ckg/scip';

/**
 * These run against a real `index.scip`, produced by scip-typescript 0.4 from
 * `test-repositories/typescript-sample`. Hand-written fixtures would only prove
 * the parser agrees with itself.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/typescript-sample.scip', import.meta.url));
const SAMPLE_REPOSITORY = path.resolve(
  fileURLToPath(new URL('../../../test-repositories/typescript-sample', import.meta.url)),
);

async function loadIndex(): Promise<ScipIndex> {
  return readScipIndexFile(FIXTURE);
}

async function loadRefinedIndex(): Promise<ScipIndex> {
  return new TypeScriptSymbolRefiner().refine(await loadIndex(), {
    repositoryPath: SAMPLE_REPOSITORY,
  });
}

describe('readScipIndexFile', () => {
  it('reads the index metadata', async () => {
    const index = await loadIndex();

    expect(index.metadata.toolInfo.name).toBe('scip-typescript');
    expect(index.metadata.projectRoot).toContain('typescript-sample');
  });

  it('produces one document per source file', async () => {
    const index = await loadIndex();

    expect(index.documents.map((document) => document.relativePath)).toEqual([
      'src/controllers/user.controller.ts',
      'src/index.ts',
      'src/models/user.ts',
      'src/repositories/user.repository.ts',
      'src/services/user.service.ts',
      'src/utils/logger.ts',
    ]);
  });

  it('fills in the document language the indexer leaves blank', async () => {
    const index = await loadIndex();

    for (const document of index.documents) {
      expect(document.language).toBe('typescript');
    }
  });

  it('normalises symbols into the internal shape', async () => {
    const index = await loadIndex();
    const models = index.documents.find((d) => d.relativePath === 'src/models/user.ts');
    const createUser = models?.symbols.find((symbol) => symbol.name === 'createUser');

    expect(createUser).toBeDefined();
    expect(createUser?.id).toContain('createUser().');
    expect(createUser?.identity.packageName).toBe('typescript-sample');
    // A top-level method descriptor owned by a file namespace is a function.
    expect(createUser?.kind).toBe('function');
  });

  it('decodes occurrences with roles and ranges', async () => {
    const index = await loadIndex();
    const models = index.documents.find((d) => d.relativePath === 'src/models/user.ts');
    const definitions = models?.occurrences.filter((occurrence) => occurrence.isDefinition) ?? [];

    expect(definitions.length).toBeGreaterThan(5);
    for (const occurrence of definitions) {
      expect(occurrence.startLine).toBeGreaterThanOrEqual(0);
      expect(occurrence.endLine).toBeGreaterThanOrEqual(occurrence.startLine);
      expect(occurrence.symbolId.length).toBeGreaterThan(0);
    }
  });

  it('carries the enclosing range that attributes references to a caller', async () => {
    const index = await loadIndex();
    const service = index.documents.find((d) => d.relativePath === 'src/services/user.service.ts');

    const getUser = service?.occurrences.find(
      (occurrence) => occurrence.isDefinition && occurrence.symbolId.endsWith('getUser().'),
    );

    expect(getUser?.enclosingRange).toBeDefined();
    expect(getUser?.enclosingRange?.endLine).toBeGreaterThan(
      getUser?.enclosingRange?.startLine ?? 0,
    );
  });

  it('decodes implementation relationships', async () => {
    const index = await loadIndex();
    const repository = index.documents.find(
      (d) => d.relativePath === 'src/repositories/user.repository.ts',
    );

    const userRepository = repository?.symbols.find((symbol) => symbol.name === 'UserRepository');
    const implementsUserStore = userRepository?.relationships.find(
      (relation) => relation.isImplementation && relation.symbolId.endsWith('UserStore#'),
    );

    expect(implementsUserStore).toBeDefined();
  });

  it('is deterministic: the same bytes parse to the same result', async () => {
    const [first, second] = await Promise.all([loadIndex(), loadIndex()]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('TypeScriptSymbolRefiner', () => {
  it('recovers class, interface and type-alias kinds SCIP leaves unspecified', async () => {
    const refined = await loadRefinedIndex();

    const kindOf = (name: string): string | undefined =>
      refined.documents
        .flatMap((document) => document.symbols)
        .find((symbol) => symbol.name === name)?.kind;

    expect(kindOf('User')).toBe('interface');
    expect(kindOf('UserStore')).toBe('interface');
    expect(kindOf('HttpResponse')).toBe('interface');
    expect(kindOf('UserRole')).toBe('type');
    expect(kindOf('UserService')).toBe('class');
    expect(kindOf('UserRepository')).toBe('class');
    expect(kindOf('BaseController')).toBe('class');
  });

  it('leaves methods and functions as the descriptor chain already determined', async () => {
    const refined = await loadRefinedIndex();
    const symbols = refined.documents.flatMap((document) => document.symbols);

    expect(symbols.find((symbol) => symbol.name === 'getUser')?.kind).toBe('method');
    expect(symbols.find((symbol) => symbol.name === 'isAdmin')?.kind).toBe('function');
    expect(symbols.find((symbol) => symbol.name === '<constructor>')?.kind).toBe('constructor');
  });

  it('is a no-op when the repository is not readable', async () => {
    const index = await loadIndex();
    const refined = await new TypeScriptSymbolRefiner().refine(index, {
      repositoryPath: '/nonexistent/path',
    });

    expect(refined.documents).toHaveLength(index.documents.length);
    expect(refined.documents[0]?.symbols.length).toBe(index.documents[0]?.symbols.length);
  });
});
