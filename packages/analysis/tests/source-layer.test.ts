import { describe, expect, it } from 'vitest';
import {
  BindingTable,
  InMemorySourceFileSet,
  ModuleResolver,
  ModuleSet,
  findTableReferences,
  joinRoutePath,
  hostOfUrl,
  isPlaceholderHost,
  looksLikeSql,
  parseModule,
  parsePrismaSchema,
  clientPropertyFor,
  readManifest,
  vendorForHost,
  vendorForPackage,
  configKindOf,
} from '@ckg/analysis';

/**
 * The pieces the analyzers rest on. Each is a pure function over text, so each
 * can be pinned down exactly — which matters more here than anywhere else in
 * the pipeline, because a resolver that quietly guesses is how a graph fills up
 * with edges nobody can trust.
 */

describe('ModuleResolver', () => {
  const resolver = new ModuleResolver([
    'src/app.ts',
    'src/services/user.service.ts',
    'src/services/index.ts',
    'src/models/user.ts',
    'src/legacy/helper.js',
  ]);

  it('resolves a relative import to the file it names', () => {
    expect(resolver.resolve('src/app.ts', './services/user.service.js')).toEqual({
      kind: 'file',
      relativePath: 'src/services/user.service.ts',
    });
  });

  it('follows TypeScript’s rule that .js means .ts', () => {
    expect(resolver.resolve('src/services/user.service.ts', '../models/user.js')).toEqual({
      kind: 'file',
      relativePath: 'src/models/user.ts',
    });
  });

  it('resolves an extensionless import', () => {
    expect(resolver.resolve('src/app.ts', './models/user')).toEqual({
      kind: 'file',
      relativePath: 'src/models/user.ts',
    });
  });

  it('resolves a directory import to its index file', () => {
    expect(resolver.resolve('src/app.ts', './services')).toEqual({
      kind: 'file',
      relativePath: 'src/services/index.ts',
    });
  });

  it('keeps a .js file that really is .js', () => {
    expect(resolver.resolve('src/app.ts', './legacy/helper.js')).toEqual({
      kind: 'file',
      relativePath: 'src/legacy/helper.js',
    });
  });

  it('splits a bare specifier into package and subpath', () => {
    expect(resolver.resolve('src/app.ts', 'express')).toEqual({
      kind: 'package',
      packageName: 'express',
      subpath: null,
    });
    expect(resolver.resolve('src/app.ts', '@nestjs/common')).toEqual({
      kind: 'package',
      packageName: '@nestjs/common',
      subpath: null,
    });
    expect(resolver.resolve('src/app.ts', '@aws-sdk/client-s3/dist/index.js')).toEqual({
      kind: 'package',
      packageName: '@aws-sdk/client-s3',
      subpath: 'dist/index.js',
    });
  });

  it('reports a specifier it cannot resolve rather than guessing', () => {
    expect(resolver.resolve('src/app.ts', './nowhere.js')).toEqual({
      kind: 'unresolved',
      specifier: './nowhere.js',
    });
    // A path alias needs a tsconfig; guessing would point an edge at the wrong file.
    expect(resolver.resolve('src/app.ts', '#internal/thing')).toMatchObject({
      kind: 'unresolved',
    });
  });

  it('refuses to escape the repository root', () => {
    expect(resolver.resolve('src/app.ts', '../../../etc/passwd')).toMatchObject({
      kind: 'unresolved',
    });
  });
});

