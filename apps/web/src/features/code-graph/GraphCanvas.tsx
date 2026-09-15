import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import cytoscape, { type Core, type ElementDefinition, type StylesheetStyle } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import type { CodeEdge, CodeGraph, CodeNode } from '../../types/index.js';
import {
  NODE_SHAPES,
  NODE_SIZES,
  nodeColor,
  relationshipColor,
  STRUCTURAL_RELATIONSHIPS,
} from './graph-style.js';

cytoscape.use(dagre);

/**
 * One selector per node type carrying its shape. Generated from the shape map
 * rather than hand-written so the canvas and the legend cannot disagree;
 * Cytoscape's types do not accept a `data(...)` mapper for `shape`.
 */
const SHAPE_RULES: StylesheetStyle[] = Object.entries(NODE_SHAPES).map(([type, shape]) => ({
  selector: `node[type = "${type}"]`,
  style: { shape: shape as cytoscape.Css.NodeShape },
}));

/** Padding, in pixels, between the graph's bounding box and the canvas edge. */
const FIT_PADDING = 56;

/**
 * Cytoscape's `fit` scales until the graph fills the viewport, which for a
 * twelve-node view means blowing the nodes up to three times their size and
 * turning the labels into overlapping slabs. Nodes have a designed size; a
 * small graph should sit at that size surrounded by whitespace.
 */
const MAX_FIT_ZOOM = 1.15;

function fitWithin(cy: Core): void {
  cy.fit(undefined, FIT_PADDING);
  if (cy.zoom() > MAX_FIT_ZOOM) {
    cy.zoom(MAX_FIT_ZOOM);
    cy.center();
  }
}

/**
 * Cytoscape wrapper.
 *
 * The canvas is a pure view of whatever graph it is handed: it never fetches,
 * never filters and holds no graph data of its own. Zoom and pan are Cytoscape
 * defaults; fit and reset are exposed through the imperative handle so the
 * toolbar can drive them without the page owning a Cytoscape instance.
 */

export interface GraphCanvasHandle {
  fit: () => void;
  reset: () => void;
  focus: (nodeId: string) => void;
}

/**
 * A traversal has a root and reads as a hierarchy; an overview has no root and
 * reads as a mesh. Laying both out the same way serves neither.
 */
export type GraphLayout = 'hierarchy' | 'organic';

export interface GraphCanvasProps {
  graph: CodeGraph;
  layout: GraphLayout;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (node: CodeNode) => void;
  onSelectEdge: (edge: CodeEdge) => void;
  onExpandNode: (node: CodeNode) => void;
  onClearSelection: () => void;
  ref?: Ref<GraphCanvasHandle>;
}

function toElements(graph: CodeGraph): ElementDefinition[] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  const nodes: ElementDefinition[] = graph.nodes.map((node) => ({
    group: 'nodes',
    data: {
      id: node.id,
      label: node.name,
      type: node.type,
      color: nodeColor(node.type),
      // Shape and size are the second and third channels of the encoding:
      // hue alone cannot separate ten node types (see graph-style.ts).
      size: NODE_SIZES[node.type],
    },
  }));

  // Defensive: an edge pointing outside the returned node set would make
  // Cytoscape throw rather than simply skip it.
  const edges: ElementDefinition[] = graph.edges
    .filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId))
    .map((edge) => ({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        label: edge.relationship,
        color: relationshipColor(edge.relationship),
        dashed: STRUCTURAL_RELATIONSHIPS.has(edge.relationship) ? 1 : 0,
        derived: edge.metadata?.derived === true ? 1 : 0,
      },
    }));

  return [...nodes, ...edges];
}

