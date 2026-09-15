import type { CodeEdge, CodeRelationship } from '@ckg/shared';
import { createEdgeId, type GraphIdentityContext } from '../model/identity.js';

/**
 * Collects edges, collapsing duplicates by identity while counting how many
 * source-level occurrences produced each one. Deduplication has to happen here
 * rather than at the end so that `metadata.occurrences` stays accurate.
 */
export class EdgeAccumulator {
  private readonly edges = new Map<string, CodeEdge>();

  constructor(private readonly context: GraphIdentityContext) {}

  add(
    sourceNodeId: string,
    relationship: CodeRelationship,
    targetNodeId: string,
    metadata: Record<string, unknown> = {},
  ): CodeEdge {
    const id = createEdgeId(this.context, { sourceNodeId, targetNodeId, relationship });

    const existing = this.edges.get(id);
    if (existing) {
      const count = Number(existing.metadata?.occurrences ?? 1) + 1;
      existing.metadata = { ...existing.metadata, occurrences: count };
      return existing;
    }

    const edge: CodeEdge = {
      id,
      projectId: this.context.projectId,
      sourceNodeId,
      targetNodeId,
      relationship,
      metadata: { occurrences: 1, ...metadata },
    };
    this.edges.set(id, edge);
    return edge;
  }

  has(sourceNodeId: string, relationship: CodeRelationship, targetNodeId: string): boolean {
    return this.edges.has(createEdgeId(this.context, { sourceNodeId, targetNodeId, relationship }));
  }

  /** Sorted by id so the same input always yields the same array. */
  toArray(): CodeEdge[] {
    return [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.edges.size;
  }
}
