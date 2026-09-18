import { describe, expect, it } from 'vitest';
import { parseJsonDocument } from '../src/parsers/json-document.js';
import { parseYamlDocument } from '../src/parsers/yaml-document.js';
import { parseMarkdown, slugify } from '../src/parsers/markdown.js';
import { parseSqlSchema, blankNoise } from '../src/parsers/sql-schema.js';
import {
  isOpenApiDocument,
  normalizeRoutePath,
  parseOpenApi,
} from '../src/parsers/openapi.js';
import {
  asScalarText,
  asString,
  at,
  flatten,
  keysOf,
  member,
  stringItems,
  toPlain,
} from '../src/parsers/structured.js';

/**
 * The parsers, on their own.
 *
 * Every one of them exists to answer two questions — *what is in this file* and
 * *where in the file is it* — and the second is the one worth testing hardest:
 * a configuration property or a documentation mention whose line is wrong is a
 * piece of evidence that sends a reader to the wrong place, which is worse than
 * no evidence at all.
 */

describe('JSON', () => {
  it('parses objects, arrays and every scalar, with positions', () => {
    const document = parseJsonDocument('a.json', '{\n  "a": 1,\n  "b": [true, null, "x"]\n}\n');

    expect(document.error).toBeNull();
    expect(toPlain(document.root)).toEqual({ a: 1, b: [true, null, 'x'] });

    const a = member(document.root ?? undefined, 'a');
    expect(a).toMatchObject({ kind: 'number', value: 1, line: 2 });
    expect(member(document.root ?? undefined, 'b')?.line).toBe(3);
  });

  it('records where the key is written, not only where the value is', () => {
    const document = parseJsonDocument(
      'a.json',
      '{\n  "database": {\n    "host": "localhost"\n  }\n}\n',
    );

    const database = document.root?.entries?.[0];
    expect(database?.keyPosition).toEqual({ line: 2, column: 2 });
    expect(member(database?.value, 'host')?.line).toBe(3);
  });

  it('accepts the JSON a tsconfig is actually written in', () => {
    const document = parseJsonDocument(
      'tsconfig.json',
      `{
  // The compiler options that matter.
  "compilerOptions": {
    /* block comments too */
    "strict": true,
    "target": "ES2023",
  },
}`,
    );

    expect(document.error).toBeNull();
    expect(asString(at(document.root ?? undefined, 'compilerOptions', 'target'))).toBe('ES2023');
    // A comment must not move the line of what follows it.
    expect(at(document.root ?? undefined, 'compilerOptions', 'strict')?.line).toBe(5);
  });

  it('decodes escapes, including unicode', () => {
    const document = parseJsonDocument('a.json', '{"s": "a\\nb\\t\\u0041\\"c\\""}');
    expect(asString(member(document.root ?? undefined, 's'))).toBe('a\nb\tA"c"');
  });

  it('reports a failure with a line rather than throwing', () => {
    const document = parseJsonDocument('a.json', '{\n  "a": 1\n  "b": 2\n}');

    expect(document.root).toBeNull();
    expect(document.error).toContain('line 3');
  });

  it('treats an empty file as empty, not as broken', () => {
    const document = parseJsonDocument('a.json', '   \n');
    expect(document.root).toBeNull();
    expect(document.error).toBeNull();
  });

  it('keeps the last value for a duplicated key, as JSON.parse does', () => {
    const document = parseJsonDocument('a.json', '{"a": 1, "b": 2, "a": 3}');

    expect(toPlain(document.root)).toEqual({ a: 3, b: 2 });
    // And document order for everything written once.
    expect(keysOf(document.root ?? undefined)).toEqual(['a', 'b']);
  });

  it('refuses a document nested past the point of good faith', () => {
    const deep = `${'['.repeat(200)}1${']'.repeat(200)}`;
    expect(parseJsonDocument('a.json', deep).error).toContain('nesting');
  });
});