describe('BindingTable', () => {
  const sources = new InMemorySourceFileSet([
    {
      relativePath: 'src/app.ts',
      text: `
import express, { Router } from 'express';
import { UserController } from './controllers/user.controller.js';
import type { User } from './models/user.js';
import './setup.js';

export const BASE_PATH = '/users';

export class Wiring {
  private readonly controller = new UserController();

  constructor(private readonly routes: Router) {}
}

export function build(controller: UserController): Router {
  const router = Router();
  return router;
}
`,
    },
    { relativePath: 'src/controllers/user.controller.ts', text: 'export class UserController {}' },
    { relativePath: 'src/models/user.ts', text: 'export interface User { id: string }' },
    { relativePath: 'src/setup.ts', text: 'export const ready = true;' },
  ]);

  const modules = new ModuleSet(sources);
  const module = modules.module('src/app.ts');
  const bindings = module?.bindings as BindingTable;

  it('records a default import as a package binding', () => {
    expect(bindings.get('express')).toMatchObject({
      kind: 'package',
      packageName: 'express',
      exportedName: 'default',
    });
  });

  it('records a named import from a package', () => {
    expect(bindings.get('Router')).toMatchObject({ kind: 'package', packageName: 'express' });
  });

  it('records an import from another file, with the file it resolved to', () => {
    expect(bindings.get('UserController')).toMatchObject({
      kind: 'import',
      from: 'src/controllers/user.controller.ts',
      exportedName: 'UserController',
    });
  });

  it('marks a type-only import as such', () => {
    expect(bindings.get('User')).toMatchObject({ kind: 'import', typeOnly: true });
  });

  it('keeps side-effect imports, which carry no binding but are dependencies', () => {
    expect(bindings.sideEffects().map((entry) => entry.module)).toEqual([
      { kind: 'file', relativePath: 'src/setup.ts' },
    ]);
  });

  it('records a field initialised by construction, keyed as it is referenced', () => {
    expect(bindings.get('this.controller')).toMatchObject({
      kind: 'instance',
      className: 'UserController',
    });
  });

  it('records a constructor parameter property by its declared type', () => {
    expect(bindings.get('this.routes')).toMatchObject({ kind: 'instance', className: 'Router' });
  });

  it('records a plain function parameter by its own name', () => {
    expect(bindings.get('controller')).toMatchObject({
      kind: 'instance',
      className: 'UserController',
    });
  });

  it('records a local created by calling an imported factory', () => {
    expect(bindings.get('router')).toMatchObject({ kind: 'call', calleeName: 'Router' });
  });

  it('reads module-level string constants', () => {
    expect(bindings.constant('BASE_PATH')).toBe('/users');
    expect(bindings.constant('MISSING')).toBeUndefined();
  });

  it('lists what the module exports and what it imports', () => {
    expect(bindings.exports().map((entry) => entry.exportedName).sort()).toEqual([
      'BASE_PATH',
      'Wiring',
      'build',
    ]);
    expect(bindings.packages()).toEqual(['express']);
    expect(bindings.files()).toEqual(
      expect.arrayContaining(['src/controllers/user.controller.ts', 'src/models/user.ts']),
    );
  });

  it('parses a module by its extension, so JSX is not a syntax error', () => {
    const jsx = parseModule({
      relativePath: 'src/App.tsx',
      text: 'export const App = () => <div className="x" />;',
    });
    expect(jsx.statements.length).toBe(1);
  });
});

describe('SQL table detection', () => {
  it('reads the table out of each statement form, with the right direction', () => {
    expect(findTableReferences('INSERT INTO users (email) VALUES ($1)')).toEqual([
      { table: 'users', access: 'write', statement: 'INSERT' },
    ]);
    expect(findTableReferences('UPDATE users SET verified_at = now()')).toEqual([
      { table: 'users', access: 'write', statement: 'UPDATE' },
    ]);
    expect(findTableReferences('DELETE FROM users WHERE id = $1')).toEqual([
      { table: 'users', access: 'write', statement: 'DELETE' },
    ]);
    expect(findTableReferences('SELECT * FROM users WHERE id = $1')).toEqual([
      { table: 'users', access: 'read', statement: 'SELECT' },
    ]);
  });

  it('reads joined tables, not just the leading FROM', () => {
    const tables = findTableReferences(
      'SELECT u.*, count(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id',
    );

    expect(tables.map((entry) => entry.table).sort()).toEqual(['orders', 'users']);
    expect(tables.every((entry) => entry.access === 'read')).toBe(true);
  });

  it('strips quoting and schema prefixes', () => {
    expect(findTableReferences('SELECT * FROM "public"."users"')[0]?.table).toBe('users');
    expect(findTableReferences('SELECT * FROM public.users')[0]?.table).toBe('users');
  });

  it('is case and whitespace insensitive', () => {
    expect(findTableReferences('select\n  *\n  from\n  users')[0]?.table).toBe('users');
  });

  it('finds nothing in text that is not SQL', () => {
    expect(looksLikeSql('https://api.sendgrid.com/v3/mail/send')).toBe(false);
    expect(findTableReferences('a user selected from the list')).toEqual([]);
    expect(findTableReferences('')).toEqual([]);
  });

  it('will not read a table name through a template substitution', () => {
    // The analyzer replaces substitutions with a marker no identifier can
    // contain, so `SELECT * FROM ${table}` names no table — which is correct.
    const interpolated = `SELECT * FROM ${String.fromCharCode(1)} WHERE id = $1`;
    expect(findTableReferences(interpolated)).toEqual([]);
  });

  it('does not mistake SQL keywords for tables', () => {
    expect(findTableReferences('SELECT * FROM (SELECT 1) t')).toEqual([]);
    expect(findTableReferences('SELECT * FROM unnest($1::text[])')).toEqual([]);
  });

  it('is repeatable: a global regex does not carry state between calls', () => {
    const first = findTableReferences('SELECT * FROM users');
    const second = findTableReferences('SELECT * FROM users');
    expect(second).toEqual(first);
  });
});

