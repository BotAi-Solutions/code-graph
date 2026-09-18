import type { FileCategory, SupportedLanguage } from '@ckg/shared';
import { languageFromPath } from './extensions.js';

/**
 * What kind of file this is, decided from its path alone.
 *
 * Path-only is a deliberate constraint, not a shortcut. The scan is one walk
 * with no file reads — that is what lets a 25,000-file repository be sized up
 * in a second — so classification here must be answerable from the name. A
 * `.yaml` file is `configuration` until something reads it and finds an
 * `openapi:` key, at which point the OpenAPI analyzer refines it to `schema`
 * and records that it did. The scanner never guesses at contents.
 *
 * Classification is *orthogonal* to language detection and does not replace it:
 * `vite.config.ts` is category `code`, language `typescript`, role
 * `tooling-config`. All three are recorded, and the existing language detectors
 * are untouched.
 */

/**
 * A recognised job a file does, where the name says so unambiguously.
 *
 * Roles are deliberately few. Each one exists because some analyzer changes
 * what it does when it sees it — there is no role here that nothing consumes.
 */
export const FILE_ROLES = [
  'readme',
  'documentation',
  'package-manifest',
  'typescript-config',
  'javascript-config',
  'tooling-config',
  'dockerfile',
  'compose',
  'ci-workflow',
  'env-example',
  'env',
  'api-spec',
  'json-schema',
  'migration',
  'sql-schema',
  'lockfile',
] as const;

export type FileRole = (typeof FILE_ROLES)[number];

export interface FileClassification {
  /** Repository-relative POSIX path, exactly as the scan recorded it. */
  path: string;
  /** Basename. */
  name: string;
  /** Lower-cased extension including the dot, `.d.ts` treated as one. */
  extension: string | null;
  category: FileCategory;
  /** Null for a file in no language the platform knows. */
  language: SupportedLanguage | null;
  role: FileRole | null;
}

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.pyi',
  '.go',
  '.java',
  '.dart',
  '.rs',
]);

const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.rst', '.adoc']);

const CONFIGURATION_EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.properties',
  '.editorconfig',
]);

/** Contracts. A `.json`/`.yaml` holding one is refined by whoever reads it. */
const SCHEMA_EXTENSIONS = new Set(['.graphql', '.gql', '.proto', '.prisma', '.avsc']);

const DATABASE_EXTENSIONS = new Set(['.sql', '.ddl', '.psql']);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.icns', '.svgz',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.wasm', '.so', '.dylib', '.dll', '.exe', '.bin', '.dat', '.db', '.sqlite',
  '.class', '.pyc', '.o', '.a', '.node', '.scip',
]);

/** Files whose whole name identifies them, with the category and role implied. */
const BY_FILENAME: ReadonlyMap<string, { category: FileCategory; role: FileRole }> = new Map([
  ['package.json', { category: 'configuration', role: 'package-manifest' }],
  ['tsconfig.json', { category: 'configuration', role: 'typescript-config' }],
  ['jsconfig.json', { category: 'configuration', role: 'javascript-config' }],
  ['dockerfile', { category: 'configuration', role: 'dockerfile' }],
  ['containerfile', { category: 'configuration', role: 'dockerfile' }],
  ['docker-compose.yml', { category: 'configuration', role: 'compose' }],
  ['docker-compose.yaml', { category: 'configuration', role: 'compose' }],
  ['compose.yml', { category: 'configuration', role: 'compose' }],
  ['compose.yaml', { category: 'configuration', role: 'compose' }],
  ['procfile', { category: 'configuration', role: 'tooling-config' }],
  ['makefile', { category: 'configuration', role: 'tooling-config' }],
]);

/** Lock files: enormous, generated, and silent about the code. */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pubspec.lock',
  'cargo.lock',
  'go.sum',
]);

/** Specification documents, by the names the ecosystem has settled on. */
const API_SPEC_STEMS = new Set(['openapi', 'swagger', 'asyncapi', 'api']);

/** Directory segments that mean "not authored here". */
const VENDOR_SEGMENTS = new Set(['vendor', 'third_party', 'thirdparty', 'external', 'node_modules']);
const GENERATED_SEGMENTS = new Set(['generated', '__generated__', '.generated', 'gen']);

const GENERATED_SUFFIXES = [
  '.generated.ts',
  '.generated.js',
  '.gen.ts',
  '.gen.go',
  '.pb.go',
  '.pb.ts',
  '_pb2.py',
  '.min.js',
  '.min.css',
  '.snap',
  '.map',
  '.tsbuildinfo',
];

/** Returns the lower-cased extension, treating `.d.ts` as its own extension. */
export function extensionOfName(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.d.ts')) return '.d.ts';
  const index = lower.lastIndexOf('.');
  if (index <= 0) return null;
  return lower.slice(index);
}

/**
 * Classifies one repository-relative path.
 *
 * Total: every path gets a category, and the fallback is `unknown` rather than
 * an exception — a repository is allowed to contain anything, and the walk must
 * not stop because it found a `.fortran`.
 *
 * Order matters and is the point. Vendored and generated win over everything,
 * because a generated TypeScript file is not code anyone wrote; then the exact
 * filename, which is how `package.json` beats "a JSON file"; then the role
 * patterns; then the extension.
 */
