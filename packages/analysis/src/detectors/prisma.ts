/**
 * Prisma schema reader.
 *
 * A `schema.prisma` states the datasource provider and every model, with
 * `@@map` giving the physical table name where it differs. That is a complete,
 * declarative description of the data layer, so it is worth reading directly
 * rather than inferring anything from the client calls alone.
 *
 * Block comments and `//` lines are stripped first so a commented-out model
 * does not become a table.
 */

export interface PrismaModel {
  /** Model name as written: `User`. */
  model: string;
  /** Physical table: `users` when `@@map("users")` is present, else the model. */
  table: string;
  line: number;
}

export interface PrismaSchema {
  relativePath: string;
  provider: string | null;
  models: PrismaModel[];
}

export function parsePrismaSchema(relativePath: string, text: string): PrismaSchema {
  const stripped = stripComments(text);
  const lines = stripped.split('\n');

  const models: PrismaModel[] = [];
  let provider: string | null = null;

  let current: { model: string; table: string; line: number } | null = null;
  let inDatasource = false;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();

    const modelStart = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
    if (modelStart?.[1]) {
      current = { model: modelStart[1], table: modelStart[1], line: index + 1 };
      continue;
    }

    if (/^datasource\s+\w+\s*\{/.test(line)) {
      inDatasource = true;
      continue;
    }

    if (line === '}') {
      if (current) {
        models.push(current);
        current = null;
      }
      inDatasource = false;
      continue;
    }

    if (inDatasource) {
      const match = /^provider\s*=\s*"([^"]+)"/.exec(line);
      if (match?.[1]) provider = match[1];
      continue;
    }

    if (current) {
      const mapped = /^@@map\("([^"]+)"\)/.exec(line);
      if (mapped?.[1]) current.table = mapped[1];
    }
  }

  return {
    relativePath,
    provider,
    models: models.sort((a, b) => a.model.localeCompare(b.model)),
  };
}

/**
 * The Prisma client property for a model: `User` is reached as `prisma.user`,
 * `UserProfile` as `prisma.userProfile`. Lower-casing the first character is
 * the whole rule.
 */
export function clientPropertyFor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** Prisma client methods, by whether they read or write. */
export const PRISMA_METHODS: ReadonlyMap<string, 'read' | 'write'> = new Map([
  ['findUnique', 'read'],
  ['findUniqueOrThrow', 'read'],
  ['findFirst', 'read'],
  ['findFirstOrThrow', 'read'],
  ['findMany', 'read'],
  ['count', 'read'],
  ['aggregate', 'read'],
  ['groupBy', 'read'],
  ['create', 'write'],
  ['createMany', 'write'],
  ['update', 'write'],
  ['updateMany', 'write'],
  ['upsert', 'write'],
  ['delete', 'write'],
  ['deleteMany', 'write'],
]);

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}
