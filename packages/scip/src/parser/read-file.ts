import { readFile } from 'node:fs/promises';
import { inferDocumentLanguages } from './infer-language.js';
import { parseScipIndex } from './scip-index.js';
import type { ScipIndex } from '../types/index.js';

/**
 * Reads and parses an `index.scip` from disk, with document languages filled
 * in. This is the entry point callers should use; `parseScipIndex` stays a pure
 * decoder over bytes.
 */
export async function readScipIndexFile(indexPath: string): Promise<ScipIndex> {
  const buffer = await readFile(indexPath);
  const index = parseScipIndex(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );
  return inferDocumentLanguages(index);
}
