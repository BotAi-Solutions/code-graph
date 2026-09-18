import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODE_NODE_TYPES,
  CODE_RELATIONSHIPS,
  CONFIDENCE_LEVELS,
  EVIDENCE_METHODS,
  EVIDENCE_SOURCES,
  type CodeNodeType,
  type CodeRelationship,
  type ConfidenceLevel,
  type EvidenceMethod,
  type EvidenceSource,
} from '@ckg/shared';

/**
 * The ground truth: what a human read in the fixture and asserts the graph
 * should contain.
 *
 * Written as JSON and addressed by **type and qualified name**, never by node
 * id. Ids are content hashes of a project and repository scope, so a ground
 * truth written in ids would be unreadable, unreviewable, and invalid the
 * moment the fixture is analysed under a different project.
 *
 * Every entry is a claim someone checked against the fixture's source. When the
 * benchmark and the ground truth disagree, exactly one of them is wrong and the
 * point of the exercise is to find out which.
 */

export const GROUND_TRUTH_DIR = fileURLToPath(new URL('../ground-truth', import.meta.url));

export interface ExpectedNode {
  type: CodeNodeType;
  /** `qualifiedName` when the node has one, otherwise `name`. */
  name: string;
  /** Asserted when present: the repository-relative path the node reports. */
  file?: string;
  /** Why this node is expected. Documentation for the reviewer, not a check. */
  note?: string;
}

export interface ExpectedEndpoint {
  type: CodeNodeType;
  name: string;
}

export interface ExpectedEdge {
  from: ExpectedEndpoint;
  relationship: CodeRelationship;
  to: ExpectedEndpoint;
  /** Asserted when present: the confidence the policy should have produced. */
  confidence?: ConfidenceLevel;
  /** Asserted when present: which analyzer and which kind of artefact. */
  evidence?: {
    source?: EvidenceSource;
    method?: EvidenceMethod;
    file?: string;
    /** True when the edge must carry a line number. */
    located?: boolean;
  };
  note?: string;
}

export interface ExpectedPath {
  /** A name for the trace, printed in the report: "API to storage". */
  name: string;
  from: ExpectedEndpoint;
  to: ExpectedEndpoint;
  /** The route must be found within this many hops. */
  maxDepth: number;
  /**
   * Restricts the search to these relationships.
   *
   * A constraint on the question, not a check on the answer: "is there a route
   * from the contract to the table made only of implementation and call and
   * write edges" is a claim about the repository, while "the shortest route
   * happened to use these" is a claim about the search.
   */
  viaRelationships?: CodeRelationship[];
  /** Asserted when present: node types the route must pass through, in order. */
  through?: ExpectedEndpoint[];
  note?: string;
}

export interface GroundTruth {
  fixture: string;
  /**
   * Node types the ground truth enumerates completely. Anything the pipeline
   * produces in one of these and the ground truth does not list is a false
   * positive; for every other type only recall is measured.
   */
  closedNodeTypes: CodeNodeType[];
  nodes: ExpectedNode[];
  /** Relationships the ground truth enumerates completely. */
  closedRelationships: CodeRelationship[];
  edges: ExpectedEdge[];
  paths: ExpectedPath[];
}

/** How a node is addressed in ground truth, and matched in the graph. */
export function nodeKey(entry: { type: string; name: string }): string {
  return `${entry.type}|${entry.name}`;
}

export function edgeKey(entry: ExpectedEdge): string {
  return `${nodeKey(entry.from)} -${entry.relationship}-> ${nodeKey(entry.to)}`;
}

export class GroundTruthError extends Error {}

/**
 * Loads and validates a fixture's ground truth.
 *
 * Validated hard, because a typo in a node type would otherwise show up as a
 * recall failure and be blamed on the pipeline. Anything that is not a term
 * from the shared vocabulary is a broken dataset, not a finding.
 */
