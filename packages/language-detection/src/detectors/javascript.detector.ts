import type { LanguageDetector, LanguageEvidence, RepositoryScan } from '../types/index.js';

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'] as const;

const PACKAGE_JSON_SCORE = 20;
const JSCONFIG_SCORE = 15;

export class JavaScriptDetector implements LanguageDetector {
  readonly language = 'javascript' as const;

  detect(scan: RepositoryScan): LanguageEvidence | null {
    const markers: string[] = [];
    let score = 0;

    const sourceFileCount = SOURCE_EXTENSIONS.reduce(
      (total, extension) => total + (scan.extensionCounts.get(extension) ?? 0),
      0,
    );

    if (sourceFileCount === 0) return null;

    score += sourceFileCount;
    markers.push(`${sourceFileCount} JavaScript source file(s)`);

    if (scan.rootFiles.has('package.json')) {
      score += PACKAGE_JSON_SCORE;
      markers.push('package.json');
    }

    if (scan.rootFiles.has('jsconfig.json')) {
      score += JSCONFIG_SCORE;
      markers.push('jsconfig.json');
    }

    return { language: this.language, score, markers, sourceFileCount };
  }
}