describe('YAML', () => {
  it('maps a compose file onto the same model as JSON', () => {
    const document = parseYamlDocument(
      'docker-compose.yml',
      'services:\n  api:\n    image: my-api\n    ports:\n      - "8080:8080"\n',
    );

    expect(document.error).toBeNull();
    expect(keysOf(at(document.root ?? undefined, 'services'))).toEqual(['api']);
    expect(asString(at(document.root ?? undefined, 'services', 'api', 'image'))).toBe('my-api');
    expect(stringItems(at(document.root ?? undefined, 'services', 'api', 'ports'))).toEqual([
      '8080:8080',
    ]);
  });

  it('reports the line a key is written on', () => {
    const document = parseYamlDocument('a.yml', 'a: 1\nb:\n  c: 2\n');

    expect(member(document.root ?? undefined, 'a')?.line).toBe(1);
    expect(at(document.root ?? undefined, 'b', 'c')?.line).toBe(3);
  });

  it('reads a key with no value as null rather than dropping it', () => {
    const document = parseYamlDocument('a.yml', 'a:\nb: 1\n');

    expect(keysOf(document.root ?? undefined)).toEqual(['a', 'b']);
    expect(member(document.root ?? undefined, 'a')?.kind).toBe('null');
  });

  it('reads only the first document of a stream, and says how many there were', () => {
    const document = parseYamlDocument('k8s.yml', 'kind: Service\n---\nkind: Deployment\n');

    expect(asString(member(document.root ?? undefined, 'kind'))).toBe('Service');
    expect(document.documentCount).toBe(2);
  });

  it('counts a single document with a leading separator as one', () => {
    expect(parseYamlDocument('a.yml', '---\nkind: Service\n').documentCount).toBe(1);
  });

  it('reports a failure rather than throwing', () => {
    const document = parseYamlDocument('a.yml', 'a: [1, 2\nb: 3\n');

    expect(document.root).toBeNull();
    expect(document.error).toBeTruthy();
  });

  it('treats an empty file as empty', () => {
    expect(parseYamlDocument('a.yml', '\n\n')).toMatchObject({ root: null, error: null });
  });
});

describe('Markdown', () => {
  const sample = `---
title: front matter
---

# Service

Intro naming AuthService in prose.

## Login Flow

Handled by \`UserService.create\` and documented in [the notes](docs/notes.md).

\`\`\`ts
// # Not a heading, and NotAClass is not a mention.
class Ignored {}
\`\`\`

### Details

See [the spec](https://example.com/spec) and [section](#login-flow).

## Teardown
`;

  const document = parseMarkdown('README.md', sample);

  it('skips front matter without swallowing the document', () => {
    expect(document.hasFrontMatter).toBe(true);
    expect(document.title).toBe('Service');
  });

  it('finds the headings and nests them', () => {
    expect(document.headings.map((heading) => `${String(heading.level)}:${heading.text}`)).toEqual([
      '1:Service',
      '2:Login Flow',
      '3:Details',
      '2:Teardown',
    ]);
    expect(document.headings[1]?.parentIndex).toBe(0);
    expect(document.headings[2]?.parentIndex).toBe(1);
    expect(document.headings[3]?.parentIndex).toBe(0);
  });

  it('closes each section at the next heading of its level or above', () => {
    const login = document.headings[1];
    const details = document.headings[2];
    const teardown = document.headings[3];

    expect(login?.endLine).toBe((teardown?.line ?? 0) - 1);
    expect(details?.endLine).toBe((teardown?.line ?? 0) - 1);
    expect(teardown?.endLine).toBe(document.lineCount);
  });

  it('never reads a fenced block as prose', () => {
    expect(document.headings.some((heading) => heading.text.includes('Not a heading'))).toBe(false);
    expect(document.mentions.some((mention) => mention.name === 'NotAClass')).toBe(false);
    expect(document.codeBlocks).toHaveLength(1);
    expect(document.codeBlocks[0]?.language).toBe('ts');
  });

  it('classifies links by what they point at', () => {
    const kinds = Object.fromEntries(document.links.map((link) => [link.text, link.kind]));

    expect(kinds).toEqual({
      'the notes': 'path',
      'the spec': 'external',
      section: 'anchor',
    });
    expect(document.links.find((link) => link.kind === 'path')?.path).toBe('docs/notes.md');
    expect(document.links.find((link) => link.kind === 'anchor')?.fragment).toBe('login-flow');
  });

  it('takes a code span as a name, and a distinctive prose word too', () => {
    const named = document.mentions.map((mention) => `${mention.form}:${mention.name}`);

    expect(named).toContain('code-span:UserService.create');
    expect(named).toContain('prose:AuthService');
  });

  it('will not take a single capitalised word from prose', () => {
    const parsed = parseMarkdown('a.md', 'The Server holds a User and a Config.\n');
    expect(parsed.mentions).toEqual([]);
  });

  it('takes a single word when the author marked it as code', () => {
    const parsed = parseMarkdown('a.md', 'The `Server` holds it.\n');
    expect(parsed.mentions).toMatchObject([{ name: 'Server', form: 'code-span' }]);
  });

  it('attributes a mention to the section it sits in', () => {
    const login = document.mentions.find((mention) => mention.name === 'UserService.create');
    expect(document.headings[login?.headingIndex ?? -1]?.text).toBe('Login Flow');
  });

  it('strips inline markup from a heading before slugging it', () => {
    const parsed = parseMarkdown('a.md', '## The `run` **command**\n');
    expect(parsed.headings[0]?.text).toBe('The run command');
    expect(parsed.headings[0]?.slug).toBe('the-run-command');
  });

  it('keeps an unterminated fence rather than losing the rest of the file', () => {
    const parsed = parseMarkdown('a.md', '# A\n\n```\nnever closed\n');
    expect(parsed.codeBlocks).toHaveLength(1);
    expect(parsed.headings).toHaveLength(1);
  });

  it('slugs the way an anchor link does', () => {
    expect(slugify('Login Flow')).toBe('login-flow');
    expect(slugify('What is `this`?')).toBe('what-is-this');
  });
});

