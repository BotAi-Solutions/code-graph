import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_LEVELS,
  CONFIDENCE_POLICY,
  CONFIDENCE_SCORES,
  EVIDENCE_METHODS,
  EVIDENCE_SOURCES,
  confidenceOf,
  confidenceScore,
  edgeEvidence,
  evidence,
  isEmittable,
  type ConfidenceBasis,
} from '@ckg/shared';

/**
 * The confidence policy exists so that "medium" means one thing across twelve
 * analyzers. These tests are what stop it from drifting back into twelve
 * opinions.
 */

describe('the policy', () => {
  it('assigns every basis a level from the shared vocabulary', () => {
    for (const [basis, level] of Object.entries(CONFIDENCE_POLICY)) {
      expect(CONFIDENCE_LEVELS).toContain(level);
      expect(confidenceOf(basis as ConfidenceBasis)).toBe(level);
    }
  });

  it('reserves high for a fact the artefact states outright', () => {
    for (const basis of [
      'scipSymbol',
      'astDirect',
      'declaredInSpec',
      'sqlLiteral',
      'exactRouteMatch',
    ] as const) {
      expect(confidenceOf(basis)).toBe('high');
    }
  });

  it('reserves medium for an observation that needed a resolution step', () => {
    for (const basis of [
      'derivedFromContainer',
      'interpolatedStatement',
      'undeclaredDependency',
      'uniqueNameMatch',
    ] as const) {
      expect(confidenceOf(basis)).toBe('medium');
    }
  });

  it('names the case it refuses, and refuses it', () => {
    expect(confidenceOf('ambiguousNameMatch')).toBe('low');
    expect(isEmittable('ambiguousNameMatch')).toBe(false);
    expect(isEmittable('uniqueNameMatch')).toBe(true);
  });

  it('has exactly three scores, ordered', () => {
    expect(Object.keys(CONFIDENCE_SCORES).sort()).toEqual([...CONFIDENCE_LEVELS].sort());
    expect(confidenceScore('high')).toBeGreaterThan(confidenceScore('medium'));
    expect(confidenceScore('medium')).toBeGreaterThan(confidenceScore('low'));
  });
});

describe('building evidence', () => {
  it('derives the level from the basis rather than taking one', () => {
    expect(evidence({ source: 'sql-analyzer', basis: 'sqlLiteral' })).toEqual({
      source: 'sql-analyzer',
      confidence: 'high',
    });
  });

  it('records only the location fields the producer actually knew', () => {
    const found = evidence({
      source: 'document-analyzer',
      basis: 'uniqueNameMatch',
      method: 'markdown',
      file: 'README.md',
      line: 12,
      matched: 'AuthService',
    });

    expect(found).toEqual({
      source: 'document-analyzer',
      confidence: 'medium',
      method: 'markdown',
      file: 'README.md',
      line: 12,
      matched: 'AuthService',
    });
    expect(found).not.toHaveProperty('column');
  });

  it('only accepts a source and a method from the vocabulary', () => {
    for (const source of EVIDENCE_SOURCES) {
      expect(evidence({ source, basis: 'astDirect' }).source).toBe(source);
    }
    for (const method of EVIDENCE_METHODS) {
      expect(evidence({ source: 'scip', basis: 'scipSymbol', method }).method).toBe(method);
    }
  });
});

describe('reading evidence back off an edge', () => {
  it('reads every field the producer wrote', () => {
    expect(
      edgeEvidence({
        metadata: {
          source: 'openapi-analyzer',
          confidence: 'high',
          method: 'openapi',
          file: 'openapi.yaml',
          line: 15,
          column: 4,
          matched: 'POST /users',
          occurrences: 2,
        },
      }),
    ).toEqual({
      source: 'openapi-analyzer',
      confidence: 'high',
      method: 'openapi',
      file: 'openapi.yaml',
      line: 15,
      column: 4,
      matched: 'POST /users',
    });
  });

  it('returns null for an edge no known analyzer claims', () => {
    expect(edgeEvidence({ metadata: {} })).toBeNull();
    expect(edgeEvidence({})).toBeNull();
    expect(edgeEvidence({ metadata: { source: 'a-future-analyzer' } })).toBeNull();
  });

  it('defaults a missing confidence to high rather than dropping the edge', () => {
    // An edge recorded before confidence existed is still a compiler fact; the
    // alternative is discarding it, which loses more than it protects.
    expect(edgeEvidence({ metadata: { source: 'scip' } })).toEqual({
      source: 'scip',
      confidence: 'high',
    });
  });

  it('ignores a method or a confidence that is not in the vocabulary', () => {
    const found = edgeEvidence({
      metadata: { source: 'scip', confidence: 'certain', method: 'telepathy' },
    });

    expect(found?.confidence).toBe('high');
    expect(found?.method).toBeUndefined();
  });

  it('round-trips what `evidence` produced', () => {
    const built = evidence({
      source: 'configuration-analyzer',
      basis: 'declaredInSpec',
      method: 'yaml',
      file: 'docker-compose.yml',
      line: 4,
      matched: 'postgres',
    });

    expect(edgeEvidence({ metadata: { ...built, occurrences: 1 } })).toEqual(built);
  });
});
