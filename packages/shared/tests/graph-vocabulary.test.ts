import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURAL_NODE_TYPES,
  ARCHITECTURAL_RELATIONSHIPS,
  CODE_NODE_TYPES,
  CODE_RELATIONSHIPS,
  CONFIDENCE_LEVELS,
  CORE_CODE_NODE_TYPES,
  CORE_CODE_RELATIONSHIPS,
  DEFAULT_GRAPH_PROJECTION_ID,
  EVIDENCE_SOURCES,
  FAMILIES_BY_CATEGORY,
  GRAPH_PROJECTIONS,
  NODE_CATEGORY_BY_FAMILY,
  NODE_FAMILIES,
  NODE_FAMILY_BY_TYPE,
  NODE_FAMILY_LABELS,
  NODE_TYPE_LABELS,
  REPOSITORY_NODE_TYPES,
  REPOSITORY_RELATIONSHIPS,
  RELATIONSHIPS_BY_GROUP,
  RELATIONSHIP_GROUPS,
  RELATIONSHIP_GROUP_BY_RELATIONSHIP,
  RELATIONSHIP_GROUP_LABELS,
  edgeEvidence,
  graphProjection,
  isArchitecturalNodeType,
  isRepositoryNodeType,
  isCodeNodeType,
  isCodeRelationship,
} from '@ckg/shared';

/**
 * The vocabulary is the contract every layer codes against, so the invariants
 * that keep it usable — every type has a family, a label and a shape to draw —
 * are asserted here rather than discovered as a missing legend entry later.
 */
describe('node types', () => {
  it('is the core types plus the architectural and repository ones, with no duplicates', () => {
    expect(CODE_NODE_TYPES).toEqual([
      ...CORE_CODE_NODE_TYPES,
      ...ARCHITECTURAL_NODE_TYPES,
      ...REPOSITORY_NODE_TYPES,
    ]);
    expect(new Set(CODE_NODE_TYPES).size).toBe(CODE_NODE_TYPES.length);
  });

  it('keeps the original ten types, so an existing graph still validates', () => {
    for (const type of [
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
    ]) {
      expect(isCodeNodeType(type)).toBe(true);
    }
  });

  it('assigns every type to exactly one family and one label', () => {
    for (const type of CODE_NODE_TYPES) {
      expect(NODE_FAMILY_BY_TYPE[type]).toBeDefined();
      expect(NODE_FAMILIES).toContain(NODE_FAMILY_BY_TYPE[type]);
      expect(NODE_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it('separates code, architectural and repository families', () => {
    for (const type of ARCHITECTURAL_NODE_TYPES) {
      expect(isArchitecturalNodeType(type)).toBe(true);
      expect(NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE[type]]).toBe('architecture');
    }
    for (const type of CORE_CODE_NODE_TYPES) {
      expect(NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE[type]]).toBe('code');
    }
    for (const type of REPOSITORY_NODE_TYPES) {
      expect(isRepositoryNodeType(type)).toBe(true);
    }
  });

  it('keeps provenance and display as separate axes, on purpose', () => {
    // A repository-provenance type is not automatically a `knowledge` one to
    // look at: `api_endpoint` is read from a specification and belongs beside
    // the routes, `column` is read from a migration and belongs beside its
    // table. Pinned here because the temptation to "fix" the mismatch is real
    // and acting on it would make one of the two axes wrong.
    expect(NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE.api_endpoint]).toBe('architecture');
    expect(NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE.column]).toBe('architecture');
    expect(NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE.document]).toBe('knowledge');
    expect(NODE_CATEGORY_BY_FAMILY[NODE_FAMILY_BY_TYPE.config]).toBe('knowledge');

    // Every family under `knowledge` holds only repository-provenance types,
    // which is the direction of the implication that does hold.
    for (const family of FAMILIES_BY_CATEGORY.knowledge) {
      for (const type of CODE_NODE_TYPES) {
        if (NODE_FAMILY_BY_TYPE[type] !== family) continue;
        expect(isRepositoryNodeType(type)).toBe(true);
      }
    }
  });

  it('keeps the three groups disjoint', () => {
    const groups = [CORE_CODE_NODE_TYPES, ARCHITECTURAL_NODE_TYPES, REPOSITORY_NODE_TYPES];

    for (const [index, group] of groups.entries()) {
      for (const type of group) {
        const elsewhere = groups
          .filter((_, other) => other !== index)
          .some((other) => (other as readonly string[]).includes(type));
        expect(elsewhere).toBe(false);
      }
    }
  });

  it('lists every family under exactly one category, and labels each', () => {
    const listed = [
      ...FAMILIES_BY_CATEGORY.code,
      ...FAMILIES_BY_CATEGORY.architecture,
      ...FAMILIES_BY_CATEGORY.knowledge,
    ];

    expect([...listed].sort()).toEqual([...NODE_FAMILIES].sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const family of NODE_FAMILIES) expect(NODE_FAMILY_LABELS[family]).toBeTruthy();
  });
});