describe('SQL', () => {
  const schema = parseSqlSchema(
    'database/migrations/0001_init.sql',
    `-- users and their sessions
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE sessions (
  id       UUID PRIMARY KEY,
  user_id  UUID NOT NULL REFERENCES users (id),
  CONSTRAINT fk_extra FOREIGN KEY (user_id) REFERENCES users (id)
);

ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;

INSERT INTO audit_log (message) VALUES ('created users');
SELECT * FROM users WHERE email = 'nobody@example.com';
`,
  );

  it('finds the tables and where they were declared', () => {
    expect(schema.tables.map((table) => table.name)).toEqual(['users', 'sessions']);
    expect(schema.tables[0]?.line).toBe(2);
  });

  it('finds the columns, their types and their constraints', () => {
    const users = schema.tables[0];

    expect(users?.columns.map((column) => column.name)).toEqual([
      'id',
      'email',
      'display_name',
      'created_at',
      // Added by the ALTER below, onto the table it names.
      'last_seen_at',
    ]);
    expect(users?.columns[1]).toMatchObject({
      name: 'email',
      dataType: 'TEXT',
      notNull: true,
      unique: true,
      primaryKey: false,
    });
    expect(users?.columns[0]).toMatchObject({ name: 'id', dataType: 'UUID', primaryKey: true });
    expect(users?.columns[3]?.dataType).toBe('TIMESTAMP WITH TIME ZONE');
  });

  it('finds indexes and which table they are on', () => {
    expect(schema.indexes).toEqual([
      { name: 'idx_users_email', table: 'users', columns: ['email'], unique: true, line: 9 },
    ]);
  });

  it('finds foreign keys, column-level and table-level alike', () => {
    expect(schema.foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromTable: 'sessions', fromColumn: 'user_id', toTable: 'users' }),
      ]),
    );
  });

  it('reports DML separately from DDL, and does not double-count the schema', () => {
    expect(schema.accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'audit_log', access: 'write', statement: 'INSERT' }),
        expect.objectContaining({ table: 'users', access: 'read', statement: 'SELECT' }),
      ]),
    );
    // `CREATE TABLE users` is inside a DDL range and must not also register as
    // a write of `users` from the statement sweep.
    expect(
      schema.accesses.filter((access) => access.table === 'users' && access.access === 'write'),
    ).toEqual([]);
  });

  it('blanks comments and literals without moving a single line', () => {
    const source = "SELECT 1; -- FROM ghosts\n/* FROM phantoms */\nSELECT 'FROM nothing';\n";
    const blanked = blankNoise(source);

    expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.toLowerCase()).not.toContain('ghosts');
    expect(blanked.toLowerCase()).not.toContain('phantoms');
  });

  it('does not read a table name out of a comment or a string', () => {
    const parsed = parseSqlSchema(
      'a.sql',
      "-- CREATE TABLE commented_out (id int);\nSELECT 'INSERT INTO fake_table' AS note;\n",
    );

    expect(parsed.tables).toEqual([]);
    expect(parsed.accesses.map((access) => access.table)).not.toContain('fake_table');
  });

  it('keeps an ALTER for a table it has not seen as a table in its own right', () => {
    const parsed = parseSqlSchema('a.sql', 'ALTER TABLE orders ADD COLUMN total NUMERIC(10,2);\n');

    expect(parsed.tables).toMatchObject([
      { name: 'orders', columns: [{ name: 'total', dataType: 'NUMERIC(10,2)' }] },
    ]);
  });
});

