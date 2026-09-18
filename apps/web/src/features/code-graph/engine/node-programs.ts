import {
  NodeProgram,
  createNodeCompoundProgram,
  type InstancedProgramDefinition,
  type ProgramInfo,
} from 'sigma/rendering';
import type { NodeDisplayData, RenderParams } from 'sigma/types';
import { floatColor } from 'sigma/utils';

/**
 * The node renderer: one draw call for every silhouette, one for every halo.
 *
 * Both programs follow Sigma's own `NodeCircleProgram` exactly — three vertices
 * per node forming a triangle that circumscribes the drawn disc, and a fragment
 * shader that decides what is inside it. That is what makes this scale: the
 * graph could be a hundred thousand nodes and it is still two buffer uploads
 * and two draws, with no DOM, no SVG and nothing per node on the JavaScript
 * side once the buffer is written.
 *
 * ## Why a custom program at all
 *
 * Sigma ships circles. Twenty-eight node types need more channels than a circle
 * has: a silhouette so an API is not separated from a class by colour alone,
 * and a halo proportional to importance so the eye lands on the service before
 * it lands on its parameters. Doing either in a canvas overlay would mean
 * giving back the thing WebGL was chosen for.
 *
 * ## Blending
 *
 * Sigma renders with `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`, so every fragment
 * here is emitted **premultiplied**: `vec4(rgb * a, a)`. Halos therefore
 * accumulate additively where two of them overlap, which is exactly the
 * behaviour a dense cluster should have.
 */

const { UNSIGNED_BYTE, FLOAT } = WebGLRenderingContext;

/** Triangle vertices, as angles. Identical to Sigma's circle program. */
const ANGLE_1 = 0;
const ANGLE_2 = (2 * Math.PI) / 3;
const ANGLE_3 = (4 * Math.PI) / 3;

/**
 * How much room the geometry leaves around the drawn radius.
 *
 * Shapes are normalised to a common circumradius, so `1` would already contain
 * every silhouette; the margin is for the selection ring, which is drawn
 * outside the shape, and for antialiasing at the rim.
 */
const SHAPE_COVER = 1.5;

/**
 * How far a halo reaches, as a multiple of the node's own radius.
 *
 * Generous, because the node it surrounds is small: the glow is what carries
 * importance at a distance, and a tight halo on a six-pixel disc is invisible
 * from across the viewport.
 */
const HALO_REACH = 4.2;

/**
 * Signed distance functions, one per silhouette.
 *
 * The ids match `NODE_SHAPES` in `model/node-types.ts`; a shape is chosen with
 * a dynamic branch rather than a separate program because a node covers a few
 * dozen fragments and a second draw call would cost far more than the branch.
 *
 * Every shape is normalised so its circumradius is the node radius: a hexagon
 * and a circle of the same `size` occupy the same footprint, which is what lets
 * size continue to mean importance rather than silhouette.
 */
