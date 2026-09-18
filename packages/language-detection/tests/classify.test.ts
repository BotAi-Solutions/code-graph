import { describe, expect, it } from 'vitest';
import { classifyFile, FILE_ROLES } from '../src/classify.js';
import { scanRepository } from '../src/scan.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * File classification is the front door of the repository knowledge graph: it
 * decides what each file *is* before anything reads it. These tests pin the
 * decisions that other packages rely on, and the precedence between them.
 */

const categoryOf = (file: string): string => classifyFile(file).category;
const roleOf = (file: string): string | null => classifyFile(file).role;

describe('classifyFile', () => {
  describe('code', () => {
    it('recognises the languages the platform indexes', () => {
      for (const file of ['src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.jsx', 'src/e.mts']) {
        expect(categoryOf(file)).toBe('code');
      }
    });

    it('keeps the language alongside the category', () => {
      expect(classifyFile('src/user.service.ts')).toMatchObject({
        category: 'code',
        language: 'typescript',
        name: 'user.service.ts',
        extension: '.ts',
      });
      expect(classifyFile('src/legacy.jsx').language).toBe('javascript');
    });

    it('treats a declaration file as code, not as generated output', () => {
      expect(classifyFile('src/types/vendor.d.ts')).toMatchObject({
        category: 'code',
        extension: '.d.ts',
        language: 'typescript',
      });
    });

    it('marks a root tool config as tooling, and a nested one as plain code', () => {
      expect(roleOf('vite.config.ts')).toBe('tooling-config');
      expect(classifyFile('vite.config.ts').category).toBe('code');
      // `src/config/app.config.ts` is a module that *reads* configuration.
      expect(roleOf('src/config/app.config.ts')).toBeNull();
    });
  });

  describe('documents', () => {
    it('recognises Markdown and MDX', () => {
      expect(categoryOf('docs/architecture.md')).toBe('document');
      expect(categoryOf('docs/guide.mdx')).toBe('document');
    });

    it('singles out the README', () => {
      expect(roleOf('README.md')).toBe('readme');
      expect(roleOf('packages/api/readme.md')).toBe('readme');
      expect(roleOf('docs/architecture.md')).toBe('documentation');
    });

    it('has no language, because prose is not a language we index', () => {
      expect(classifyFile('README.md').language).toBeNull();
    });
  });

  describe('configuration', () => {
    it('recognises JSON and YAML', () => {
      expect(categoryOf('config/settings.json')).toBe('configuration');
      expect(categoryOf('deploy/values.yaml')).toBe('configuration');
      expect(categoryOf('deploy/values.yml')).toBe('configuration');
    });

    it('names the manifests the analyzers treat specially', () => {
      expect(roleOf('package.json')).toBe('package-manifest');
      expect(roleOf('tsconfig.json')).toBe('typescript-config');
      expect(roleOf('tsconfig.build.json')).toBe('typescript-config');
      expect(roleOf('jsconfig.json')).toBe('javascript-config');
    });

    it('recognises container and compose files, however they are spelled', () => {
      expect(roleOf('Dockerfile')).toBe('dockerfile');
      expect(roleOf('Dockerfile.dev')).toBe('dockerfile');
      expect(roleOf('docker-compose.yml')).toBe('compose');
      expect(roleOf('compose.yaml')).toBe('compose');
    });

    it('recognises CI workflows by the directory they must live in', () => {
      expect(roleOf('.github/workflows/ci.yml')).toBe('ci-workflow');
      expect(roleOf('.circleci/config.yml')).toBe('ci-workflow');
      // The same file name outside a CI directory is just configuration.
      expect(roleOf('deploy/ci.yml')).toBeNull();
    });

    it('tells an example environment file from a live one', () => {
      expect(roleOf('.env.example')).toBe('env-example');
      expect(roleOf('.env.sample')).toBe('env-example');
      expect(roleOf('.env')).toBe('env');
      expect(roleOf('.env.production')).toBe('env');
    });
  });

  describe('schemas', () => {
    it('recognises an API specification by the name the ecosystem uses', () => {
      expect(classifyFile('openapi.yaml')).toMatchObject({
        category: 'schema',
        role: 'api-spec',
      });
      expect(roleOf('docs/swagger.json')).toBe('api-spec');
      expect(roleOf('spec/openapi.v3.yaml')).toBe('api-spec');
    });

    it('recognises a JSON Schema document', () => {
      expect(classifyFile('schemas/user.schema.json')).toMatchObject({
        category: 'schema',
        role: 'json-schema',
      });
    });

    it('leaves an ordinary YAML file as configuration until something reads it', () => {
      // The scan never opens a file, so a specification under an unexpected
      // name stays configuration here and is refined by the OpenAPI analyzer.
      expect(categoryOf('deploy/service-contract.yaml')).toBe('configuration');
    });

    it('recognises schema languages by extension', () => {
      expect(categoryOf('schema.graphql')).toBe('schema');
      expect(categoryOf('prisma/schema.prisma')).toBe('schema');
      expect(categoryOf('proto/user.proto')).toBe('schema');
    });
  });

  describe('database', () => {
    it('recognises SQL', () => {
      expect(categoryOf('database/schema.sql')).toBe('database');
    });

    it('tells a migration from a schema by where it sits', () => {
      expect(roleOf('database/migrations/0001_init.sql')).toBe('migration');
      expect(roleOf('database/schema.sql')).toBe('sql-schema');
    });
  });

  describe('what is deliberately not read', () => {
    it('marks lock files generated, whatever their extension says', () => {
      expect(classifyFile('pnpm-lock.yaml')).toMatchObject({
        category: 'generated',
        role: 'lockfile',
      });
      expect(categoryOf('package-lock.json')).toBe('generated');
      expect(categoryOf('Cargo.lock')).toBe('generated');
    });

    it('marks vendored and generated trees, even when they hold real code', () => {
      expect(categoryOf('vendor/lib/a.ts')).toBe('vendor');
      expect(categoryOf('src/__generated__/schema.ts')).toBe('generated');
      expect(categoryOf('src/api.generated.ts')).toBe('generated');
      expect(categoryOf('dist/bundle.min.js')).toBe('generated');
    });

    it('marks binaries', () => {
      expect(categoryOf('assets/logo.png')).toBe('binary');
      expect(categoryOf('fixtures/index.scip')).toBe('binary');
    });

    it('falls back to unknown rather than throwing', () => {
      expect(categoryOf('data/rows.csv')).toBe('unknown');
      expect(categoryOf('.gitignore')).toBe('unknown');
      expect(categoryOf('weird')).toBe('unknown');
    });
  });

  describe('precedence', () => {
    it('lets generated and vendored win over the extension', () => {
      expect(categoryOf('vendor/package.json')).toBe('vendor');
      expect(categoryOf('generated/openapi.yaml')).toBe('generated');
    });

    it('lets the exact filename win over the extension', () => {
      expect(roleOf('package.json')).toBe('package-manifest');
      expect(roleOf('config/other.json')).toBeNull();
    });
  });

  it('is deterministic and total: the same path always classifies the same way', () => {
    const paths = [
      'README.md',
      'package.json',
      'src/index.ts',
      'openapi.yaml',
      'database/migrations/0001_init.sql',
      'docker-compose.yml',
      'assets/logo.png',
      'weird',
    ];

    for (const file of paths) {
      const first = classifyFile(file);
      expect(classifyFile(file)).toEqual(first);
      expect(first.path).toBe(file);
      if (first.role !== null) expect(FILE_ROLES).toContain(first.role);
    }
  });

  it('normalises Windows separators before deciding', () => {
    expect(classifyFile('docs\\architecture.md')).toMatchObject({
      path: 'docs/architecture.md',
      category: 'document',
    });
  });
});

describe('scanRepository records categories', () => {
  it('counts each file once, under the category the classifier gives it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ckg-classify-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'db'), { recursive: true });

    await writeFile(path.join(root, 'README.md'), '# hi\n');
    await writeFile(path.join(root, 'package.json'), '{}\n');
    await writeFile(path.join(root, 'openapi.yaml'), 'openapi: 3.0.0\n');
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
    await writeFile(path.join(root, 'db', 'schema.sql'), 'CREATE TABLE t (id int);\n');

    const scan = await scanRepository(root);

    expect(Object.fromEntries(scan.categoryCounts)).toEqual({
      document: 1,
      configuration: 1,
      schema: 1,
      code: 1,
      database: 1,
    });
    expect([...scan.categoryCounts.values()].reduce((a, b) => a + b, 0)).toBe(scan.files.length);
  });
});