describe('relationships', () => {
  it('is the core relationships plus the architectural and repository ones', () => {
    expect(CODE_RELATIONSHIPS).toEqual([
      ...CORE_CODE_RELATIONSHIPS,
      ...ARCHITECTURAL_RELATIONSHIPS,
      ...REPOSITORY_RELATIONSHIPS,
    ]);
    expect(new Set(CODE_RELATIONSHIPS).size).toBe(CODE_RELATIONSHIPS.length);
  });

  it('keeps the original six, so an existing graph still validates', () => {
    for (const relationship of [
      'CONTAINS',
      'IMPORTS',
      'CALLS',
      'REFERENCES',
      'IMPLEMENTS',
      'EXTENDS',
    ]) {
      expect(isCodeRelationship(relationship)).toBe(true);
    }
  });

  it('assigns every relationship to exactly one group', () => {
    for (const relationship of CODE_RELATIONSHIPS) {
      const group = RELATIONSHIP_GROUP_BY_RELATIONSHIP[relationship];
      expect(RELATIONSHIP_GROUPS).toContain(group);
      expect(RELATIONSHIPS_BY_GROUP[group]).toContain(relationship);
    }
  });

  it('lists every relationship exactly once across the groups', () => {
    const listed = RELATIONSHIP_GROUPS.flatMap((group) => RELATIONSHIPS_BY_GROUP[group]);

    expect([...listed].sort()).toEqual([...CODE_RELATIONSHIPS].sort());
    for (const group of RELATIONSHIP_GROUPS) expect(RELATIONSHIP_GROUP_LABELS[group]).toBeTruthy();
  });
});

describe('projections', () => {
  it('only names types and relationships that exist', () => {
    for (const projection of GRAPH_PROJECTIONS) {
      for (const type of [...projection.nodeTypes, ...projection.priorityNodeTypes]) {
        expect(CODE_NODE_TYPES).toContain(type);
      }
      for (const relationship of projection.relationships) {
        expect(CODE_RELATIONSHIPS).toContain(relationship);
      }
    }
  });

  it('preserves the four views the UI has always had', () => {
    const ids = GRAPH_PROJECTIONS.map((projection) => projection.id);
    expect(ids).toEqual(
      expect.arrayContaining(['everything', 'architecture', 'calls', 'files']),
    );
  });

  it('leaves "everything" unfiltered', () => {
    const everything = graphProjection('everything');
    expect(everything.nodeTypes).toEqual([]);
    expect(everything.relationships).toEqual([]);
  });

  it('shows APIs and data stores in the architecture projection', () => {
    const architecture = graphProjection('architecture');

    for (const type of ['api', 'service', 'database', 'table', 'external_service']) {
      expect(architecture.nodeTypes).toContain(type);
    }
    expect(architecture.relationships).toContain('ROUTES_TO');
    // Low-level noise is excluded on purpose.
    expect(architecture.nodeTypes).not.toContain('variable');
    expect(architecture.relationships).not.toContain('REFERENCES');
  });

  it('restricts the call graph to callables and CALLS', () => {
    expect(graphProjection('calls').relationships).toEqual(['CALLS']);
  });

  it('opens on a projection that exists', () => {
    expect(() => graphProjection(DEFAULT_GRAPH_PROJECTION_ID)).not.toThrow();
  });

  it('rejects an unknown projection rather than returning an empty one', () => {
    // @ts-expect-error -- deliberately outside the union
    expect(() => graphProjection('nope')).toThrow(/unknown graph projection/);
  });
});

describe('evidence', () => {
  it('reads the source and confidence an edge was recorded with', () => {
    expect(edgeEvidence({ metadata: { source: 'scip', confidence: 'high' } })).toEqual({
      source: 'scip',
      confidence: 'high',
    });
  });

  it('defaults a recognised source with no level to high', () => {
    expect(edgeEvidence({ metadata: { source: 'api-analyzer' } })).toEqual({
      source: 'api-analyzer',
      confidence: 'high',
    });
  });

  it('reports nothing for an edge with no evidence, rather than inventing some', () => {
    expect(edgeEvidence({ metadata: { occurrences: 2 } })).toBeNull();
    expect(edgeEvidence({})).toBeNull();
    expect(edgeEvidence({ metadata: { source: 'hearsay' } })).toBeNull();
  });

  it('orders confidence from low to high', () => {
    expect(CONFIDENCE_LEVELS).toEqual(['high', 'medium', 'low']);
    expect(EVIDENCE_SOURCES).toContain('scip');
  });
});