export function classifyFile(relativePath: string): FileClassification {
  const posix = relativePath.replaceAll('\\', '/');
  const cut = posix.lastIndexOf('/');
  const name = cut === -1 ? posix : posix.slice(cut + 1);
  const lowerName = name.toLowerCase();
  const lowerPath = posix.toLowerCase();
  const extension = extensionOfName(name);
  const language = languageFromPath(posix);

  const base = (category: FileCategory, role: FileRole | null): FileClassification => ({
    path: posix,
    name,
    extension,
    category,
    // Language travels with the file whatever its category, so a generated
    // `.ts` still reports `typescript`; what changes is whether it is read.
    language,
    role,
  });

  if (LOCKFILES.has(lowerName)) return base('generated', 'lockfile');

  const segments = lowerPath.split('/').slice(0, -1);
  if (segments.some((segment) => VENDOR_SEGMENTS.has(segment))) return base('vendor', null);
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) return base('generated', null);
  if (GENERATED_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))) {
    return base('generated', null);
  }

  if (extension !== null && BINARY_EXTENSIONS.has(extension)) return base('binary', null);

  const byName = BY_FILENAME.get(lowerName);
  if (byName) return base(byName.category, byName.role);

  // `.env` and its examples. The example is parsed; the live file never is,
  // which is enforced separately by the source loader — this only names it.
  if (lowerName.startsWith('.env') || lowerName === 'env.example') {
    return base('configuration', isExampleEnv(lowerName) ? 'env-example' : 'env');
  }

  // `Dockerfile.dev`, `Dockerfile.prod`.
  if (lowerName.startsWith('dockerfile')) return base('configuration', 'dockerfile');

  if (lowerName.startsWith('tsconfig.') && lowerName.endsWith('.json')) {
    return base('configuration', 'typescript-config');
  }

  if (DOCUMENT_EXTENSIONS.has(extension ?? '')) {
    return base('document', lowerName.startsWith('readme.') ? 'readme' : 'documentation');
  }

  if (DATABASE_EXTENSIONS.has(extension ?? '')) {
    return base('database', migrationRole(segments, lowerName));
  }

  if (SCHEMA_EXTENSIONS.has(extension ?? '')) return base('schema', null);

  // A specification written as JSON or YAML. Named, not sniffed: `openapi.yaml`
  // and `api.schema.json` say what they are. Anything else stays
  // `configuration` until an analyzer reads it and refines it.
  const specRole = specRoleOf(lowerName, extension);
  if (specRole) return base('schema', specRole);

  if (CONFIGURATION_EXTENSIONS.has(extension ?? '')) {
    return base('configuration', workflowRole(segments, extension));
  }

  if (CODE_EXTENSIONS.has(extension ?? '')) return base('code', toolingRole(posix, lowerName));

  // Extensionless text at the root that the ecosystem treats as a document.
  if (extension === null && (lowerName === 'readme' || lowerName === 'license')) {
    return base('document', lowerName === 'readme' ? 'readme' : 'documentation');
  }

  return base('unknown', null);
}

const EXAMPLE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.defaults', '.dist'];

function isExampleEnv(lowerName: string): boolean {
  if (lowerName === 'env.example') return true;
  return EXAMPLE_ENV_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
}

function migrationRole(segments: readonly string[], lowerName: string): FileRole {
  if (segments.includes('migrations') || segments.includes('migration')) return 'migration';
  if (lowerName.startsWith('schema.') || lowerName === 'schema.sql') return 'sql-schema';
  return 'sql-schema';
}

function specRoleOf(lowerName: string, extension: string | null): FileRole | null {
  if (extension !== '.json' && extension !== '.yaml' && extension !== '.yml') return null;

  const stem = lowerName.slice(0, lowerName.length - (extension?.length ?? 0));
  if (API_SPEC_STEMS.has(stem)) return 'api-spec';
  // `openapi.v3.yaml`, `swagger-public.json`.
  if (stem.startsWith('openapi') || stem.startsWith('swagger') || stem.startsWith('asyncapi')) {
    return 'api-spec';
  }
  if (stem.endsWith('.schema') || stem.endsWith('-schema') || stem.endsWith('.jsonschema')) {
    return 'json-schema';
  }
  return null;
}

/** A YAML file under a CI directory is a workflow, whatever it is called. */
function workflowRole(segments: readonly string[], extension: string | null): FileRole | null {
  if (extension !== '.yaml' && extension !== '.yml') return null;

  const joined = `/${segments.join('/')}/`;
  if (
    joined.includes('/.github/workflows/') ||
    joined.includes('/.gitlab/') ||
    joined.includes('/.circleci/') ||
    joined.includes('/.buildkite/')
  ) {
    return 'ci-workflow';
  }
  if (segments.includes('.github') && segments.includes('workflows')) return 'ci-workflow';
  return null;
}

const TOOLING_SUFFIXES = ['.config.ts', '.config.js', '.config.mjs', '.config.cjs'];

/**
 * `*.config.*` is a tool's configuration only at the repository root, which is
 * where every tool looks for it. `src/config/app.config.ts` is a module that
 * reads configuration — ordinary code. This mirrors the rule the file analyzer
 * already applies, so the two cannot disagree.
 */
function toolingRole(posix: string, lowerName: string): FileRole | null {
  const atRoot = !posix.includes('/');
  if (!atRoot) return null;
  return TOOLING_SUFFIXES.some((suffix) => lowerName.endsWith(suffix)) ? 'tooling-config' : null;
}
