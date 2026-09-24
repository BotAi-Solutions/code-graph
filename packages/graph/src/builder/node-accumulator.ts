import type { CodeNode, CodeNodeType } from '@ckg/shared';
import { createNodeId, type GraphIdentityContext } from '../model/identity.js';

export interface AddNodeInput {
  type: CodeNodeType;
  /**
   * The type the identity is hashed with, when it differs from `type`. A
   * variable later recognised as a function keeps the id it had as a
   * variable, so that reclassifying it never renames the node.
   */
  identityType?: CodeNodeType | undefined;
  name: string;
  symbolKey: string;
  qualifiedName?: string | undefined;
  filePath?: string | undefined;
  startLine?: number | undefined;
  startCharacter?: number | undefined;
  endLine?: number | undefined;
  endCharacter?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Collects nodes, keyed by their stable identity. First writer wins, which
 * makes the merge order meaningful: the SCIP layer runs first, so a node an
 * analyzer also happens to describe keeps its compiler-derived form.
 *
 * Later passes add to a node through `enrich`, never by replacing it.
 */
export class NodeAccumulator {
  private readonly nodes = new Map<string, CodeNode>();

  constructor(private readonly context: GraphIdentityContext) {}

  /** The identity `add` would give this input, without creating anything. */
  idFor(input: Pick<AddNodeInput, 'type' | 'identityType' | 'filePath' | 'symbolKey'>): string {
    return createNodeId(this.context, {
      type: input.identityType ?? input.type,
      filePath: input.filePath,
      symbolKey: input.symbolKey,
    });
  }

  add(input: AddNodeInput): CodeNode {
    const id = this.idFor(input);

    const existing = this.nodes.get(id);
    if (existing) return existing;

    const node: CodeNode = {
      id,
      projectId: this.context.projectId,
      type: input.type,
      name: input.name,
    };

    if (input.qualifiedName !== undefined && input.qualifiedName !== input.name) {
      node.qualifiedName = input.qualifiedName;
    }
    if (input.filePath !== undefined) node.filePath = input.filePath;
    if (input.startLine !== undefined) node.startLine = input.startLine;
    if (input.startCharacter !== undefined) node.startCharacter = input.startCharacter;
    if (input.endLine !== undefined) node.endLine = input.endLine;
    if (input.endCharacter !== undefined) node.endCharacter = input.endCharacter;
    if (input.metadata && Object.keys(input.metadata).length > 0) node.metadata = input.metadata;

    this.nodes.set(id, node);
    return node;
  }


  /**
   * Inserts a node that already carries its identity, as the SCIP stage's
   * output does. Never overwrites: the first writer still wins.
   */
  seed(node: CodeNode): void {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node);
  }

  /**
   * Merges metadata into an existing node. Used by analyzers to annotate
   * SCIP-derived nodes — a class learning that it is a NestJS controller —
   * without taking ownership of them. Keys already present are kept, so the
   * earlier, better-evidenced writer wins.
   */
  enrich(nodeId: string, metadata: Record<string, unknown>): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;

    const merged = { ...metadata, ...(node.metadata ?? {}) };
    if (Object.keys(merged).length > 0) node.metadata = merged;
    return true;
  }

  get(id: string): CodeNode | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Sorted by id so the same input always yields the same array. */
  toArray(): CodeNode[] {
    return [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.nodes.size;
  }
}
