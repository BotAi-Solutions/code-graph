import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerNodeDraft,
  CodeAnalyzer,
  CodeNode,
  NodeReference,
} from '@ckg/graph';
import { draftRef, nodeRef } from '@ckg/graph';
import { evidence as edgeEvidence, type EdgeEvidence } from '@ckg/shared';
import {
  decoratorsOf,
  lineOf,
  literalText,
  simpleName,
  templateText,
  ts,
  walk,
} from '../source/ast.js';
import { attribute, resolveValueType, type Resolution } from '../source/resolve.js';
import { moduleSetFor } from '../source/shared.js';
import { databaseDraft, tableDraft } from '../source/table-node.js';
import type { ParsedModule } from '../source/module-set.js';
import { findTableReferences, type SqlAccess } from '../detectors/sql.js';
import { detectDatabaseProvider, prismaSchemaOf } from '../detectors/provider.js';
import { clientPropertyFor, PRISMA_METHODS, type PrismaSchema } from '../detectors/prisma.js';

/**
 * The data layer: which tables exist, and who reads and writes them.
 *
 * Three independent detectors, each resting on declarative evidence:
 *
 *   SQL       a statement in a string literal names its table
 *   Prisma    `schema.prisma` declares the provider and every model
 *   ORM       `@Entity('users')` maps a class to a table
 *
 * Each is self-contained, so a repository using one of them gets that one's
 * findings and nothing is inferred from the others' absence. What is
 * deliberately *not* attempted: query builders whose table name arrives as a
 * variable, and anything assembled at runtime. Those produce no edge.
 */

const SQL_EVIDENCE: EdgeEvidence = { source: 'database-analyzer', confidence: 'high' };

/** ORM decorators that map a class to a table, and where the name lives. */
const ENTITY_DECORATORS = new Set(['Entity', 'Table']);

interface TableAccess {
  table: string;
  access: SqlAccess;
  relativePath: string;
  line: number;
  interpolated: boolean;
  detector: 'sql' | 'prisma';
  statement: string;
}

export class DatabaseAnalyzer implements CodeAnalyzer {
  readonly name = 'database-analyzer';
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.symbols.size > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const modules = moduleSetFor(context.sources);
    const resolution: Resolution = { symbols: context.symbols, modules };
    const parsed = [...modules.modules()];

    const schema = prismaSchemaOf(context);
    const provider = detectDatabaseProvider(context, schema);

    const nodes = new Map<string, AnalyzerNodeDraft>();
    const edges: AnalyzerEdgeDraft[] = [];

    const database = provider ? databaseDraft(provider.name, provider.evidence) : null;
    if (database) nodes.set(database.symbolKey, database);

    const tableRef = (table: string): NodeReference => {
      const draft = tableDraft(table, provider?.name ?? null);
      if (!nodes.has(draft.symbolKey)) {
        nodes.set(draft.symbolKey, draft);
        if (database) {
          edges.push({
            from: draftRef(database),
            to: draftRef(draft),
            relationship: 'CONTAINS',
            evidence: SQL_EVIDENCE,
          });
        }
      }
      return draftRef(draft);
    };

    // Tables the schema declares exist whether or not any code touches them.
    for (const model of schema?.models ?? []) {
      const draft = tableDraft(model.table, provider?.name ?? null, {
        model: model.model,
        declaredIn: schema?.relativePath,
      });
      nodes.set(draft.symbolKey, draft);

      if (database) {
        edges.push({
          from: draftRef(database),
          to: draftRef(draft),
          relationship: 'CONTAINS',
          evidence: SQL_EVIDENCE,
        });
      }
    }

    const accesses: TableAccess[] = [];

    for (const module of parsed) {
      if (!context.symbols.file(module.relativePath)) continue;

      accesses.push(...this.sqlAccesses(module));
      if (schema) accesses.push(...this.prismaAccesses(resolution, module, schema));

      edges.push(...this.entityMappings(resolution, module, tableRef));
    }

    let writeCount = 0;
    let readCount = 0;

    for (const access of accesses) {
      const relationship = access.access === 'write' ? 'WRITES_TO' : 'READS_FROM';
      if (access.access === 'write') writeCount += 1;
      else readCount += 1;

      const target = tableRef(access.table);
      const { definition, container } = attribute(resolution, access.relativePath, access.line);

      const observed = edgeEvidence({
        source: 'database-analyzer',
        basis: access.interpolated ? 'interpolatedStatement' : 'sqlLiteral',
        method: 'ast',
        file: access.relativePath,
        line: access.line,
        matched: access.table,
      });
      const metadata = {
        statement: access.statement,
        detector: access.detector,
        ...(access.interpolated ? { interpolated: true } : {}),
      };

      if (definition) {
        edges.push({
          from: nodeRef(definition.id),
          to: target,
          relationship,
          evidence: observed,
          metadata,
        });
      }

      // The owning class reads and writes the same tables its methods do, and
      // that is the altitude the architecture projection shows.
      if (container && container.id !== definition?.id) {
        edges.push({
          from: nodeRef(container.id),
          to: target,
          relationship,
          evidence: edgeEvidence({
            source: 'database-analyzer',
            basis: 'derivedFromContainer',
            method: 'ast',
            file: access.relativePath,
            line: access.line,
            matched: access.table,
          }),
          metadata: { ...metadata, derived: true },
        });
      }
    }

