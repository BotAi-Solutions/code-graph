/**
 * One model for every structured configuration format.
 *
 * JSON and YAML are two spellings of the same thing, and every consumer
 * downstream — the configuration analyzer, the OpenAPI extractor, the compose
 * reader — wants the same four questions answered: what keys are here, what are
 * their values, in what order were they written, and on which line. So both
 * parsers produce this, and nothing outside `parsers/` ever sees a `yaml`
 * `Document` or a raw JSON token.
 *
 * Positions are carried on every node because an edge without a location is an
 * edge nobody can check. Lines are 1-based and columns are 0-based, matching
 * how the rest of the graph records a range.
 */

export const STRUCTURED_KINDS = [
  'object',
  'array',
  'string',
  'number',
  'boolean',
  'null',
] as const;

export type StructuredKind = (typeof STRUCTURED_KINDS)[number];

export type StructuredScalar = string | number | boolean | null;

export interface StructuredPosition {
  /** 1-based, as an editor counts. */
  line: number;
  /** 0-based, as every editor API expects. */
  column: number;
}

export interface StructuredEntry {
  key: string;
  /** Where the *key* is written, which is what a config property points at. */
  keyPosition: StructuredPosition;
  value: StructuredNode;
}

export interface StructuredNode extends StructuredPosition {
  kind: StructuredKind;
  /** Set for the four scalar kinds; absent for objects and arrays. */
  value?: StructuredScalar;
  /** Members in document order. Only for `object`. */
  entries?: StructuredEntry[];
  /** Items in document order. Only for `array`. */
  items?: StructuredNode[];
}

export interface StructuredDocument {
  relativePath: string;
  format: 'json' | 'yaml';
  /** Null when the document could not be parsed, or is empty. */
  root: StructuredNode | null;
  /** The parse failure, if there was one. Never the file's contents. */
  error: string | null;
}

// --- reading ---------------------------------------------------------------

/** The member under `key`, or undefined. Objects only; never throws. */
export function member(node: StructuredNode | undefined, key: string): StructuredNode | undefined {
  if (node?.kind !== 'object') return undefined;
  return node.entries?.find((entry) => entry.key === key)?.value;
}

/** The entry under `key`, when the key's own position is what is wanted. */
export function entryOf(
  node: StructuredNode | undefined,
  key: string,
): StructuredEntry | undefined {
  if (node?.kind !== 'object') return undefined;
  return node.entries?.find((entry) => entry.key === key);
}

/** Walks a dotted path: `at(root, 'compilerOptions', 'strict')`. */
export function at(
  node: StructuredNode | undefined,
  ...keys: string[]
): StructuredNode | undefined {
  let current = node;
  for (const key of keys) {
    current = member(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

export function asString(node: StructuredNode | undefined): string | null {
  return node?.kind === 'string' && typeof node.value === 'string' ? node.value : null;
}

export function asNumber(node: StructuredNode | undefined): number | null {
  return node?.kind === 'number' && typeof node.value === 'number' ? node.value : null;
}

export function asBoolean(node: StructuredNode | undefined): boolean | null {
  return node?.kind === 'boolean' && typeof node.value === 'boolean' ? node.value : null;
}

/**
 * The value as text, whatever scalar kind it is.
 *
 * Configuration is full of values that are a number in one file and a quoted
 * string in another — a port, a version, a replica count — and a consumer that
 * cared about the difference would be reading the format rather than the
 * configuration.
 */
export function asScalarText(node: StructuredNode | undefined): string | null {
  if (node === undefined) return null;
  switch (node.kind) {
    case 'string':
      return typeof node.value === 'string' ? node.value : null;
    case 'number':
    case 'boolean':
      return String(node.value);
    default:
      return null;
  }
}

export function isScalar(node: StructuredNode): boolean {
  return node.kind !== 'object' && node.kind !== 'array';
}

/** Object member keys in document order, or an empty list. */
export function keysOf(node: StructuredNode | undefined): string[] {
  if (node?.kind !== 'object') return [];
  return (node.entries ?? []).map((entry) => entry.key);
}

/** Array items, or an empty list. */
export function itemsOf(node: StructuredNode | undefined): StructuredNode[] {
  if (node?.kind !== 'array') return [];
  return node.items ?? [];
}

/** An array of strings, ignoring any item that is not one. */
export function stringItems(node: StructuredNode | undefined): string[] {
  return itemsOf(node)
    .map((item) => asString(item))
    .filter((value): value is string => value !== null);
}

// --- flattening ------------------------------------------------------------

export interface StructuredPath {
  /** Dotted path from the root: `services.api.image`. Array indices included. */
  path: string;
  /** How deep the path is; the root's own members are depth 1. */
  depth: number;
  node: StructuredNode;
  /** Where the key that names this value is written. */
  keyPosition: StructuredPosition;
}

export interface FlattenOptions {
  /** Paths deeper than this are not produced. */
  maxDepth?: number;
  /** Stops after this many paths, so a huge file cannot flood a caller. */
  maxPaths?: number;
  /** Only leaves (scalars and empty containers) are produced. */
  scalarsOnly?: boolean;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_PATHS = 2_000;

/**
 * Every addressable path in a document, in document order.
 *
 * Bounded twice on purpose — by depth and by count — because this is the one
 * function in the configuration layer that could, unguarded, turn a 4 MB
 * Kubernetes manifest into forty thousand graph nodes. The caller that decides
 * what is worth promoting is the one that sets the bounds.
 */
export function flatten(
  root: StructuredNode | null,
  options: FlattenOptions = {},
): StructuredPath[] {
  if (!root) return [];

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const scalarsOnly = options.scalarsOnly ?? false;

  const found: StructuredPath[] = [];

  const visit = (node: StructuredNode, prefix: string, depth: number, key: StructuredPosition) => {
    if (found.length >= maxPaths) return;

    if (depth > 0) {
      const leaf = isScalar(node) || emptyContainer(node);
      if (!scalarsOnly || leaf) {
        found.push({ path: prefix, depth, node, keyPosition: key });
      }
    }
    if (depth >= maxDepth) return;

    if (node.kind === 'object') {
      for (const entry of node.entries ?? []) {
        visit(
          entry.value,
          prefix === '' ? entry.key : `${prefix}.${entry.key}`,
          depth + 1,
          entry.keyPosition,
        );
      }
      return;
    }

    if (node.kind === 'array') {
      (node.items ?? []).forEach((item, index) => {
        visit(item, `${prefix}[${String(index)}]`, depth + 1, {
          line: item.line,
          column: item.column,
        });
      });
    }
  };

  visit(root, '', 0, { line: root.line, column: root.column });
  return found;
}

function emptyContainer(node: StructuredNode): boolean {
  if (node.kind === 'object') return (node.entries ?? []).length === 0;
  if (node.kind === 'array') return (node.items ?? []).length === 0;
  return false;
}

/** The plain JavaScript value a node stands for. For tests and metadata. */
export function toPlain(node: StructuredNode | null | undefined): unknown {
  if (!node) return undefined;
  switch (node.kind) {
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const entry of node.entries ?? []) result[entry.key] = toPlain(entry.value);
      return result;
    }
    case 'array':
      return (node.items ?? []).map((item) => toPlain(item));
    default:
      return node.value;
  }
}
