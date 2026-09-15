import { createHash } from 'node:crypto';
import type { CodeNodeType, CodeRelationship } from '@ckg/shared';

/**
 * Stable graph identity.
 *
 * Node and edge ids are content hashes, never random uuids: analysing the same
 * commit twice must produce the same ids so that selections in the UI survive a
 * re-analysis, caches stay valid, and persistence can be an idempotent replace.
 *
 * The hashed tuple is (scope, node type, file path, symbol key) — exactly the
 * things that identify a piece of code, and nothing that varies between runs.
 */

const ID_LENGTH = 32;

/** NUL cannot occur in a path or a SCIP symbol, so it cannot be spoofed. */
const SEPARATOR = String.fromCharCode(0);

export interface GraphIdentityContext {
  projectId: string;
  /** Scopes ids so a project holding several repositories cannot collide. */
  repositoryId: string;
}

export interface NodeIdentityInput {
  type: CodeNodeType;
  /** Repository-relative POSIX path, when the node belongs to a file. */
  filePath?: string | undefined;
  /**
   * What distinguishes this node within its file: a SCIP symbol string for
   * code symbols, the path itself for files and directories.
   */
  symbolKey: string;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex').slice(0, ID_LENGTH);
}

function scopeOf(context: GraphIdentityContext): string {
  return `${context.projectId}:${context.repositoryId}`;
}

export function createNodeId(context: GraphIdentityContext, input: NodeIdentityInput): string {
  return digest([scopeOf(context), input.type, input.filePath ?? '', input.symbolKey]);
}

export function createEdgeId(
  context: GraphIdentityContext,
  input: { sourceNodeId: string; targetNodeId: string; relationship: CodeRelationship },
): string {
  return digest([
    scopeOf(context),
    'edge',
    input.sourceNodeId,
    input.relationship,
    input.targetNodeId,
  ]);
}