    return {
      nodes: [...nodes.values()],
      edges,
      stats: {
        tableCount: [...nodes.values()].filter((node) => node.type === 'table').length,
        readCount,
        writeCount,
      },
    };
  }

  /** Every SQL statement written as a literal in this module. */
  private sqlAccesses(module: ParsedModule): TableAccess[] {
    const accesses: TableAccess[] = [];

    walk(module.sourceFile, (node) => {
      if (
        !ts.isStringLiteral(node) &&
        !ts.isNoSubstitutionTemplateLiteral(node) &&
        !ts.isTemplateExpression(node)
      ) {
        return;
      }

      const literal = templateText(node);
      if (!literal) return;

      for (const reference of findTableReferences(literal.text)) {
        accesses.push({
          table: reference.table,
          access: reference.access,
          relativePath: module.relativePath,
          line: lineOf(module.sourceFile, node),
          interpolated: literal.interpolated,
          detector: 'sql',
          statement: reference.statement,
        });
      }
    });

    return accesses;
  }

  /**
   * `prisma.user.create(...)`, where `prisma` is a `PrismaClient` and `user` is
   * a model the schema declares. Both halves must hold: an arbitrary
   * `x.user.create()` is not a database access.
   */
  private prismaAccesses(
    resolution: Resolution,
    module: ParsedModule,
    schema: PrismaSchema,
  ): TableAccess[] {
    const tableByProperty = new Map(
      schema.models.map((model) => [clientPropertyFor(model.model), model.table]),
    );

    const accesses: TableAccess[] = [];

    walk(module.sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (!ts.isPropertyAccessExpression(node.expression)) return;

      const access = PRISMA_METHODS.get(node.expression.name.text);
      if (!access) return;

      const modelAccess = node.expression.expression;
      if (!ts.isPropertyAccessExpression(modelAccess)) return;

      const table = tableByProperty.get(modelAccess.name.text);
      if (table === undefined) return;

      if (!isPrismaClient(resolution, module, modelAccess.expression)) return;

      accesses.push({
        table,
        access,
        relativePath: module.relativePath,
        line: lineOf(module.sourceFile, node),
        interpolated: false,
        detector: 'prisma',
        statement: node.expression.name.text,
      });
    });

    return accesses;
  }

  /** `@Entity('users')` on a class: the class is that table's mapping. */
  private entityMappings(
    resolution: Resolution,
    module: ParsedModule,
    tableRef: (table: string) => NodeReference,
  ): AnalyzerEdgeDraft[] {
    const edges: AnalyzerEdgeDraft[] = [];

    for (const statement of module.sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;

      const entity = decoratorsOf(statement).find((decorator) =>
        ENTITY_DECORATORS.has(decorator.name),
      );
      if (!entity) continue;

      const binding = module.bindings.get(entity.name);
      // Only an ORM's decorator counts; a local helper called `Entity` does not.
      if (binding?.kind !== 'package') continue;

      const table = entityTableName(entity.arguments[0]) ?? statement.name.text;
      const classNode = resolution.symbols.declaration(module.relativePath, statement.name.text, [
        'class',
      ]);
      if (!classNode) continue;

      edges.push({
        from: nodeRef(classNode.id),
        to: tableRef(table),
        relationship: 'USES',
        evidence: SQL_EVIDENCE,
        metadata: { mapping: 'entity', orm: binding.packageName },
      });
    }

    return edges;
  }
}

/** `@Entity('users')` or `@Table({ tableName: 'users' })`. */
function entityTableName(argument: ts.Expression | undefined): string | null {
  if (!argument) return null;

  const literal = literalText(argument);
  if (literal !== null) return literal;

  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = simpleName(property.name as ts.Expression);
      if (key !== 'name' && key !== 'tableName') continue;
      return literalText(property.initializer);
    }
  }
  return null;
}

/** Whether an expression is a Prisma client instance. */
function isPrismaClient(
  resolution: Resolution,
  module: ParsedModule,
  expression: ts.Expression,
): boolean {
  const binding =
    module.bindings.get(expressionKey(expression) ?? '') ??
    module.bindings.forExpression(expression);

  if (binding?.kind === 'instance' && binding.className.includes('PrismaClient')) return true;
  if (binding?.kind === 'import' || binding?.kind === 'local') {
    const node: CodeNode | undefined = resolveValueType(resolution, module, expression);
    if (node?.name.includes('PrismaClient')) return true;
  }
  if (binding?.kind === 'call') {
    return binding.calleeName.includes('PrismaClient');
  }
  return false;
}

function expressionKey(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const left = expressionKey(expression.expression);
    return left === null ? null : `${left}.${expression.name.text}`;
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return null;
}
