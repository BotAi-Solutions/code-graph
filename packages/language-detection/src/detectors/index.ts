import type { LanguageDetector } from '../types/index.js';
import { JavaScriptDetector } from './javascript.detector.js';
import { TypeScriptDetector } from './typescript.detector.js';

export { JavaScriptDetector } from './javascript.detector.js';
export { TypeScriptDetector } from './typescript.detector.js';

/**
 * Detectors implemented today. Adding Python, Go, Java, Dart or Rust means
 * adding a class here — no call site changes.
 */
export function createDefaultDetectors(): LanguageDetector[] {
  return [new TypeScriptDetector(), new JavaScriptDetector()];
}