const SHAPE_FUNCTIONS = /* glsl */ `
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;

float sdPolygon(vec2 p, float r, float n, float rot) {
  float a = atan(p.y, p.x) + rot;
  float b = TAU / n;
  return cos(floor(0.5 + a / b) * b - a) * length(p) - r * cos(PI / n);
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdRoundBox(vec2 p, vec2 b, float rad) {
  return sdBox(p, b - vec2(rad)) - rad;
}

float shapeDistance(vec2 p, float r, float shape) {
  if (shape < 0.5) return length(p) - r;                                  // circle
  if (shape < 1.5) return sdRoundBox(p, vec2(r * 0.70), r * 0.18);        // square
  if (shape < 2.5) return sdPolygon(p, r, 4.0, PI * 0.25);                // diamond
  if (shape < 3.5) return sdPolygon(p, r, 6.0, 0.0);                      // hexagon
  if (shape < 4.5) return sdPolygon(p, r * 1.12, 3.0, PI * 0.5);          // triangle
  if (shape < 5.5) return sdPolygon(p, r * 1.04, 5.0, PI * 0.5);          // pentagon
  if (shape < 6.5) return abs(length(p) - r * 0.72) - r * 0.24;           // ring
  if (shape < 7.5) return abs(sdRoundBox(p, vec2(r * 0.62), r * 0.12)) - r * 0.18; // hollow square
  if (shape < 8.5) return sdRoundBox(p, vec2(r * 0.62, r * 0.86), r * 0.30);       // capsule
  if (shape < 9.5) {                                                      // rhomboid
    vec2 q = vec2(p.x - p.y * 0.42, p.y);
    return sdRoundBox(q, vec2(r * 0.60, r * 0.72), r * 0.10);
  }
  if (shape < 10.5) {                                                     // star
    float a = atan(p.y, p.x);
    return length(p) - r * (0.55 + 0.45 * cos(5.0 * a + PI * 0.5));
  }
  if (shape < 11.5) {                                                     // cross
    return min(sdBox(p, vec2(r * 0.92, r * 0.26)), sdBox(p, vec2(r * 0.26, r * 0.92)));
  }
  // A page: portrait, with the top-right corner cut off. The notch is what
  // makes it read as a document rather than as a tall box.
  if (shape < 12.5) {
    float page = sdRoundBox(p, vec2(r * 0.55, r * 0.80), r * 0.10);
    float fold = dot(p - vec2(r * 0.55, r * 0.80), normalize(vec2(-1.0, -1.0))) + r * 0.30;
    return max(page, -fold);
  }
  // A bar: one line of a settings file.
  if (shape < 13.5) return sdRoundBox(p, vec2(r * 0.92, r * 0.34), r * 0.14);
  // Hollow triangle: an endpoint a specification promises, drawn as the outline
  // of the filled triangle a served route gets. Unimplemented reads as empty.
  if (shape < 14.5) return abs(sdPolygon(p, r * 1.00, 3.0, PI * 0.5)) - r * 0.16;
  // Hollow pentagon, to the filled pentagon a service gets.
  if (shape < 15.5) return abs(sdPolygon(p, r * 0.92, 5.0, PI * 0.5)) - r * 0.16;
  // Hollow hexagon: a container, which is a box with something inside it.
  if (shape < 16.5) return abs(sdPolygon(p, r * 0.92, 6.0, 0.0)) - r * 0.16;
  // Two stacked bars: a paragraph, for a section of a document.
  if (shape < 17.5) {
    float top = sdRoundBox(p - vec2(0.0, r * 0.34), vec2(r * 0.86, r * 0.20), r * 0.09);
    float bottom = sdRoundBox(p + vec2(0.0, r * 0.34), vec2(r * 0.62, r * 0.20), r * 0.09);
    return min(top, bottom);
  }
  // A pillar: tall and narrow, which is what a column of a table looks like.
  return sdRoundBox(p, vec2(r * 0.28, r * 0.88), r * 0.11);
}
`;

// --- silhouettes ----------------------------------------------------------

const SHAPE_VERTEX_SHADER = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec4 a_ringColor;
attribute vec2 a_position;
attribute float a_size;
attribute float a_shape;
attribute float a_ring;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec4 v_ringColor;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_shape;
varying float v_ring;

const float bias = 255.0 / 254.0;

void main() {
  float radius = a_size * u_correctionRatio / u_sizeRatio * 2.0;
  vec2 diffVector = radius * ${SHAPE_COVER.toFixed(1)} * 2.0 * vec2(cos(a_angle), sin(a_angle));

  gl_Position = vec4((u_matrix * vec3(a_position + diffVector, 1)).xy, 0, 1);

  v_diffVector = diffVector;
  v_radius = radius;
  v_shape = a_shape;
  v_ring = a_ring;
  v_ringColor = a_ringColor;

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif

  v_color.a *= bias;
  v_ringColor.a *= bias;
}
`;

const SHAPE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec4 v_color;
varying vec4 v_ringColor;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_shape;
varying float v_ring;

uniform float u_correctionRatio;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

${SHAPE_FUNCTIONS}

void main(void) {
  float feather = u_correctionRatio * 2.0;
  float dist = shapeDistance(v_diffVector, v_radius, v_shape);

  #ifdef PICKING_MODE
  // The picking pass must not antialias: a half-covered pixel would decode to
  // a node id that does not exist. The ring is left out of it too, so the
  // clickable area stays the silhouette the user can see.
  if (dist > 0.0) gl_FragColor = transparent;
  else gl_FragColor = v_color;

  #else
  float fillMask = 1.0 - smoothstep(-feather, feather, dist);
  vec4 fill = v_color * fillMask;

  // The ring sits just outside the silhouette rather than on it, so selection
  // never changes how big a node looks.
  float ringRadius = v_radius * 1.34;
  float ringDist = abs(length(v_diffVector) - ringRadius) - v_ring * v_radius;
  float ringMask = v_ring > 0.0 ? 1.0 - smoothstep(-feather, feather, ringDist) : 0.0;
  vec4 ring = v_ringColor * ringMask;

  // Both terms are premultiplied, so the ring simply covers what it overlaps.
  gl_FragColor = ring + fill * (1.0 - ring.a);
  #endif
}
`;

const SHAPE_UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix'] as const;

type ShapeUniform = (typeof SHAPE_UNIFORMS)[number];

/** The extra display-data fields the engine writes for every node. */
export interface CodeNodeDisplayData extends NodeDisplayData {
  shape?: number;
  glow?: number;
  ring?: number;
  ringColor?: string;
}

