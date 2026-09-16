import { describe, expect, it } from 'vitest';
import { CODE_NODE_TYPES, CODE_RELATIONSHIPS } from '@ckg/shared';
import type { CodeEdge, CodeGraph, CodeNode } from '../src/types/index.js';
import { mergeGraphs, newNodeCount } from '../src/features/code-graph/model/merge-graph.js';
import {
  DEFAULT_MODE_ID,
  GRAPH_MODES,
  graphMode,
  matchMode,
} from '../src/features/code-graph/model/graph-modes.js';
import {
  NODE_SHAPES,
  NODE_STYLES,
  TYPES_BY_FAMILY,
  nodeFullName,
  nodeLabel,
  nodeStyle,
} from '../src/features/code-graph/model/node-types.js';
import {
  EDGE_STYLES,
  FLOW_RELATIONSHIPS,
  LABELLED_RELATIONSHIPS,
  edgeStyle,
  relationshipColor,
} from '../src/features/code-graph/model/edge-types.js';
import { dim, mix, nodeColor, parseHex } from '../src/features/code-graph/utils/graph-colors.js';

/**
 * The view logic that has no DOM in it: what the renderer is handed, and what
 * it is drawn with. Both are pure, both are where a mistake would be silent,
 * and neither needs a browser — or a GPU — to check.
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
    // Graphology rejects an edge to a node it does not have.
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

describe('graph modes', () => {
  it('are the server’s projections, not a second definition of them', () => {
    const mode = graphMode('architecture');

    expect(mode.projection.nodeTypes).toContain('api');
    expect(mode.projection.relationships).toContain('ROUTES_TO');
  });

  it('keeps every view the toolbar had, and names the unfiltered one Universe', () => {
    expect(GRAPH_MODES.map((mode) => mode.label)).toEqual([
      'Universe',
      'Architecture',
      'Call graph',
      'Files',
      'Dependencies',
      'Data flow',
    ]);
  });

  it('opens on architecture', () => {
    expect(DEFAULT_MODE_ID).toBe('architecture');
  });

  it('recognises filters that match a mode, and those that do not', () => {
    const architecture = graphMode('architecture').projection;

    expect(matchMode(architecture.nodeTypes, architecture.relationships)).toBe('architecture');
    expect(matchMode([], [])).toBe('everything');
    expect(matchMode(['class'], ['CALLS'])).toBeNull();
  });

  it('asks for no more nodes than the server will return', () => {
    for (const mode of GRAPH_MODES) {
      expect(mode.limit).toBeGreaterThan(0);
      expect(mode.limit).toBeLessThanOrEqual(2000);
    }
  });
});

describe('the visual language', () => {
  it('gives every node type a complete style', () => {
    for (const type of CODE_NODE_TYPES) {
      const style = nodeStyle(type);

      expect(style.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(NODE_SHAPES[style.shape]).toBeTypeOf('number');
      expect(style.size).toBeGreaterThan(0);
      expect(style.glow).toBeGreaterThanOrEqual(0);
      expect(style.glow).toBeLessThanOrEqual(1);
      expect(style.labelPriority).toBeGreaterThanOrEqual(0);
      expect(style.labelPriority).toBeLessThanOrEqual(1);
      expect([0, 1, 2]).toContain(style.detailTier);
    }
  });

  it('gives every shape id a distinct number, because the shader branches on it', () => {
    const ids = Object.values(NODE_SHAPES);

    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBe(ids.length - 1);
  });

  it('gives every relationship a complete style', () => {
    for (const relationship of CODE_RELATIONSHIPS) {
      const style = edgeStyle(relationship);

      expect(relationshipColor(relationship)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.width).toBeGreaterThan(0);
      expect(['line', 'arrow']).toContain(style.program);
    }
  });

  it('lists every node type in exactly one family, so the legend is complete', () => {
    const listed = Object.values(TYPES_BY_FAMILY).flat();

    expect([...listed].sort()).toEqual([...CODE_NODE_TYPES].sort());
  });

  it('gives the architectural types silhouettes no code type uses', () => {
    const codeShapes = new Set(
      [
        ...TYPES_BY_FAMILY.types,
        ...TYPES_BY_FAMILY.callables,
        ...TYPES_BY_FAMILY.data,
        ...TYPES_BY_FAMILY.structure,
      ].map((type) => nodeStyle(type).shape),
    );

    for (const type of [...TYPES_BY_FAMILY.services, ...TYPES_BY_FAMILY.resources]) {
      expect(codeShapes.has(nodeStyle(type).shape)).toBe(false);
    }
  });

  it('draws structural relationships more quietly than behavioural ones', () => {
    expect(edgeStyle('CONTAINS').emphasis).toBe('weak');
    expect(edgeStyle('CALLS').emphasis).toBe('strong');
    expect(edgeStyle('CONTAINS').width).toBeLessThan(edgeStyle('CALLS').width);
    // Only the relationships whose direction is the point get an arrowhead.
    expect(edgeStyle('CONTAINS').program).toBe('line');
    expect(edgeStyle('ROUTES_TO').program).toBe('arrow');
  });

  it('labels the architectural relationships and not the common ones', () => {
    expect(LABELLED_RELATIONSHIPS.has('ROUTES_TO')).toBe(true);
    expect(LABELLED_RELATIONSHIPS.has('WRITES_TO')).toBe(true);
    // CALLS and CONTAINS are neither few nor surprising; labelling them is noise.
    expect(LABELLED_RELATIONSHIPS.has('CALLS')).toBe(false);
    expect(LABELLED_RELATIONSHIPS.has('CONTAINS')).toBe(false);
  });

  it('animates flow only where direction is worth following', () => {
    expect(FLOW_RELATIONSHIPS.has('CALLS')).toBe(true);
    expect(FLOW_RELATIONSHIPS.has('WRITES_TO')).toBe(true);
    expect(FLOW_RELATIONSHIPS.has('CONTAINS')).toBe(false);
    expect(FLOW_RELATIONSHIPS.has('EXPORTS')).toBe(false);

    for (const relationship of CODE_RELATIONSHIPS) {
      if (FLOW_RELATIONSHIPS.has(relationship)) {
        expect(EDGE_STYLES[relationship].flow).toBe(true);
      }
    }
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

  it('ranks architecture above the inside of a function, for both size and zoom', () => {
    expect(NODE_STYLES.service.size).toBeGreaterThan(NODE_STYLES.parameter.size);
    expect(NODE_STYLES.service.labelPriority).toBeGreaterThan(NODE_STYLES.parameter.labelPriority);
    expect(NODE_STYLES.service.detailTier).toBeLessThan(NODE_STYLES.parameter.detailTier);
  });
});

describe('colour maths', () => {
  it('parses both forms of hex', () => {
    expect(parseHex('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHex('#f80')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('returns the endpoints exactly', () => {
    expect(mix('#102030', '#405060', 0)).toBe('#102030');
    expect(mix('#102030', '#405060', 1)).toBe('#405060');
  });

  it('fades towards the void rather than towards transparency', () => {
    // Dimming has to be opaque: Sigma blends premultiplied, and a dimmed node
    // that let the background through would brighten over a nebula.
    const faded = dim(nodeColor('service'), 0.9);

    expect(faded).toMatch(/^#[0-9a-f]{6}$/i);
    expect(faded).not.toBe(nodeColor('service'));
    expect(dim(nodeColor('service'), 0)).toBe(nodeColor('service'));
  });
});
