import type { SupportedLanguage } from '../../../types/index.js';

/**
 * How languages are named and ordered in the UI.
 *
 * The wire values are lower-case identifiers — `typescript`, not `TypeScript` —
 * because they are part of a contract, not a label. Turning them into something
 * to read happens here, once, so the selected-project card and the statistics
 * panel cannot disagree about what a language is called or which comes first.
 */

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  go: 'Go',
  java: 'Java',
  dart: 'Dart',
  rust: 'Rust',
};

export interface LanguageCount {
  language: SupportedLanguage;
  files: number;
}

/**
 * Languages present, most source files first, ties broken by name so the order
 * is stable between renders and between runs.
 */
export function rankLanguages(
  languages: Partial<Record<SupportedLanguage, number>> | undefined,
): LanguageCount[] {
  if (!languages) return [];

  return Object.entries(languages)
    .map(([language, files]) => ({ language: language as SupportedLanguage, files }))
    .filter((entry) => entry.files > 0)
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}
