import type { CodeAnalyzer } from '@ckg/graph';
import { ApiAnalyzer } from './analyzers/api.analyzer.js';
import { ConfigurationAnalyzer } from './analyzers/configuration.analyzer.js';
import { DatabaseAnalyzer } from './analyzers/database.analyzer.js';
import { DocumentAnalyzer } from './analyzers/document.analyzer.js';
import { ExternalServiceAnalyzer } from './analyzers/external-service.analyzer.js';
import { FileAnalyzer } from './analyzers/file.analyzer.js';
import { FrameworkAnalyzer } from './analyzers/framework.analyzer.js';
import { ImportAnalyzer } from './analyzers/import.analyzer.js';
import { MessagingAnalyzer } from './analyzers/messaging.analyzer.js';
import { OpenApiAnalyzer } from './analyzers/openapi.analyzer.js';
import { SqlAnalyzer } from './analyzers/sql.analyzer.js';
import { StructureAnalyzer } from './analyzers/structure.analyzer.js';

/**
 * The repository analyzers, in the order they run.
 *
 * Order matters only within a stage, and only for readability of the merge:
 * identity, not sequence, decides what ends up in the graph. It is fixed rather
 * than incidental so that two runs produce byte-identical output.
 *
 * Stages are declared by the analyzers themselves. The **source** stage reads
 * the repository's own artefacts — its syntax, its configuration, its schema —
 * and resolves them against what SCIP found. The **classification** stage
 * reasons about the graph those produced: which class is a repository, which
 * documented endpoint has a handler, and which name in a README is a symbol.
 * A cross-source link belongs to the later stage by definition, because it
 * needs both sides to exist first.
 */
export function createDefaultAnalyzers(): CodeAnalyzer[] {
  return [
    // source: what the repository says about itself, file by file
    new FileAnalyzer(),
    new ImportAnalyzer(),
    new StructureAnalyzer(),
    new ApiAnalyzer(),
    // Before the database analyzer: both describe the same `table` nodes and
    // the accumulator keeps the first writer's metadata. A migration declares
    // a table's columns and constraints; a SQL statement in a string literal
    // only shows that something touched it, so the declaration goes first.
    new SqlAnalyzer(),
    new DatabaseAnalyzer(),
    new ConfigurationAnalyzer(),
    new ExternalServiceAnalyzer(),
    new MessagingAnalyzer(),

    // classification: what the assembled graph says when read as a whole
    new FrameworkAnalyzer(),
    new OpenApiAnalyzer(),
    new DocumentAnalyzer(),
  ];
}
