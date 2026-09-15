import { createDefaultDetectors } from './detectors/index.js';
import { scanRepository, type ScanOptions } from './scan.js';
import type {
  LanguageDetectionResult,
  LanguageDetector,
  LanguageEvidence,
  RepositoryScan,
} from './types/index.js';

export interface DetailedLanguageDetectionResult extends LanguageDetectionResult {
  /** Per-language evidence, strongest first. Useful in logs and job records. */
  evidence: LanguageEvidence[];
  scanTruncated: boolean;
}

/**
 * Runs every registered detector against a single filesystem scan and ranks the
 * results. Injecting detectors keeps this testable without touching disk.
 */
export class LanguageDetectionService {
  private readonly detectors: LanguageDetector[];

  constructor(detectors: LanguageDetector[] = createDefaultDetectors()) {
    this.detectors = detectors;
  }

  detectFromScan(scan: RepositoryScan): DetailedLanguageDetectionResult {
    const evidence = this.detectors
      .map((detector) => detector.detect(scan))
      .filter((item): item is LanguageEvidence => item !== null)
      .sort((a, b) => b.score - a.score || a.language.localeCompare(b.language));

    const languages = evidence.map((item) => item.language);
    const primary = evidence[0]?.language;

    return {
      languages,
      ...(primary ? { primaryLanguage: primary } : {}),
      evidence,
      scanTruncated: scan.truncated,
    };
  }

  async detect(
    repositoryPath: string,
    options: ScanOptions = {},
  ): Promise<DetailedLanguageDetectionResult> {
    const scan = await scanRepository(repositoryPath, options);
    return this.detectFromScan(scan);
  }
}

/** Convenience wrapper for callers that do not need to inject detectors. */
export async function detectLanguages(
  repositoryPath: string,
  options: ScanOptions = {},
): Promise<DetailedLanguageDetectionResult> {
  return new LanguageDetectionService().detect(repositoryPath, options);
}
