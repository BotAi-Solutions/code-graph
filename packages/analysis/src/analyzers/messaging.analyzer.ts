import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerNodeDraft,
  CodeAnalyzer,
  NodeReference,
} from '@ckg/graph';
import { draftRef, nodeRef } from '@ckg/graph';
import type { CodeRelationship, EdgeEvidence } from '@ckg/shared';
import { decoratorsOf, lineOf, ts, walk } from '../source/ast.js';
import { attribute, stringValue, type Resolution } from '../source/resolve.js';
import { moduleSetFor } from '../source/shared.js';
import type { ParsedModule } from '../source/module-set.js';

/**
 * Queues and events: the parts of a system that are invisible in a call graph.
 *
 * Nothing in a call graph shows that one service publishes `user.created` and
 * another handles it, because there is no call — that is exactly why these
 * nodes are worth having. Three forms are recognised, each requiring the
 * library to be in evidence:
 *
 *   BullMQ     `new Queue('emails')` / `new Worker('emails', ...)`
 *   emitter    `emitter.emit('user.created')` where the receiver is declared an
 *              EventEmitter
 *   NestJS     `@OnEvent('user.created')` on a handler method
 *
 * A bare `x.emit('y')` on something we cannot show to be an emitter produces
 * nothing: `emit` is too common a method name to treat as proof.
 */

const EVIDENCE: EdgeEvidence = { source: 'messaging-analyzer', confidence: 'high' };
const CONTAINER_EVIDENCE: EdgeEvidence = { source: 'messaging-analyzer', confidence: 'medium' };

/** Queue libraries, by the constructor names they export. */
const QUEUE_PACKAGES: ReadonlyMap<string, ReadonlyMap<string, 'publish' | 'subscribe'>> = new Map([
  [
    'bullmq',
    new Map([
      ['Queue', 'publish'],
      ['FlowProducer', 'publish'],
      ['Worker', 'subscribe'],
      ['QueueScheduler', 'subscribe'],
    ]),
  ],
  [
    'bull',
    new Map([
      ['Queue', 'publish'],
      ['Bull', 'publish'],
    ]),
  ],
]);

/** Type names that identify an event emitter. */
const EMITTER_TYPES = ['EventEmitter', 'EventEmitter2', 'Emitter'];

/** Emitter methods, by the relationship they express. */
const EMITTER_METHODS: ReadonlyMap<string, CodeRelationship> = new Map([
  ['emit', 'PUBLISHES'],
  ['emitAsync', 'PUBLISHES'],
  ['publish', 'PUBLISHES'],
  ['on', 'SUBSCRIBES'],
  ['once', 'SUBSCRIBES'],
  ['addListener', 'SUBSCRIBES'],
  ['subscribe', 'SUBSCRIBES'],
]);

export class MessagingAnalyzer implements CodeAnalyzer {
  readonly name = 'messaging-analyzer';
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.symbols.size > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const modules = moduleSetFor(context.sources);
    const resolution: Resolution = { symbols: context.symbols, modules };

    const nodes = new Map<string, AnalyzerNodeDraft>();
    const edges: AnalyzerEdgeDraft[] = [];

    const reference = (draft: AnalyzerNodeDraft): NodeReference => {
      nodes.set(draft.symbolKey, nodes.get(draft.symbolKey) ?? draft);
      return draftRef(draft);
    };

    for (const module of modules.modules()) {
      if (!context.symbols.file(module.relativePath)) continue;

      for (const finding of this.findings(resolution, module)) {
        const draft =
          finding.kind === 'queue' ? queueDraft(finding.name) : eventDraft(finding.name);
        const target = reference(draft);

        const { definition, container } = attribute(resolution, module.relativePath, finding.line);

        if (definition) {
          edges.push({
            from: nodeRef(definition.id),
            to: target,
            relationship: finding.relationship,
            evidence: EVIDENCE,
            metadata: { via: finding.via, line: finding.line },
          });
        }

        if (container && container.id !== definition?.id) {
          edges.push({
            from: nodeRef(container.id),
            to: target,
            relationship: finding.relationship,
            evidence: CONTAINER_EVIDENCE,
            metadata: { via: finding.via, line: finding.line, derived: true },
          });
        }
      }
    }

    const queues = [...nodes.values()].filter((node) => node.type === 'queue').length;