class NodeShapeProgram extends NodeProgram<ShapeUniform> {
  getDefinition(): InstancedProgramDefinition<ShapeUniform> {
    return {
      VERTICES: 3,
      VERTEX_SHADER_SOURCE: SHAPE_VERTEX_SHADER,
      FRAGMENT_SHADER_SOURCE: SHAPE_FRAGMENT_SHADER,
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS: SHAPE_UNIFORMS,
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: FLOAT },
        { name: 'a_size', size: 1, type: FLOAT },
        { name: 'a_color', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_ringColor', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_id', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_shape', size: 1, type: FLOAT },
        { name: 'a_ring', size: 1, type: FLOAT },
      ],
      CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: FLOAT }],
      CONSTANT_DATA: [[ANGLE_1], [ANGLE_2], [ANGLE_3]],
    };
  }

  processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData): void {
    const node = data as CodeNodeDisplayData;
    const array = this.array;
    let cursor = startIndex;

    array[cursor++] = node.x;
    array[cursor++] = node.y;
    array[cursor++] = node.size;
    array[cursor++] = floatColor(node.color);
    array[cursor++] = floatColor(node.ringColor ?? node.color);
    array[cursor++] = nodeIndex;
    array[cursor++] = node.shape ?? 0;
    array[cursor++] = node.ring ?? 0;
  }

  setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo<ShapeUniform>): void {
    const { u_sizeRatio, u_correctionRatio, u_matrix } = uniformLocations;
    gl.uniform1f(u_correctionRatio, params.correctionRatio);
    gl.uniform1f(u_sizeRatio, params.sizeRatio);
    gl.uniformMatrix3fv(u_matrix, false, params.matrix);
  }
}

// --- halos ----------------------------------------------------------------

const HALO_VERTEX_SHADER = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_glow;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_glow;

void main() {
  float radius = a_size * u_correctionRatio / u_sizeRatio * 2.0 * ${HALO_REACH.toFixed(1)};
  vec2 diffVector = radius * 2.0 * vec2(cos(a_angle), sin(a_angle));

  gl_Position = vec4((u_matrix * vec3(a_position + diffVector, 1)).xy, 0, 1);

  v_diffVector = diffVector;
  v_radius = radius;
  v_glow = a_glow;
  v_color = a_color;
}
`;

const HALO_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
varying float v_glow;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  #ifdef PICKING_MODE
  // A halo is light, not surface: it must never take a click from the node
  // underneath it, and a big glow must not swallow its small neighbours.
  gl_FragColor = transparent;

  #else
  float d = length(v_diffVector) / v_radius;

  if (d > 1.0 || v_glow <= 0.0) {
    gl_FragColor = transparent;
  } else {
    // A squared-ish falloff reads as light rather than as a second, fuzzy
    // node: most of the intensity is spent close in, and the tail is long
    // enough that overlapping halos merge into a nebula.
    float falloff = 1.0 - d;
    float alpha = pow(falloff, 2.6) * v_glow;
    gl_FragColor = vec4(v_color.rgb * alpha, alpha);
  }
  #endif
}
`;

const HALO_UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix'] as const;

type HaloUniform = (typeof HALO_UNIFORMS)[number];

class NodeHaloProgram extends NodeProgram<HaloUniform> {
  getDefinition(): InstancedProgramDefinition<HaloUniform> {
    return {
      VERTICES: 3,
      VERTEX_SHADER_SOURCE: HALO_VERTEX_SHADER,
      FRAGMENT_SHADER_SOURCE: HALO_FRAGMENT_SHADER,
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS: HALO_UNIFORMS,
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: FLOAT },
        { name: 'a_size', size: 1, type: FLOAT },
        { name: 'a_color', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_id', size: 4, type: UNSIGNED_BYTE, normalized: true },
        { name: 'a_glow', size: 1, type: FLOAT },
      ],
      CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: FLOAT }],
      CONSTANT_DATA: [[ANGLE_1], [ANGLE_2], [ANGLE_3]],
    };
  }

  processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData): void {
    const node = data as CodeNodeDisplayData;
    const array = this.array;
    let cursor = startIndex;

    array[cursor++] = node.x;
    array[cursor++] = node.y;
    array[cursor++] = node.size;
    array[cursor++] = floatColor(node.color);
    array[cursor++] = nodeIndex;
    array[cursor++] = node.glow ?? 0;
  }

  setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo<HaloUniform>): void {
    const { u_sizeRatio, u_correctionRatio, u_matrix } = uniformLocations;
    gl.uniform1f(u_correctionRatio, params.correctionRatio);
    gl.uniform1f(u_sizeRatio, params.sizeRatio);
    gl.uniformMatrix3fv(u_matrix, false, params.matrix);
  }
}

/**
 * Halo first, silhouette second — the draw order is the stacking order, so a
 * node is always crisp on top of its own light.
 */
export const NodeGlowProgram = createNodeCompoundProgram([NodeHaloProgram, NodeShapeProgram]);

export { NodeShapeProgram, NodeHaloProgram };
