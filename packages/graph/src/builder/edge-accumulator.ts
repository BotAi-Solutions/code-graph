import type { CodeEdge, CodeRelationship, EdgeEvidence } from '@ckg/shared';
import { createEdgeId, type GraphIdentityContext } from '../model/identity.js';

export interface AddEdgeOptions {
  /**
   * What observed this relationship, and how much the observer trusts it.
   * Required: an edge without evidence is exactly the kind of speculative
   * relationship the graph must not contain.
   */
  evidence: EdgeEvidence;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Collects edges, collapsing duplicates by identity while counting how many
 * source-level occurrences produced each one. Deduplication has to happen here
 * rather than at the end so that `metadata.occurrences` stays accurate.
 *
 * When two sources observe the same relationship the stronger evidence wins:
 * a SCIP-derived `CALLS` is not downgraded because an analyzer saw it too.
 */
export class EdgeAccumulator {
  private readonly edges = new Map<string, CodeEdge>();

  constructor(private readonly context: GraphIdentityContext) {}

  add(
    sourceNodeId: string,
    relationship: CodeRelationship,
    targetNodeId: string,
    options: AddEdgeOptions,
  ): CodeEdge {
    const id = createEdgeId(this.context, { sourceNodeId, targetNodeId, relationship });

    const existing = this.edges.get(id);
    if (existing) {
      const count = Number(existing.metadata?.occurrences ?? 1) + 1;
      existing.metadata = {
        ...existing.metadata,
        occurrences: count,
        ...(outranks(options.evidence, existing) ? evidenceFields(options.evidence) : {}),
      };
      return existing;
    }

    const edge: CodeEdge = {
      id,
      projectId: this.context.projectId,
      sourceNodeId,
      targetNodeId,
      relationship,
      metadata: {
        occurrences: 1,
        ...evidenceFields(options.evidence),
        ...options.metadata,
      },
    };
    this.edges.set(id, edge);
    return edge;
  }

  /** Inserts an edge that already carries its identity. Never overwrites. */
  seed(edge: CodeEdge): void {
    if (!this.edges.has(edge.id)) this.edges.set(edge.id, edge);
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

function evidenceFields(evidence: EdgeEvidence): Record<string, unknown> {
  return { source: evidence.source, confidence: evidence.confidence };
}

const CONFIDENCE_RANK: Record<EdgeEvidence['confidence'], number> = { low: 0, medium: 1, high: 2 };

function outranks(candidate: EdgeEvidence, existing: CodeEdge): boolean {
  const current = existing.metadata?.confidence;
  const currentRank =
    typeof current === 'string' && current in CONFIDENCE_RANK
      ? CONFIDENCE_RANK[current as EdgeEvidence['confidence']]
      : -1;
  return CONFIDENCE_RANK[candidate.confidence] > currentRank;
}
