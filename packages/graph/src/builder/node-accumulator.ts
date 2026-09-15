import type { CodeNode, CodeNodeType } from '@ckg/shared';
import { createNodeId, type GraphIdentityContext } from '../model/identity.js';

export interface AddNodeInput {
  type: CodeNodeType;
  name: string;
  symbolKey: string;
  filePath?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** Collects nodes, keyed by their stable identity. First writer wins. */
export class NodeAccumulator {
  private readonly nodes = new Map<string, CodeNode>();

  constructor(private readonly context: GraphIdentityContext) {}

  add(input: AddNodeInput): CodeNode {
    const id = createNodeId(this.context, {
      type: input.type,
      filePath: input.filePath,
      symbolKey: input.symbolKey,
    });

    const existing = this.nodes.get(id);
    if (existing) return existing;

    const node: CodeNode = {
      id,
      projectId: this.context.projectId,
      type: input.type,
      name: input.name,
    };

    if (input.filePath !== undefined) node.filePath = input.filePath;
    if (input.startLine !== undefined) node.startLine = input.startLine;
    if (input.endLine !== undefined) node.endLine = input.endLine;
    if (input.metadata && Object.keys(input.metadata).length > 0) node.metadata = input.metadata;

    this.nodes.set(id, node);
    return node;
  }

  get(id: string): CodeNode | undefined {
    return this.nodes.get(id);
  }

  /** Sorted by id so the same input always yields the same array. */
  toArray(): CodeNode[] {
    return [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.nodes.size;
  }
}
