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
        ...options.metadata,
        // Last, so the evidence record is authoritative: an analyzer that
        // happens to call one of its own metadata keys `line` or `method`
        // annotates the edge, it does not rewrite the reason for it.
        ...evidenceFields(options.evidence),
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

/**
 * The evidence, flattened onto the edge's metadata.
 *
 * Flattened rather than nested under an `evidence` key because `source` and
 * `confidence` have been top-level since the first migration — the database
 * indexes them there and the API reads them there — and moving them would break
 * every stored graph for no gain. The fields added since sit beside them, and
 * `edgeEvidence()` in `@ckg/shared` is the one reader that knows the layout.
 *
 * Only fields the producer actually recorded are written: an absent line is
 * absent, never zero.
 */
function evidenceFields(evidence: EdgeEvidence): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    source: evidence.source,
    confidence: evidence.confidence,
  };
  if (evidence.method !== undefined) fields.method = evidence.method;
  if (evidence.file !== undefined) fields.file = evidence.file;
  if (evidence.line !== undefined) fields.line = evidence.line;
  if (evidence.column !== undefined) fields.column = evidence.column;
  if (evidence.matched !== undefined) fields.matched = evidence.matched;
  return fields;
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