    return {
      nodes: [...nodes.values()],
      edges,
      stats: { queueCount: queues, eventCount: nodes.size - queues },
    };
  }

  private findings(resolution: Resolution, module: ParsedModule): Finding[] {
    return [
      ...this.queueFindings(resolution, module),
      ...this.eventFindings(resolution, module),
    ];
  }

  /** `new Queue('emails')` and `new Worker('emails', ...)` from a queue library. */
  private queueFindings(resolution: Resolution, module: ParsedModule): Finding[] {
    const findings: Finding[] = [];

    walk(module.sourceFile, (node) => {
      if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression)) return;

      const binding = module.bindings.get(node.expression.text);
      if (binding?.kind !== 'package') return;

      const constructors = QUEUE_PACKAGES.get(binding.packageName);
      const role = constructors?.get(node.expression.text);
      if (!role) return;

      const name = stringValue(resolution, module, node.arguments?.[0]);
      if (name === null) return;

      findings.push({
        kind: 'queue',
        name,
        relationship: role === 'publish' ? 'PUBLISHES' : 'SUBSCRIBES',
        line: lineOf(module.sourceFile, node),
        via: binding.packageName,
      });
    });

    return findings;
  }

  /** Emitter calls and NestJS `@OnEvent` handlers. */
  private eventFindings(resolution: Resolution, module: ParsedModule): Finding[] {
    const findings: Finding[] = [];
    const emitters = emitterNames(resolution, module);

    walk(module.sourceFile, (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const relationship = EMITTER_METHODS.get(node.expression.name.text);
        if (!relationship) return;

        const receiver = receiverKey(node.expression.expression);
        if (receiver === null || !emitters.has(receiver)) return;

        const name = stringValue(resolution, module, node.arguments[0]);
        if (name === null) return;

        findings.push({
          kind: 'event',
          name,
          relationship,
          line: lineOf(module.sourceFile, node),
          via: 'emitter',
        });
        return;
      }

      if (ts.isMethodDeclaration(node)) {
        for (const decorator of decoratorsOf(node)) {
          if (decorator.name !== 'OnEvent' && decorator.name !== 'EventPattern') continue;

          const binding = module.bindings.get(decorator.name);
          if (binding?.kind !== 'package') continue;

          const name = stringValue(resolution, module, decorator.arguments[0]);
          if (name === null) continue;

          findings.push({
            kind: 'event',
            name,
            relationship: 'SUBSCRIBES',
            line: lineOf(module.sourceFile, node),
            via: binding.packageName,
          });
        }
      }
    });

    return findings;
  }
}

interface Finding {
  kind: 'queue' | 'event';
  name: string;
  relationship: CodeRelationship;
  line: number;
  via: string;
}

/**
 * Names in this module that are event emitters, established from a declared
 * type or a construction — the only two ways to know without a type checker.
 *
 * Imported emitters count too, and matter most: an application with one shared
 * event bus declares it in a module of its own and imports it everywhere, so a
 * publisher and its subscriber are usually in neither that module nor each
 * other's. One import hop is followed to the declaration.
 */
function emitterNames(resolution: Resolution, module: ParsedModule): Set<string> {
  const names = new Set<string>();

  const isEmitterType = (name: string): boolean =>
    EMITTER_TYPES.some((candidate) => name.includes(candidate));

  for (const imported of importedEmitters(resolution, module, isEmitterType)) {
    names.add(imported);
  }

  walk(module.sourceFile, (node) => {
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const typeName = node.type ? typeText(node.type) : null;
      if (typeName !== null && isEmitterType(typeName)) names.add(`this.${node.name.text}`);

      if (node.initializer && ts.isNewExpression(node.initializer)) {
        const constructed = node.initializer.expression;
        if (ts.isIdentifier(constructed) && isEmitterType(constructed.text)) {
          names.add(`this.${node.name.text}`);
        }
      }
      return;
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      const typeName = typeText(node.type);
      if (typeName !== null && isEmitterType(typeName)) {
        // A constructor parameter property is reached as `this.x`; a plain
        // parameter by its own name.
        names.add(`this.${node.name.text}`);
        names.add(node.name.text);
      }
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const declared = node.type ? typeText(node.type) : null;
      if (declared !== null && isEmitterType(declared)) {
        names.add(node.name.text);
        return;
      }
      if (node.initializer && ts.isNewExpression(node.initializer)) {
        const constructed = node.initializer.expression;
        if (ts.isIdentifier(constructed) && isEmitterType(constructed.text)) {
          names.add(node.name.text);
        }
      }
    }
  });

  return names;
}

/** Imported names whose declaration in the target module is an emitter. */
function importedEmitters(
  resolution: Resolution,
  module: ParsedModule,
  isEmitterType: (name: string) => boolean,
): string[] {
  const found: string[] = [];

  walk(module.sourceFile, (node) => {
    if (!ts.isIdentifier(node)) return;

    const binding = module.bindings.get(node.text);
    if (binding?.kind !== 'import') return;

    const target = resolution.modules.module(binding.from);
    if (!target) return;

    const declared = target.bindings.get(binding.exportedName) ?? target.bindings.get(node.text);
    if (declared?.kind === 'instance' && isEmitterType(declared.className)) {
      if (!found.includes(node.text)) found.push(node.text);
    }
  });

  return found;
}

function typeText(type: ts.TypeNode): string | null {
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName;
    return ts.isIdentifier(name) ? name.text : name.right.text;
  }
  return null;
}

function receiverKey(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(expression)) {
    const left = receiverKey(expression.expression);
    return left === null ? null : `${left}.${expression.name.text}`;
  }
  return null;
}

function queueDraft(name: string): AnalyzerNodeDraft {
  return {
    type: 'queue',
    name,
    symbolKey: `queue:${name}`,
    qualifiedName: name,
    metadata: { queue: name },
  };
}

function eventDraft(name: string): AnalyzerNodeDraft {
  return {
    type: 'event',
    name,
    symbolKey: `event:${name}`,
    qualifiedName: name,
    metadata: { event: name },
  };
}
