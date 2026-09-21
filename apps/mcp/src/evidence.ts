import { z } from 'zod';
import type { WireEdgeEvidence } from '@ckg/shared';

/**
 * How an edge's evidence is reported, shared by every tool that returns one.
 *
 * Shared rather than repeated because the two tools that render evidence must
 * agree about it: they are answering the same question — *why do you say these
 * two things are connected* — and a reader comparing a `get_node` response with
 * a `trace_path` response should not find the same edge described two ways.
 *
 * An analyzer that could not resolve a reference emits nothing rather than a
 * guess, so an edge that exists has evidence. Reducing it to a relationship
 * name would throw away the graph's main claim to being checkable.
 */

export const evidenceSchema = z.object({
  source: z.string().describe('What observed it: scip, an analyzer name.'),
  confidence: z.string(),
  method: z.string().nullable().describe('The kind of artefact the claim was read out of.'),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  matched: z
    .string()
    .nullable()
    .describe('The entity the producer matched: a table, a route, a name in prose.'),
});

export type Evidence = z.infer<typeof evidenceSchema>;

/** The wire record flattened to all-nullable fields, or null when there is none. */
export function toEvidence(evidence: WireEdgeEvidence | null | undefined): Evidence | null {
  if (!evidence) return null;

  return {
    source: evidence.source,
    confidence: evidence.confidence,
    method: evidence.method ?? null,
    file: evidence.file ?? null,
    line: evidence.line ?? null,
    column: evidence.column ?? null,
    matched: evidence.matched ?? null,
  };
}

/**
 * Where an edge was observed, from whichever coordinates it carries.
 *
 * An analyzer may record a line without a file — the file is implied by the
 * node it was reading — so checking for a file alone would report "no location"
 * about evidence that has one. Real analyzer output does this, which is how the
 * case was found.
 */
export function locationOf(evidence: Pick<Evidence, 'file' | 'line'> | null): string {
  if (!evidence) return 'no location recorded';

  if (evidence.file !== null) {
    return evidence.line === null ? evidence.file : `${evidence.file}:${String(evidence.line)}`;
  }

  return evidence.line === null ? 'no location recorded' : `line ${String(evidence.line)}`;
}
