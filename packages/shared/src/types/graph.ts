/**
 * Transport-level shape of the code knowledge graph.
 *
 * These types describe what crosses the API boundary. The richer domain model
 * (builders, traversal, identity rules) lives in `@ckg/graph` and is defined in
 * terms of these same unions so there is exactly one vocabulary.
 */

export const CODE_NODE_TYPES = [
  'repository',
  'directory',
  'file',
  'module',
  'class',
  'interface',
  'function',
  'method',
  'variable',
  'type',
] as const;

export type CodeNodeType = (typeof CODE_NODE_TYPES)[number];

export const CODE_RELATIONSHIPS = [
  'CONTAINS',
  'IMPORTS',
  'CALLS',
  'REFERENCES',
  'IMPLEMENTS',
  'EXTENDS',
] as const;

export type CodeRelationship = (typeof CODE_RELATIONSHIPS)[number];

export interface CodeNode {
  id: string;
  projectId: string;
  type: CodeNodeType;
  name: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

export interface CodeEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationship: CodeRelationship;
  metadata?: Record<string, unknown>;
}

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export function isCodeNodeType(value: string): value is CodeNodeType {
  return (CODE_NODE_TYPES as readonly string[]).includes(value);
}

export function isCodeRelationship(value: string): value is CodeRelationship {
  return (CODE_RELATIONSHIPS as readonly string[]).includes(value);
}
