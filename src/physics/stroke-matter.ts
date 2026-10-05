import { MAX_POLY_VERTS, type ShapeDef } from "./shapes";
import { createBody, type Body } from "./world";
import { uid } from "../core/rng";
import { apply } from "../core/mat2d";
import type { Vec2 } from "../core/vec2";
import type { InkItem } from "../scene/types";

const EPSILON = 1e-4;

/**
 * Trazos de tinta -> materia.
 *
 * Desde que el campo (GPU y CPU) y el solver entienden `kind: "poly"` —SDF
 * exacta de silueta libre—, un trazo ya no se aproxima con cadenas de
 * capsulas: se convierte en UN cuerpo de forma libre que conserva el contorno
 * dibujado. Ese cuerpo funde, tiende puentes y se transforma
 * (mover/rotar/escalar) como cualquier otra materia.
 */

/** Parametros de siembra de un contorno como materia. */
export interface StrokeMatterOptions {
  color: string;
  /** Radio de fusion propio; 0 = usa el global. */
  blend: number;
  restitution: number;
  friction: number;
  /** Capa de materia destino. */
  layerId: string;
  /** Limite total de cuerpos a crear (cuota restante). */
  maxBodies?: number;
}

/**
 * Convierte el contorno de un trazo en UN cuerpo de forma libre.
 *
 * El contorno se simplifica hasta MAX_POLY_VERTS, se centra en su centroide de
 * AREA —el centro real de la forma, no la media de vertices— y se siembra con
 * grupo 0 para que funda y tienda puentes con el resto de la materia. El
 * pivote (strokePivotX/Y) viaja en espacio LOCAL del cuerpo: rotar alrededor
 * de el lo deja clavado, escalarlo lo multiplica y moverlo (o la fisica) lo
 * arrastra, sin que haya que reajustarlo nunca.
 *
 * Devuelve null si el contorno es degenerado (menos de 3 vertices utiles).
 */
/**
 * Convierte un item de tinta entero en cuerpos de forma libre.
 *
 * La simetria del item esta congelada: cada copia se siembra como un cuerpo
 * hermano (mismo strokeId) para que mover/rotar/escalar los trate como un
 * grupo... salvo que la copia ES la misma silueta, en cuyo caso comparten
 * strokeId solo si proceden del mismo poligono. Cada cuerpo lleva su pivote
 * en el centroide local de su propia forma.
 */
export function bodiesForInkItem(item: InkItem, opts: StrokeMatterOptions): Body[] {
  const maxBodies = opts.maxBodies ?? 4096;
  const transforms = item.transforms.length > 0
    ? item.transforms
    : [{ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }];
  const out: Body[] = [];
  for (const poly of item.polys) {
    if (out.length >= maxBodies) break;
    const strokeId = uid();
    for (const m of transforms) {
      if (out.length >= maxBodies) break;
      const world = poly.map((p) => apply(m, p));
      const body = bodyFromOutline(world, opts);
      if (!body) continue;
      body.strokeId = strokeId;
      body.strokeIndex = out.length;
      body.color = item.color;
      out.push(body);
    }
  }
  return out;
}

export function bodyFromOutline(outline: readonly Vec2[], opts: StrokeMatterOptions): Body | null {
  const clean = simplifyOutline(outline, MAX_POLY_VERTS);
  if (clean.length < 3) return null;
  const c = outlineCentroid(clean);
  const shape: ShapeDef = {
    kind: "poly",
    size: 1,
    aspect: 1,
    sides: 3,
    inner: 0,
    round: 0,
    seed: 0,
    poly: clean.map((p) => ({ x: p.x - c.x, y: p.y - c.y })),
  };
  const body = createBody(shape, c, {
    color: opts.color,
    group: 0,
    blend: opts.blend,
    restitution: opts.restitution,
    friction: opts.friction,
    layerId: opts.layerId,
  });
  // Pivote local en el centroide: el punto de giro/escala por defecto es el
  // centro real de la forma (en mundo: pos + rotacion * (0,0) = pos).
  body.strokePivotX = 0;
  body.strokePivotY = 0;
  return body;
}

/**
 * Reduce un contorno a un maximo de vertices conservando su forma (RDP con
 * tolerancia creciente). Se usa para que la silueta libre quepa en el shader.
 */
export function simplifyOutline(poly: readonly Vec2[], maxVerts: number): Vec2[] {
  const pts = cleanPolygon(poly);
  if (pts.length <= maxVerts) return pts;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  let tol = Math.max(maxX - minX, maxY - minY) * 0.002 + 0.01;
  let out = pts;
  for (let i = 0; i < 24 && out.length > maxVerts; i++) {
    out = rdp(pts, tol);
    tol *= 1.6;
  }
  return out.length > maxVerts ? out.filter((_, i) => i % Math.ceil(out.length / maxVerts) === 0) : out;
}

/**
 * Centro real de una silueta: centroide de area si el poligono la tiene, y si
 * no (trazo degenerado), la media de vertices. Exportado para que quien siembre
 * varias piezas calcule el pivote compartido del mismo modo.
 */
export function outlineCentroid(pts: readonly Vec2[]): Vec2 {
  return polygonCentroid(pts) ?? vertexCentroid(pts);
}

/** Centroide de AREA de un poligono simple; null si el area es ~0. */
function polygonCentroid(pts: readonly Vec2[]): Vec2 | null {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const cross = pts[j].x * pts[i].y - pts[j].y * pts[i].x;
    area += cross;
    cx += (pts[j].x + pts[i].x) * cross;
    cy += (pts[j].y + pts[i].y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-9) return null;
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

function vertexCentroid(pts: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

function cleanPolygon(poly: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > EPSILON) out.push({ x: p.x, y: p.y });
  }
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= EPSILON) {
    out.pop();
  }
  return out;
}

function rdp(pts: readonly Vec2[], tol: number): Vec2[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let best = -1, bd = tol;
    const ax = pts[a].x, ay = pts[a].y, ex = pts[b].x - ax, ey = pts[b].y - ay;
    const l2 = ex * ex + ey * ey;
    for (let i = a + 1; i < b; i++) {
      const wx = pts[i].x - ax, wy = pts[i].y - ay;
      const t = l2 > 0 ? Math.min(Math.max((wx * ex + wy * ey) / l2, 0), 1) : 0;
      const d = Math.hypot(wx - ex * t, wy - ey * t);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i] === 1);
}
