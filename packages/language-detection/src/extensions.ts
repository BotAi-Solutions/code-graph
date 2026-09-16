import type { SupportedLanguage } from '@ckg/shared';

/**
 * File-extension to language mapping. Kept beside the detectors because it is
 * the same knowledge, used per-file rather than per-repository: SCIP indexers
 * do not always populate `Document.language`, so consumers infer it from the
 * path instead.
 */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, SupportedLanguage> = new Map([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.d.ts', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.pyi', 'python'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.dart', 'dart'],
  ['.rs', 'rust'],
]);

export function languageFromPath(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.d.ts')) return 'typescript';
  const index = lower.lastIndexOf('.');
  if (index <= 0) return null;
  return LANGUAGE_BY_EXTENSION.get(lower.slice(index)) ?? null;
}

/**
 * The per-file language question, under the name the rest of the system asks it
 * by. Identical to `languageFromPath`; a second name because "what language is
 * this file" is the abstraction callers depend on, and the fact that today it is
 * answered from the extension alone is an implementation detail that a content
 * sniffer or a shebang reader could later replace without a single call site
 * changing.
 *
 * Returns null for a file type we do not support, which callers must treat as
 * "skip this file", never as a failure.
 */
export const detectLanguage = languageFromPath;
