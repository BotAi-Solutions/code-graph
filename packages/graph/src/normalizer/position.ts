import type { ScipRange } from '@ckg/scip';

/** Zero-based position inside a document, as SCIP reports it. */
export interface Position {
  line: number;
  character: number;
}

export function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

export function rangeContains(range: ScipRange, position: Position): boolean {
  const start: Position = { line: range.startLine, character: range.startCharacter };
  const end: Position = { line: range.endLine, character: range.endCharacter };
  return comparePositions(start, position) <= 0 && comparePositions(position, end) <= 0;
}

/** Number of lines a range spans; used to pick the innermost of two scopes. */
export function rangeSize(range: ScipRange): number {
  return (range.endLine - range.startLine) * 10_000 + (range.endCharacter - range.startCharacter);
}
