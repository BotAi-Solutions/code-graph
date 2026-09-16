import type { CodeAnalyzer } from '@ckg/graph';
import { ApiAnalyzer } from './analyzers/api.analyzer.js';
import { DatabaseAnalyzer } from './analyzers/database.analyzer.js';
import { ExternalServiceAnalyzer } from './analyzers/external-service.analyzer.js';
import { FileAnalyzer } from './analyzers/file.analyzer.js';
import { FrameworkAnalyzer } from './analyzers/framework.analyzer.js';
import { ImportAnalyzer } from './analyzers/import.analyzer.js';
import { MessagingAnalyzer } from './analyzers/messaging.analyzer.js';
import { StructureAnalyzer } from './analyzers/structure.analyzer.js';

/**
 * The source analyzers, in the order they run.
 *
 * Order matters only within a stage, and only for readability of the merge:
 * identity, not sequence, decides what ends up in the graph. It is fixed rather
 * than incidental so that two runs produce byte-identical output.
 *
 * Stages are declared by the analyzers themselves — source analyzers resolve
 * against what SCIP found, and the framework analyzer classifies what all of
 * them found — so the assembler needs no ordering knowledge of its own.
 */
export function createDefaultAnalyzers(): CodeAnalyzer[] {
  return [
    new FileAnalyzer(),
    new ImportAnalyzer(),
    new StructureAnalyzer(),
    new ApiAnalyzer(),
    new DatabaseAnalyzer(),
    new ExternalServiceAnalyzer(),
    new MessagingAnalyzer(),
    new FrameworkAnalyzer(),
  ];
}
