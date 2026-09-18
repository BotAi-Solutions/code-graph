import { LineCounter, parseDocument, isMap, isSeq, isScalar as isYamlScalar } from 'yaml';
import type { Node as YamlNode } from 'yaml';
import type {
  StructuredDocument,
  StructuredEntry,
  StructuredNode,
  StructuredPosition,
} from './structured.js';

/**
 * YAML, mapped onto the same structured model as JSON.
 *
 * A real YAML parser rather than a line reader, because YAML is not a line
 * format: anchors, block scalars, flow collections and multi-document streams
 * all look like ordinary lines and are not. `yaml` is the one dependency added
 * for this, and it stops here — its `Document` never leaves this file.
 *
 * Only the **first** document of a multi-document stream is converted, and the
 * fact is recorded. A compose file or a workflow is one document; a Kubernetes
 * manifest with six `---` separators is six resources, and pretending the first
 * one is the file would be a quiet lie. The configuration analyzer reads that
 * flag and says so rather than claiming to have read everything.
 */

export interface YamlParseResult extends StructuredDocument {
  format: 'yaml';
  /** How many documents the stream held. More than one means only the first was read. */
  documentCount: number;
}

export function parseYamlDocument(relativePath: string, text: string): YamlParseResult {
  const empty: YamlParseResult = {
    relativePath,
    format: 'yaml',
    root: null,
    error: null,
    documentCount: 0,
  };

  if (text.trim().length === 0) return empty;

  const counter = new LineCounter();

  let parsed;
  try {
    parsed = parseDocument(text, {
      lineCounter: counter,
      keepSourceTokens: false,
      // A repository is allowed to contain a YAML file with a duplicate key or
      // a tag we do not know; neither is a reason to refuse the whole file.
      uniqueKeys: false,
      logLevel: 'silent',
    });
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }

  const fatal = parsed.errors[0];
  if (fatal) {
    return { ...empty, error: `${fatal.message} (line ${String(lineOf(counter, fatal.pos[0]).line)})` };
  }

  const documentCount = countDocuments(text);
  const contents = parsed.contents;
  if (!contents) return { ...empty, documentCount };

  return {
    relativePath,
    format: 'yaml',
    root: convert(contents as YamlNode, counter, 0),
    error: null,
    documentCount,
  };
}

/**
 * Documents in the stream.
 *
 * Counted from the separators rather than by parsing every document, because
 * the count exists only to tell the caller that reading one was not reading
 * all of them.
 */
function countDocuments(text: string): number {
  const separators = text.split('\n').filter((line) => /^---\s*$/.test(line)).length;
  // A leading `---` opens the first document rather than separating two.
  const leading = /^---\s*$/m.test(text.split('\n')[0] ?? '') ? 1 : 0;
  return Math.max(1, separators + 1 - leading);
}

const MAX_DEPTH = 64;

function lineOf(counter: LineCounter, offset: number | undefined): StructuredPosition {
  if (offset === undefined) return { line: 1, column: 0 };
  const position = counter.linePos(offset);
  return { line: position.line, column: Math.max(0, position.col - 1) };
}

function convert(node: YamlNode, counter: LineCounter, depth: number): StructuredNode {
  const start = lineOf(counter, node.range?.[0]);

  if (depth > MAX_DEPTH) return { kind: 'null', ...start, value: null };

  if (isMap(node)) {
    const entries: StructuredEntry[] = [];

    for (const item of node.items) {
      const key = keyText(item.key);
      if (key === null) continue;

      const keyPosition = isYamlScalar(item.key)
        ? lineOf(counter, item.key.range?.[0])
        : start;

      entries.push({
        key,
        keyPosition,
        value:
          item.value === null || item.value === undefined
            ? { kind: 'null', ...keyPosition, value: null }
            : convert(item.value as YamlNode, counter, depth + 1),
      });
    }

    return { kind: 'object', ...start, entries };
  }

  if (isSeq(node)) {
    const items = node.items
      .filter((item): item is YamlNode => item !== null && typeof item === 'object')
      .map((item) => convert(item, counter, depth + 1));

    return { kind: 'array', ...start, items };
  }

  if (isYamlScalar(node)) {
    const value: unknown = node.value;

    if (value === null || value === undefined) return { kind: 'null', ...start, value: null };
    if (typeof value === 'boolean') return { kind: 'boolean', ...start, value };
    if (typeof value === 'number') return { kind: 'number', ...start, value };
    if (typeof value === 'string') return { kind: 'string', ...start, value };
    // A date, or a tagged value we have no model for: keep it as its text.
    return { kind: 'string', ...start, value: String(value) };
  }

  // An alias whose anchor was resolved elsewhere, or a node kind added to YAML
  // since: recorded as absent rather than guessed at.
  return { kind: 'null', ...start, value: null };
}

/** A mapping key, when it is a scalar. A complex key is skipped, not guessed. */
function keyText(key: unknown): string | null {
  if (isYamlScalar(key)) {
    const value: unknown = key.value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return null;
}