export function GraphCanvas({
  graph,
  layout,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onExpandNode,
  onClearSelection,
  ref,
}: GraphCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  // Handlers change identity on every render; a ref keeps the Cytoscape
  // listeners stable so the graph is not rebuilt on each parent update.
  const handlers = useRef({ onSelectNode, onSelectEdge, onExpandNode, onClearSelection });
  handlers.current = { onSelectNode, onSelectEdge, onExpandNode, onClearSelection };

  const nodesById = useRef(new Map<string, CodeNode>());
  const edgesById = useRef(new Map<string, CodeEdge>());
  nodesById.current = new Map(graph.nodes.map((node) => [node.id, node]));
  edgesById.current = new Map(graph.edges.map((edge) => [edge.id, edge]));

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      minZoom: 0.1,
      maxZoom: 3,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            color: '#c7d2e0',
            'font-size': '10px',
            'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
            'text-valign': 'bottom',
            'text-margin-y': 5,
            'text-wrap': 'ellipsis',
            'text-max-width': '120px',
            // A plate behind the label keeps it readable where edges cross it.
            'text-background-color': '#060910',
            'text-background-opacity': 0.72,
            'text-background-padding': '2px',
            'text-background-shape': 'roundrectangle',
            // Below this the labels would be unreadable mush; drop them and
            // let shape and colour carry the overview.
            'min-zoomed-font-size': 7,
            width: 'data(size)',
            height: 'data(size)',
            'border-width': 2,
            'border-color': '#060910',
          },
        },
        {
          selector: 'node.selected-node',
          style: {
            'border-width': 3,
            'border-color': '#f8fafc',
            'font-weight': 'bold' as unknown as number,
          },
        },
        ...SHAPE_RULES,
        { selector: 'node.faded', style: { opacity: 0.25 } },
        {
          selector: 'edge',
          style: {
            width: 1.4,
            'line-color': 'data(color)',
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.8,
            'curve-style': 'bezier',
            opacity: 0.8,
          },
        },
        { selector: 'edge[dashed = 1]', style: { 'line-style': 'dashed', opacity: 0.45 } },
        { selector: 'edge[derived = 1]', style: { width: 2.4 } },
        {
          selector: 'edge.selected-edge',
          style: {
            width: 3,
            opacity: 1,
            label: 'data(label)',
            color: '#c7d2e0',
            'font-size': '10px',
            'text-background-color': '#0b1220',
            'text-background-opacity': 0.85,
            'text-background-padding': '2px',
          },
        },
        { selector: 'edge.faded', style: { opacity: 0.12 } },
      ],
    });

    cy.on('tap', 'node', (event) => {
      const node = nodesById.current.get(event.target.id() as string);
      if (node) handlers.current.onSelectNode(node);
    });

    cy.on('dbltap', 'node', (event) => {
      const node = nodesById.current.get(event.target.id() as string);
      if (node) handlers.current.onExpandNode(node);
    });

    cy.on('tap', 'edge', (event) => {
      const edge = edgesById.current.get(event.target.id() as string);
      if (edge) handlers.current.onSelectEdge(edge);
    });

    cy.on('tap', (event) => {
      if (event.target === cy) handlers.current.onClearSelection();
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Re-render elements whenever the graph changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().remove();
      cy.add(toElements(graph));
    });

    if (cy.nodes().length === 0) return;

    // Dagre for both modes. Code relationships are directed — a controller
    // calls a service calls a repository — so a layered left-to-right reading
    // is the honest one, and Cytoscape's built-in force layout collapses a
    // small filtered view into an unreadable cluster whatever its parameters.
    // A traversal is denser near its root, so it gets tighter ranks than an
    // overview, which is wide and shallow.
    const options = {
      name: 'dagre',
      rankDir: 'LR',
      nodeSep: layout === 'hierarchy' ? 34 : 40,
      rankSep: layout === 'hierarchy' ? 110 : 170,
      edgeSep: 20,
      // The default network-simplex ranker balances rank widths; longest-path
      // stretches the graph into a tall column.
      ranker: 'network-simplex',
      animate: false,
      fit: false,
    };

    const run = cy.layout(options as cytoscape.LayoutOptions);
    run.one('layoutstop', () => {
      fitWithin(cy);
    });
    run.run();
  }, [graph, layout]);

  // Selection highlighting is a style pass, not a re-layout.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().removeClass('selected-node selected-edge faded');

      if (selectedNodeId) {
        const node = cy.getElementById(selectedNodeId);
        if (node.nonempty()) {
          const neighbourhood = node.closedNeighborhood();
          cy.elements().difference(neighbourhood).addClass('faded');
          node.addClass('selected-node');
        }
      }

      if (selectedEdgeId) {
        const edge = cy.getElementById(selectedEdgeId);
        if (edge.nonempty()) {
          const connected = edge.connectedNodes().union(edge);
          cy.elements().difference(connected).addClass('faded');
          edge.addClass('selected-edge');
        }
      }
    });
  }, [selectedNodeId, selectedEdgeId, graph]);

  useImperativeHandle(
    ref,
    () => ({
      fit: () => {
        const cy = cyRef.current;
        if (cy) fitWithin(cy);
      },
      reset: () => {
        const cy = cyRef.current;
        if (!cy) return;
        cy.zoom(1);
        cy.center();
      },
      focus: (nodeId: string) => {
        const cy = cyRef.current;
        if (!cy) return;
        const node = cy.getElementById(nodeId);
        if (node.nonempty()) cy.animate({ center: { eles: node }, zoom: 1.4 }, { duration: 250 });
      },
    }),
    [],
  );

  return <div className="graph-canvas" ref={containerRef} role="application" aria-label="Code graph" />;
}