describe('OpenAPI', () => {
  const yaml = `openapi: 3.0.3
info:
  title: Users
  version: 1.4.0
servers:
  - url: https://api.example.com/v2
paths:
  /users:
    parameters:
      - name: trace
        in: header
    post:
      operationId: createUser
      tags: [users]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateUserInput'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
    x-internal: true
  /health:
    get:
      responses:
        '200':
          description: ok
components:
  schemas:
    User:
      type: object
    CreateUserInput:
      type: object
`;

  const document = parseYamlDocument('openapi.yaml', yaml);
  const spec = parseOpenApi(document);

  it('recognises a specification by its content', () => {
    expect(isOpenApiDocument(document)).toBe(true);
    expect(spec).not.toBeNull();
    expect(spec?.flavour).toBe('openapi-3');
    expect(spec?.version).toBe('3.0.3');
    expect(spec?.title).toBe('Users');
    expect(spec?.apiVersion).toBe('1.4.0');
  });

  it('refuses a document that merely has a paths key', () => {
    const notASpec = parseYamlDocument('deploy.yaml', 'paths:\n  /data: /mnt/data\n');
    expect(isOpenApiDocument(notASpec)).toBe(false);
    expect(parseOpenApi(notASpec)).toBeNull();
  });

  it('takes the path component of a single server as the base path', () => {
    expect(spec?.basePath).toBe('/v2');
  });

  it('refuses a base path when the document names several servers', () => {
    const many = parseYamlDocument(
      'o.yaml',
      'openapi: 3.0.0\nservers:\n  - url: https://a/v1\n  - url: https://b/v1\npaths:\n  /x:\n    get:\n      responses: {}\n',
    );
    expect(parseOpenApi(many)?.basePath).toBeNull();
  });

  it('extracts each operation with its method, id, tags and line', () => {
    expect(spec?.operations.map((operation) => `${operation.method} ${operation.path}`)).toEqual([
      'POST /users',
      'GET /health',
    ]);

    const post = spec?.operations[0];
    expect(post?.operationId).toBe('createUser');
    expect(post?.tags).toEqual(['users']);
    expect(yaml.split('\n')[(post?.line ?? 1) - 1]).toContain('post:');
  });

  it('merges the path-level parameters into every operation on it', () => {
    expect(spec?.operations[0]?.parameters).toEqual([
      { name: 'trace', location: 'header', required: false },
    ]);
  });

  it('resolves request and response schemas to their names', () => {
    expect(spec?.operations[0]?.requestSchemas).toEqual(['CreateUserInput']);
    expect(spec?.operations[0]?.responses).toEqual([{ status: '201', schemas: ['User'] }]);
    expect(spec?.schemaNames).toEqual(['User', 'CreateUserInput']);
  });

  it('ignores extension keys where an operation would be', () => {
    expect(spec?.operations.some((operation) => operation.method.startsWith('X'))).toBe(false);
  });

  it('parses the same specification written as JSON', () => {
    const json = parseJsonDocument(
      'openapi.json',
      '{"openapi":"3.0.0","paths":{"/users":{"post":{"operationId":"createUser","responses":{}}}}}',
    );

    expect(parseOpenApi(json)?.operations).toMatchObject([
      { method: 'POST', path: '/users', operationId: 'createUser' },
    ]);
  });
});

describe('route path matching', () => {
  it('erases parameter names so two dialects of one route agree', () => {
    expect(normalizeRoutePath('/users/{id}')).toBe('/users/{}');
    expect(normalizeRoutePath('/users/:userId')).toBe('/users/{}');
    expect(normalizeRoutePath('/users/{id}/posts/{postId}')).toBe('/users/{}/posts/{}');
  });

  it('normalises separators without merging different routes', () => {
    expect(normalizeRoutePath('/users/')).toBe('/users');
    expect(normalizeRoutePath('users')).toBe('/users');
    expect(normalizeRoutePath('/users')).not.toBe(normalizeRoutePath('/users/{}'));
  });
});

describe('structured helpers', () => {
  const document = parseJsonDocument(
    'a.json',
    '{"a":{"b":{"c":1,"d":[1,2]}},"e":"x","f":true}',
  );

  it('flattens to dotted paths, bounded by depth', () => {
    const shallow = flatten(document.root, { maxDepth: 1 }).map((entry) => entry.path);
    expect(shallow).toEqual(['a', 'e', 'f']);

    const deeper = flatten(document.root, { maxDepth: 2 }).map((entry) => entry.path);
    expect(deeper).toEqual(['a', 'a.b', 'e', 'f']);
  });

  it('flattens only leaves when asked', () => {
    const leaves = flatten(document.root, { maxDepth: 3, scalarsOnly: true }).map(
      (entry) => entry.path,
    );
    expect(leaves).toEqual(['a.b.c', 'e', 'f']);
  });

  it('stops at the path cap', () => {
    expect(flatten(document.root, { maxDepth: 5, maxPaths: 2 })).toHaveLength(2);
  });

  it('reads any scalar as text, whichever way it was written', () => {
    expect(asScalarText(member(document.root ?? undefined, 'e'))).toBe('x');
    expect(asScalarText(member(document.root ?? undefined, 'f'))).toBe('true');
    expect(asScalarText(member(document.root ?? undefined, 'a'))).toBeNull();
  });

  it('never throws on a shape it did not expect', () => {
    expect(member(undefined, 'a')).toBeUndefined();
    expect(at(document.root ?? undefined, 'a', 'nope', 'deeper')).toBeUndefined();
    expect(keysOf(member(document.root ?? undefined, 'e'))).toEqual([]);
    expect(stringItems(undefined)).toEqual([]);
  });
});
