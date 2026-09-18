import type { SourceFile, SourceFileSet } from '@ckg/graph';
import { parseJsonDocument } from '../parsers/json-document.js';
import { parseMarkdown, type MarkdownDocument } from '../parsers/markdown.js';
import { parseSqlSchema, type SqlSchema } from '../parsers/sql-schema.js';
import type { StructuredDocument } from '../parsers/structured.js';
import { parseYamlDocument } from '../parsers/yaml-document.js';
import { ModuleSet } from './module-set.js';

/**
 * One parsed view of the repository per analysis run, shared by every analyzer.
 *
 * Keyed on the source set itself, so analyzers need no wiring to cooperate and
 * a second run over a different repository cannot see the first one's trees.
 *
 * Every format gets the same treatment for the same reason: the configuration
 * analyzer and the OpenAPI analyzer both want `openapi.yaml`, and parsing YAML
 * twice would be both slower and — if the two ever disagreed about a parse
 * failure — wrong.
 */

const MODULE_SETS = new WeakMap<SourceFileSet, ModuleSet>();
const STRUCTURED = new WeakMap<SourceFileSet, Map<string, StructuredDocument | null>>();
const MARKDOWN = new WeakMap<SourceFileSet, Map<string, MarkdownDocument>>();
const SQL = new WeakMap<SourceFileSet, Map<string, SqlSchema>>();

export function moduleSetFor(sources: SourceFileSet): ModuleSet {
  const existing = MODULE_SETS.get(sources);
  if (existing) return existing;

  const created = new ModuleSet(sources);
  MODULE_SETS.set(sources, created);
  return created;
}

function cacheFor<T>(
  store: WeakMap<SourceFileSet, Map<string, T>>,
  sources: SourceFileSet,
): Map<string, T> {
  const existing = store.get(sources);
  if (existing) return existing;

  const created = new Map<string, T>();
  store.set(sources, created);
  return created;
}

/**
 * A JSON or YAML file, parsed into the structured model.
 *
 * Returns null for a file the set does not hold or whose extension is neither,
 * and a document carrying an `error` for one that would not parse — which is a
 * fact about the repository, not a failure of the run.
 */
export function structuredDocumentFor(
  sources: SourceFileSet,
  relativePath: string,
): StructuredDocument | null {
  const cache = cacheFor(STRUCTURED, sources);

  const cached = cache.get(relativePath);
  if (cached !== undefined) return cached;

  const file = sources.byPath(relativePath);
  const parsed = file ? parseStructured(file) : null;
  cache.set(relativePath, parsed);
  return parsed;
}

function parseStructured(file: SourceFile): StructuredDocument | null {
  const lower = file.relativePath.toLowerCase();

  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
    return parseJsonDocument(file.relativePath, file.text);
  }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return parseYamlDocument(file.relativePath, file.text);
  }
  return null;
}

export function markdownDocumentFor(
  sources: SourceFileSet,
  relativePath: string,
): MarkdownDocument | null {
  const file = sources.byPath(relativePath);
  if (!file) return null;

  const cache = cacheFor(MARKDOWN, sources);
  const cached = cache.get(relativePath);
  if (cached) return cached;

  const parsed = parseMarkdown(relativePath, file.text);
  cache.set(relativePath, parsed);
  return parsed;
}

export function sqlSchemaFor(sources: SourceFileSet, relativePath: string): SqlSchema | null {
  const file = sources.byPath(relativePath);
  if (!file) return null;

  const cache = cacheFor(SQL, sources);
  const cached = cache.get(relativePath);
  if (cached) return cached;

  const parsed = parseSqlSchema(relativePath, file.text);
  cache.set(relativePath, parsed);
  return parsed;
}
