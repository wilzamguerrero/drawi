import { smin, TAU } from "../core/math";
import { shapeParams, starM, type ShapeDef } from "./shapes";
import type { Body } from "./world";

/**
 * Funciones de distancia con signo (SDF) de las formas basicas.
 *
 * Existen dos veces: aqui en TypeScript y, identicas, en GLSL dentro de
 * `field-gl.ts`. La version GPU pinta; la version CPU extrae contornos para
 * exportar SVG, hornear materia a tinta y servir de respaldo sin WebGL.
 * Cualquier cambio en una debe replicarse en la otra.
 */

export const sdCircle = (px: number, py: number, r: number): number =>
  Math.hypot(px, py) - r;

export const sdRoundBox = (
  px: number,
  py: number,
  bx: number,
  by: number,
  r: number,
): number => {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return Math.min(Math.max(qx, qy), 0) + outside - r;
};

export const sdCapsule = (px: number, py: number, half: number, r: number): number => {
  const x = px - Math.min(Math.max(px, -half), half);
  return Math.hypot(x, py) - r;
};

export const sdNgon = (px: number, py: number, r: number, n: number, round: number): number => {
  const an = Math.PI / n;
  const acsX = Math.cos(an);
  const acsY = Math.sin(an);
  let bn = Math.atan2(px, py) % (2 * an);
  if (bn < 0) bn += 2 * an;
  bn -= an;
  const l = Math.hypot(px, py);
  let x = l * Math.cos(bn);
  let y = l * Math.abs(Math.sin(bn));
  x -= r * acsX;
  y -= r * acsY;
  y += Math.min(Math.max(-y, 0), r * acsY);
  return Math.hypot(x, y) * Math.sign(x) - round;
};

export const sdStar = (px: number, py: number, r: number, n: number, m: number): number => {
  const an = Math.PI / n;
  const en = Math.PI / Math.max(2.0001, m);
  const acsX = Math.cos(an);
  const acsY = Math.sin(an);
  const ecsX = Math.cos(en);
  const ecsY = Math.sin(en);
  let bn = Math.atan2(px, py) % (2 * an);
  if (bn < 0) bn += 2 * an;
  bn -= an;
  const l = Math.hypot(px, py);
  let x = l * Math.cos(bn);
  let y = l * Math.abs(Math.sin(bn));
  x -= r * acsX;
  y -= r * acsY;
  const t = Math.min(Math.max(-(x * ecsX + y * ecsY), 0), (r * acsY) / ecsY);
  x += ecsX * t;
  y += ecsY * t;
  return Math.hypot(x, y) * Math.sign(x);
};

export function sdShape(lx: number, ly: number, shape: ShapeDef): number {
  const [a, b, c] = shapeParams(shape);
  switch (shape.kind) {
    case "circle":
      return sdCircle(lx, ly, a);
    case "box":
      return sdRoundBox(lx, ly, a, b, c);
    case "capsule":
      return sdCapsule(lx, ly, b, a);
    case "ngon":
      return sdNgon(lx, ly, a, Math.max(3, Math.round(b)), c);
    case "star":
      return sdStar(lx, ly, a, Math.max(3, Math.round(b)), starM(Math.max(3, Math.round(b)), c));
  }
}

/** SDF de un cuerpo en coordenadas de mundo. */
export function sdBody(x: number, y: number, body: Body): number {
  const c = Math.cos(body.angle);
  const s = Math.sin(body.angle);
  const rx = x - body.pos.x;
  const ry = y - body.pos.y;
  return sdShape(rx * c + ry * s, -rx * s + ry * c, body.shape);
}

export interface FieldSample {
  d: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Campo combinado: union suave (smin) de todos los cuerpos, con el color
 * arrastrado por el mismo peso de mezcla. Esto es exactamente lo que hace el
 * shader, y es lo que produce el puente entre formas al acercarse.
 */
export function sampleField(
  x: number,
  y: number,
  bodies: readonly Body[],
  blend: number,
  colors: readonly [number, number, number][],
  out: FieldSample = { d: 0, r: 0, g: 0, b: 0 },
): FieldSample {
  let d = 1e20;
  let cr = 0;
  let cg = 0;
  let cb = 0;
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    const dx = x - body.pos.x;
    const dy = y - body.pos.y;
    const k = body.blend > 0 ? body.blend : blend;
    const reach = body.radius + k + 2;
    if (dx * dx + dy * dy > reach * reach) continue;
    const di = sdBody(x, y, body);
    const kk = Math.max(0.001, k);
    const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - di)) / kk));
    d = smin(d, di, kk);
    const col = colors[i];
    cr += (col[0] - cr) * h;
    cg += (col[1] - cg) * h;
    cb += (col[2] - cb) * h;
  }
  out.d = d;
  out.r = cr;
  out.g = cg;
  out.b = cb;
  return out;
}

/** Distancia combinada sin color: version rapida para marching squares. */
export function sampleFieldDistance(
  x: number,
  y: number,
  bodies: readonly Body[],
  blend: number,
): number {
  let d = 1e20;
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    const dx = x - body.pos.x;
    const dy = y - body.pos.y;
    const k = body.blend > 0 ? body.blend : blend;
    const reach = body.radius + k + 2;
    if (dx * dx + dy * dy > reach * reach) continue;
    d = smin(d, sdBody(x, y, body), Math.max(0.001, k));
  }
  return d;
}

/** Puntos de una circunferencia: utilidad compartida por previews. */
export function circlePoints(cx: number, cy: number, r: number, steps = 48): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < steps; i++) {
    const a = (TAU * i) / steps;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}
