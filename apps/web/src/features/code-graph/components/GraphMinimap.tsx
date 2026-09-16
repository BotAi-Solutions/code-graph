import { useEffect, useRef } from 'react';
import type { GraphEngine } from '../engine/graph-engine.js';
import type { CodeGraphModel } from '../model/graph-types.js';
import { ACCENT, CANVAS_INK, rgba } from '../utils/graph-colors.js';

/**
 * Where you are in the graph.
 *
 * Drawn to a small 2D canvas from the engine's own framed coordinates, so the
 * minimap and the viewport rectangle are in the same space and no second
 * projection can drift from the first. It redraws only when the camera moves or
 * the graph changes — there is no animation loop here.
 *
 * Deliberately quiet: one pixel per node, the viewport as a thin rectangle, and
 * the selection as the only thing with a colour. A minimap that competes with
 * the graph is a second graph.
 */

const WIDTH = 168;
const HEIGHT = 112;
const PADDING = 6;

export interface GraphMinimapProps {
  engine: GraphEngine;
  model: CodeGraphModel;
  selectedNodeId: string | null;
  /** Bumped by the canvas on every camera change. */
  tick: number;
}

export function GraphMinimap({
  engine,
  model,
  selectedNodeId,
  tick,
}: GraphMinimapProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = WIDTH * ratio;
    canvas.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, WIDTH, HEIGHT);

    const nodes = engine.snapshotNodes();
    if (nodes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }

    const viewport = engine.viewportRect();

    // The rectangle can extend beyond the graph when the user zooms out past
    // it; including it in the extent keeps it visible instead of clipped.
    minX = Math.min(minX, viewport.x1);
    minY = Math.min(minY, viewport.y1);
    maxX = Math.max(maxX, viewport.x2);
    maxY = Math.max(maxY, viewport.y2);

    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min((WIDTH - PADDING * 2) / spanX, (HEIGHT - PADDING * 2) / spanY);
    const offsetX = (WIDTH - spanX * scale) / 2 - minX * scale;
    const offsetY = (HEIGHT - spanY * scale) / 2 - minY * scale;

    const project = (x: number, y: number): [number, number] => [
      x * scale + offsetX,
      y * scale + offsetY,
    ];

    context.fillStyle = rgba(CANVAS_INK, 0.55);
    context.fillRect(0, 0, WIDTH, HEIGHT);

    for (const node of nodes) {
      const [x, y] = project(node.x, node.y);
      const radius = node.id === selectedNodeId ? 2.6 : Math.max(0.7, node.size / 5);

      context.fillStyle = node.id === selectedNodeId ? ACCENT : rgba(node.color, 0.7);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }

    const [vx1, vy1] = project(viewport.x1, viewport.y1);
    const [vx2, vy2] = project(viewport.x2, viewport.y2);

    context.strokeStyle = rgba('#9fb0c8', 0.55);
    context.lineWidth = 1;
    context.strokeRect(vx1 + 0.5, vy1 + 0.5, Math.max(2, vx2 - vx1), Math.max(2, vy2 - vy1));
  }, [engine, model, selectedNodeId, tick]);

  return (
    <div className="graph-minimap" aria-hidden="true">
      <canvas ref={canvasRef} style={{ width: WIDTH, height: HEIGHT }} />
    </div>
  );
}
