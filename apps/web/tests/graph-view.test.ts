import { describe, expect, it } from 'vitest';
import { CODE_NODE_TYPES, CODE_RELATIONSHIPS } from '@ckg/shared';
import type { CodeEdge, CodeGraph, CodeNode } from '../src/types/index.js';
import { mergeGraphs, newNodeCount } from '../src/features/code-graph/merge-graph.js';
import {
  DEFAULT_PRESET_ID,
  VIEW_PRESETS,
  matchPreset,
  presetById,
} from '../src/features/code-graph/view-presets.js';
import {
  LABELLED_RELATIONSHIPS,
  NODE_SHAPES,
  NODE_SIZES,
  TYPES_BY_FAMILY,
  nodeColor,
  nodeFullName,
  nodeLabel,
  relationshipColor,
} from '../src/features/code-graph/graph-style.js';

/**
 * The view logic that has no DOM in it: what the canvas is handed, and what it
 * is drawn with. Both are pure, both are where a mistake would be silent, and
 * neither needs a browser to check.
 */

const node = (id: string, type: CodeNode['type'], name = id): CodeNode => ({
  id,
  projectId: 'p1',
  type,
  name,
});

const edge = (id: string, source: string, target: string): CodeEdge => ({
  id,
  projectId: 'p1',
  sourceNodeId: source,
  targetNodeId: target,
  relationship: 'CALLS',
});

describe('mergeGraphs', () => {
  const base: CodeGraph = {
    nodes: [node('a', 'class'), node('b', 'class')],
    edges: [edge('a-b', 'a', 'b')],
  };

  it('returns the base view unchanged when nothing is expanded', () => {
    expect(mergeGraphs(base)).toEqual(base);
  });

  it('adds the nodes and edges an expansion brought in', () => {
    const expansion: CodeGraph = {
      nodes: [node('b', 'class'), node('c', 'class')],
      edges: [edge('b-c', 'b', 'c')],
    };

    const merged = mergeGraphs(base, expansion);

    expect(merged.nodes.map((item) => item.id).sort()).toEqual(['a', 'b', 'c']);
    expect(merged.edges.map((item) => item.id).sort()).toEqual(['a-b', 'b-c']);
  });

  it('is idempotent: merging the same expansion twice changes nothing', () => {
    const expansion: CodeGraph = { nodes: [node('c', 'class')], edges: [] };

    expect(mergeGraphs(base, expansion, expansion)).toEqual(mergeGraphs(base, expansion));
  });

  it('keeps the first version of a node seen, so the base view wins', () => {
    const renamed: CodeGraph = { nodes: [node('a', 'class', 'Renamed')], edges: [] };

    expect(mergeGraphs(base, renamed).nodes.find((item) => item.id === 'a')?.name).toBe('a');
  });

  it('drops an edge whose endpoints are not both present', () => {
    // A capped neighbourhood can return an edge to a node that was cut, and
    // Cytoscape throws on one of those rather than skipping it.
    const partial: CodeGraph = { nodes: [], edges: [edge('a-z', 'a', 'z')] };

    expect(mergeGraphs(base, partial).edges.map((item) => item.id)).toEqual(['a-b']);
  });

  it('ignores absent expansions', () => {
    expect(mergeGraphs(base, null, undefined)).toEqual(base);
  });

  it('counts how many nodes an expansion would actually add', () => {
    const expansion: CodeGraph = {
      nodes: [node('b', 'class'), node('c', 'class'), node('d', 'class')],
      edges: [],
    };

    expect(newNodeCount(base, expansion)).toBe(2);
  });
});

describe('view presets', () => {
  it('are the server’s projections, not a second definition of them', () => {
    const preset = presetById('architecture');

    expect(preset.nodeTypes).toContain('api');
    expect(preset.relationships).toContain('ROUTES_TO');
  });

  it('keeps the four views the toolbar has always had, and adds two', () => {
    expect(VIEW_PRESETS.map((preset) => preset.label)).toEqual([
      'Everything',
      'Architecture',
      'Call graph',
      'Files',
      'Dependencies',
      'Data flow',
    ]);
  });

  it('opens on architecture', () => {
    expect(DEFAULT_PRESET_ID).toBe('architecture');
  });

  it('recognises filters that match a projection, and those that do not', () => {
    const architecture = presetById('architecture');

    expect(matchPreset(architecture.nodeTypes, architecture.relationships)).toBe('architecture');
    expect(matchPreset([], [])).toBe('everything');
    expect(matchPreset(['class'], ['CALLS'])).toBeNull();
  });
});

describe('the visual language', () => {
  it('gives every node type a colour, a shape and a size', () => {
    for (const type of CODE_NODE_TYPES) {
      expect(nodeColor(type)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(NODE_SHAPES[type]).toBeTruthy();
      expect(NODE_SIZES[type]).toBeGreaterThan(0);
    }
  });

  it('gives every relationship a colour', () => {
    for (const relationship of CODE_RELATIONSHIPS) {
      expect(relationshipColor(relationship)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('lists every node type in exactly one family, so the legend is complete', () => {
    const listed = Object.values(TYPES_BY_FAMILY).flat();

    expect([...listed].sort()).toEqual([...CODE_NODE_TYPES].sort());
  });

  it('gives the architectural types shapes no code type uses', () => {
    const codeShapes = new Set(
      [...TYPES_BY_FAMILY.types, ...TYPES_BY_FAMILY.callables, ...TYPES_BY_FAMILY.data, ...TYPES_BY_FAMILY.structure].map(
        (type) => NODE_SHAPES[type],
      ),
    );

    for (const type of [...TYPES_BY_FAMILY.services, ...TYPES_BY_FAMILY.resources]) {
      expect(codeShapes.has(NODE_SHAPES[type])).toBe(false);
    }
  });

  it('labels the architectural relationships on the canvas and not the common ones', () => {
    expect(LABELLED_RELATIONSHIPS.has('ROUTES_TO')).toBe(true);
    expect(LABELLED_RELATIONSHIPS.has('WRITES_TO')).toBe(true);
    // CALLS and CONTAINS are neither few nor surprising; labelling them is noise.
    expect(LABELLED_RELATIONSHIPS.has('CALLS')).toBe(false);
    expect(LABELLED_RELATIONSHIPS.has('CONTAINS')).toBe(false);
  });

  it('marks callables as callable in their label', () => {
    expect(nodeLabel(node('m', 'method', 'getUser'))).toBe('getUser()');
    expect(nodeLabel(node('c', 'class', 'UserService'))).toBe('UserService');
  });

  it('shows the qualified name where it says more than the name', () => {
    expect(
      nodeFullName({ name: 'create', qualifiedName: 'UserService.create', type: 'method' }),
    ).toBe('UserService.create()');
    expect(nodeFullName({ name: 'users', qualifiedName: 'users', type: 'table' })).toBe('users');
  });
});
