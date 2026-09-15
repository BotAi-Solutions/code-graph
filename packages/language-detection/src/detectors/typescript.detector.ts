import type { LanguageDetector, LanguageEvidence, RepositoryScan } from '../types/index.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

/** A tsconfig is decisive: it is what the SCIP indexer is driven by. */
const TSCONFIG_SCORE = 50;
const DECLARATION_SCORE = 5;

export class TypeScriptDetector implements LanguageDetector {
  readonly language = 'typescript' as const;

  detect(scan: RepositoryScan): LanguageEvidence | null {
    const markers: string[] = [];
    let score = 0;

    const sourceFileCount = SOURCE_EXTENSIONS.reduce(
      (total, extension) => total + (scan.extensionCounts.get(extension) ?? 0),
      0,
    );

    if (sourceFileCount > 0) {
      score += sourceFileCount;
      markers.push(`${sourceFileCount} TypeScript source file(s)`);
    }

    const hasTsconfig = [...scan.rootFiles].some(
      (file) => file === 'tsconfig.json' || (file.startsWith('tsconfig.') && file.endsWith('.json')),
    );
    if (hasTsconfig) {
      score += TSCONFIG_SCORE;
      markers.push('tsconfig.json');
    }

    const declarationCount = scan.extensionCounts.get('.d.ts') ?? 0;
    if (declarationCount > 0) {
      score += DECLARATION_SCORE;
      markers.push(`${declarationCount} declaration file(s)`);
    }

    // A tsconfig with no compilable sources is not a TypeScript repository.
    if (sourceFileCount === 0) return null;

    return { language: this.language, score, markers, sourceFileCount };
  }
}
