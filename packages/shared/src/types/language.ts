/**
 * Languages the platform knows about. Only a subset is implemented today; the
 * union is the contract every other package codes against so that adding an
 * indexer later never changes call sites.
 */
export const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'dart',
  'rust',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Languages that currently have a working detector *and* a SCIP indexer. */
export const IMPLEMENTED_LANGUAGES = ['typescript', 'javascript'] as const;

export type ImplementedLanguage = (typeof IMPLEMENTED_LANGUAGES)[number];

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function isImplementedLanguage(value: string): value is ImplementedLanguage {
  return (IMPLEMENTED_LANGUAGES as readonly string[]).includes(value);
}
