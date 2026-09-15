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