describe('Prisma schema', () => {
  const schema = parsePrismaSchema(
    'prisma/schema.prisma',
    `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    String @id
  email String @unique

  @@map("users")
}

// model Ignored { }

model Order {
  id String @id
}
`,
  );

  it('reads the provider from the datasource block', () => {
    expect(schema.provider).toBe('postgresql');
  });

  it('maps a model to its physical table, defaulting to the model name', () => {
    expect(schema.models).toEqual([
      { model: 'Order', table: 'Order', line: 16 },
      { model: 'User', table: 'users', line: 7 },
    ]);
  });

  it('ignores a commented-out model', () => {
    expect(schema.models.map((model) => model.model)).not.toContain('Ignored');
  });

  it('knows how a model is reached on the client', () => {
    expect(clientPropertyFor('User')).toBe('user');
    expect(clientPropertyFor('UserProfile')).toBe('userProfile');
  });
});

describe('route paths', () => {
  it('joins segments the way a router mounts them', () => {
    expect(joinRoutePath('/users', '/')).toBe('/users');
    expect(joinRoutePath('/users', '/:id/verify')).toBe('/users/:id/verify');
    expect(joinRoutePath('api', 'users', '')).toBe('/api/users');
    expect(joinRoutePath(null, undefined, '/health')).toBe('/health');
  });

  it('collapses doubled separators rather than emitting them', () => {
    expect(joinRoutePath('/users/', '/:id')).toBe('/users/:id');
  });

  it('renders the root as a single slash', () => {
    expect(joinRoutePath('', '/')).toBe('/');
  });
});

describe('external services', () => {
  it('names a vendor from its package', () => {
    expect(vendorForPackage('stripe')).toEqual({ name: 'Stripe', category: 'payments' });
    expect(vendorForPackage('@aws-sdk/client-s3')?.name).toBe('AWS S3');
    expect(vendorForPackage('lodash')).toBeNull();
  });

  it('names a vendor from its API host', () => {
    expect(vendorForHost('api.sendgrid.com')?.name).toBe('SendGrid');
    expect(vendorForHost('API.STRIPE.COM')?.name).toBe('Stripe');
    expect(vendorForHost('api.unknown-vendor.test')).toBeNull();
  });

  it('extracts the host of an absolute http(s) URL only', () => {
    expect(hostOfUrl('https://api.stripe.com/v1/charges')).toBe('api.stripe.com');
    expect(hostOfUrl('http://internal.svc/health')).toBe('internal.svc');
    expect(hostOfUrl('/v1/charges')).toBeNull();
    expect(hostOfUrl('not a url')).toBeNull();
  });

  it('treats loopback and reserved example domains as no dependency at all', () => {
    for (const host of ['localhost', '127.0.0.1', 'example.com', 'api.local']) {
      expect(isPlaceholderHost(host)).toBe(true);
    }
    expect(isPlaceholderHost('api.sendgrid.com')).toBe(false);
  });
});

describe('configuration files', () => {
  it('recognises manifests, environment files and container definitions', () => {
    expect(configKindOf('package.json')).toBe('manifest');
    expect(configKindOf('tsconfig.json')).toBe('typescript');
    expect(configKindOf('tsconfig.build.json')).toBe('typescript');
    expect(configKindOf('.env.example')).toBe('environment');
    expect(configKindOf('Dockerfile')).toBe('container');
    expect(configKindOf('vite.config.ts')).toBe('tooling');
  });

  it('does not count lock files or ordinary source as configuration', () => {
    expect(configKindOf('pnpm-lock.yaml')).toBeNull();
    expect(configKindOf('package-lock.json')).toBeNull();
    expect(configKindOf('src/index.ts')).toBeNull();
    // A module that *reads* configuration is code, not configuration.
    expect(configKindOf('src/config/app.config.ts')).toBeNull();
  });
});

describe('manifest', () => {
  it('reads the fields the graph needs', () => {
    const manifest = readManifest(
      new InMemorySourceFileSet([
        {
          relativePath: 'package.json',
          text: JSON.stringify({
            name: 'users-service',
            version: '1.2.0',
            dependencies: { express: '^4.19.2' },
            devDependencies: { typescript: '^5.9.3' },
          }),
        },
      ]),
    );

    expect(manifest).toMatchObject({
      name: 'users-service',
      version: '1.2.0',
      dependencies: { express: '^4.19.2' },
      developmentDependencies: { typescript: '^5.9.3' },
    });
  });

  it('degrades rather than throwing on a malformed manifest', () => {
    expect(readManifest(new InMemorySourceFileSet([{ relativePath: 'package.json', text: '{' }]))).toBeNull();
    expect(readManifest(new InMemorySourceFileSet([]))).toBeNull();
  });
});