export async function loadGroundTruth(
  fixture: string,
  directory: string = GROUND_TRUTH_DIR,
): Promise<GroundTruth> {
  const base = path.join(directory, fixture);

  const [nodesFile, edgesFile, pathsFile] = await Promise.all([
    readJson(path.join(base, 'nodes.json')),
    readJson(path.join(base, 'edges.json')),
    readJson(path.join(base, 'paths.json')),
  ]);

  const closedNodeTypes = nodeTypeList(nodesFile.closedTypes, 'nodes.json closedTypes');
  const nodes = (asArray(nodesFile.nodes, 'nodes.json nodes') as ExpectedNode[]).map(
    (entry, index) => {
      assertNodeType(entry.type, `nodes.json nodes[${String(index)}]`);
      assertString(entry.name, `nodes.json nodes[${String(index)}].name`);
      return entry;
    },
  );

  const closedRelationships = relationshipList(
    edgesFile.closedRelationships,
    'edges.json closedRelationships',
  );
  const edges = (asArray(edgesFile.edges, 'edges.json edges') as ExpectedEdge[]).map(
    (entry, index) => {
      const where = `edges.json edges[${String(index)}]`;
      assertEndpoint(entry.from, `${where}.from`);
      assertEndpoint(entry.to, `${where}.to`);
      assertRelationship(entry.relationship, where);
      if (entry.confidence !== undefined) {
        assertMember(entry.confidence, CONFIDENCE_LEVELS, `${where}.confidence`);
      }
      if (entry.evidence?.source !== undefined) {
        assertMember(entry.evidence.source, EVIDENCE_SOURCES, `${where}.evidence.source`);
      }
      if (entry.evidence?.method !== undefined) {
        assertMember(entry.evidence.method, EVIDENCE_METHODS, `${where}.evidence.method`);
      }
      return entry;
    },
  );

  const paths = (asArray(pathsFile.paths, 'paths.json paths') as ExpectedPath[]).map(
    (entry, index) => {
      const where = `paths.json paths[${String(index)}]`;
      assertEndpoint(entry.from, `${where}.from`);
      assertEndpoint(entry.to, `${where}.to`);
      assertString(entry.name, `${where}.name`);
      for (const relationship of entry.viaRelationships ?? []) {
        assertRelationship(relationship, `${where}.viaRelationships`);
      }
      for (const step of entry.through ?? []) assertEndpoint(step, `${where}.through`);
      return entry;
    },
  );

  const fixtureName = asString(nodesFile.fixture, 'nodes.json fixture');
  if (fixtureName !== fixture) {
    throw new GroundTruthError(
      `ground truth in ${base} declares fixture "${fixtureName}" but was loaded as "${fixture}"`,
    );
  }

  // A duplicate expectation would count twice in recall and make the numbers
  // quietly wrong, which is the one thing a benchmark may not be.
  assertUnique(nodes.map(nodeKey), 'nodes.json');
  assertUnique(edges.map(edgeKey), 'edges.json');

  return { fixture, closedNodeTypes, nodes, closedRelationships, edges, paths };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new GroundTruthError(`ground truth file is missing: ${file}`);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new GroundTruthError(
      `ground truth file is not valid JSON: ${file} — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new GroundTruthError(`${where} must be an array`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new GroundTruthError(`${where} must be a string`);
  return value;
}

function assertString(value: unknown, where: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GroundTruthError(`${where} must be a non-empty string`);
  }
}

function assertMember(value: unknown, allowed: readonly string[], where: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new GroundTruthError(`${where} must be one of: ${allowed.join(', ')} (got ${String(value)})`);
  }
}

function assertNodeType(value: unknown, where: string): void {
  assertMember(value, CODE_NODE_TYPES, `${where}.type`);
}

function assertRelationship(value: unknown, where: string): void {
  assertMember(value, CODE_RELATIONSHIPS, `${where}.relationship`);
}

function assertEndpoint(value: unknown, where: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new GroundTruthError(`${where} must be an object with a type and a name`);
  }
  const endpoint = value as ExpectedEndpoint;
  assertMember(endpoint.type, CODE_NODE_TYPES, `${where}.type`);
  assertString(endpoint.name, `${where}.name`);
}

function nodeTypeList(value: unknown, where: string): CodeNodeType[] {
  return asArray(value, where).map((entry) => {
    assertMember(entry, CODE_NODE_TYPES, where);
    return entry as CodeNodeType;
  });
}

function relationshipList(value: unknown, where: string): CodeRelationship[] {
  return asArray(value, where).map((entry) => {
    assertMember(entry, CODE_RELATIONSHIPS, where);
    return entry as CodeRelationship;
  });
}

function assertUnique(keys: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new GroundTruthError(`${where} lists ${key} twice`);
    seen.add(key);
  }
}
