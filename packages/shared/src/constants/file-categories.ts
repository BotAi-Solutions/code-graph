/**
 * What kind of thing a file is, independent of which language it is written in.
 *
 * The scanner used to ask one question — "is this a language we index?" — and
 * everything that was not TypeScript or JavaScript fell into a single bucket
 * called "not source". That was adequate for a code graph and is not adequate
 * for a repository graph: a README, a compose file, an OpenAPI document and a
 * migration are four different kinds of knowledge and need to be told apart
 * before anything can be extracted from them.
 *
 * Category and language are orthogonal and both are recorded. `vite.config.ts`
 * is `code` with language `typescript` *and* carries a configuration role;
 * `openapi.yaml` is `schema` with no language at all.
 */
export const FILE_CATEGORIES = [
  /** A language the platform can index or analyse. */
  'code',
  /** Prose: Markdown and friends. */
  'document',
  /** Declarative settings: JSON, YAML, TOML, INI, env examples, Dockerfiles. */
  'configuration',
  /** An interface contract: OpenAPI, JSON Schema, GraphQL SDL, protobuf. */
  'schema',
  /** SQL: schemas, migrations, queries. */
  'database',
  /** Produced by a build or a code generator; true, but not authored. */
  'generated',
  /** Third-party code checked into the tree. */
  'vendor',
  /** Not text. Never read. */
  'binary',
  /** Text we can see but have nothing to say about. */
  'unknown',
] as const;

export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
  code: 'Code',
  document: 'Documentation',
  configuration: 'Configuration',
  schema: 'Schema',
  database: 'Database',
  generated: 'Generated',
  vendor: 'Vendor',
  binary: 'Binary',
  unknown: 'Unknown',
};

/**
 * Categories the pipeline extracts knowledge from.
 *
 * `generated`, `vendor`, `binary` and `unknown` are recorded by the scan — the
 * count is a fact about the repository — and are not read.
 */
export const ANALYSABLE_FILE_CATEGORIES: readonly FileCategory[] = [
  'code',
  'document',
  'configuration',
  'schema',
  'database',
];

export function isFileCategory(value: string): value is FileCategory {
  return (FILE_CATEGORIES as readonly string[]).includes(value);
}

export function isAnalysableCategory(category: FileCategory): boolean {
  return ANALYSABLE_FILE_CATEGORIES.includes(category);
}
