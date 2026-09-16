import { clamp } from "../core/math";
import type { Polygon } from "../stroke/types";
import type { Rect } from "../scene/types";
import { sampleFieldDistance } from "./sdf";
import type { Body } from "./world";

/**
 * Extraccion de contornos del campo combinado por marching squares.
 *
 * El shader pinta el campo en GPU, pero exportar a SVG, hornear la materia a
 * tinta o dibujar sin WebGL necesitan el contorno como poligonos. Se muestrea
 * la distancia en una rejilla, se extraen segmentos por celda y se cosen en
 * lazos cerrados.
 */

export interface ContourOptions {
  /** Lado de celda en unidades de mundo. Menor = mas fiel y mas lento. */
  cell: number;
  /** Isovalor: 0 es la superficie; negativo encoge, positivo engorda. */
  iso: number;
  /** Margen extra alrededor de los cuerpos. */
  padding: number;
  /** Descarta lazos con menos area que esto (ruido de rejilla). */
  minArea: number;
}

export const DEFAULT_CONTOUR: ContourOptions = {
  cell: 4,
  iso: 0,
  padding: 8,
  minArea: 12,
};

/** Caja envolvente de todos los cuerpos mas su radio de fusion. */
export function bodiesBounds(bodies: readonly Body[], blend: number, padding = 0): Rect | null {
  if (bodies.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bodies) {
    const k = (b.blend > 0 ? b.blend : blend) + b.radius + padding;
    if (b.pos.x - k < minX) minX = b.pos.x - k;
    if (b.pos.y - k < minY) minY = b.pos.y - k;
    if (b.pos.x + k > maxX) maxX = b.pos.x + k;
    if (b.pos.y + k > maxY) maxY = b.pos.y + k;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const KEY_SCALE = 16;
const key = (x: number, y: number): string =>
  `${Math.round(x * KEY_SCALE)},${Math.round(y * KEY_SCALE)}`;

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Interpolacion lineal del cruce por el isovalor entre dos muestras. */
const cross = (v0: number, v1: number, iso: number): number => {
  const d = v1 - v0;
  if (Math.abs(d) < 1e-9) return 0.5;
  return clamp((iso - v0) / d, 0, 1);
};

/**
 * Contornos del campo como lazos cerrados en sentido consistente.
 *
 * El interior del campo es `d < iso`, asi que cada celda se codifica con un
 * bit por esquina interior y la tabla de 16 casos da los segmentos. Los casos
 * ambiguos (5 y 10) se resuelven con el valor medio de la celda para no
 * partir puentes finos entre formas.
 */
export function fieldContours(
  bodies: readonly Body[],
  blend: number,
  options: Partial<ContourOptions> = {},
): Polygon[] {
  const opt = { ...DEFAULT_CONTOUR, ...options };
  const box = bodiesBounds(bodies, blend, opt.padding);
  if (!box) return [];

  const cell = Math.max(0.5, opt.cell);
  const cols = Math.min(2048, Math.ceil(box.w / cell) + 1);
  const rows = Math.min(2048, Math.ceil(box.h / cell) + 1);
  if (cols < 2 || rows < 2) return [];

  const stepX = box.w / (cols - 1);
  const stepY = box.h / (rows - 1);

  // Una sola fila viva mas la anterior: evita reservar cols*rows flotantes.
  const field = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = box.y + j * stepY;
    for (let i = 0; i < cols; i++) {
      field[j * cols + i] = sampleFieldDistance(box.x + i * stepX, y, bodies, blend);
    }
  }

  const segments: Segment[] = [];
  const iso = opt.iso;

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const i0 = j * cols + i;
      const v0 = field[i0]; // esquina superior izquierda
      const v1 = field[i0 + 1]; // superior derecha
      const v2 = field[i0 + cols + 1]; // inferior derecha
      const v3 = field[i0 + cols]; // inferior izquierda

      let code = 0;
      if (v0 < iso) code |= 1;
      if (v1 < iso) code |= 2;
      if (v2 < iso) code |= 4;
      if (v3 < iso) code |= 8;
      if (code === 0 || code === 15) continue;

      const x0 = box.x + i * stepX;
      const y0 = box.y + j * stepY;
      const x1 = x0 + stepX;
      const y1 = y0 + stepY;

      // Puntos medios de las cuatro aristas.
      const tx = x0 + cross(v0, v1, iso) * stepX; // arista superior
      const ty = y0;
      const rx = x1;
      const ry = y0 + cross(v1, v2, iso) * stepY; // arista derecha
      const bx = x0 + cross(v3, v2, iso) * stepX; // arista inferior
      const by = y1;
      const lx = x0;
      const ly = y0 + cross(v0, v3, iso) * stepY; // arista izquierda

      const push = (ax: number, ay: number, bx2: number, by2: number): void => {
        segments.push({ ax, ay, bx: bx2, by: by2 });
      };

      switch (code) {
        case 1:
          push(lx, ly, tx, ty);
          break;
        case 2:
          push(tx, ty, rx, ry);
          break;
        case 3:
          push(lx, ly, rx, ry);
          break;
        case 4:
          push(rx, ry, bx, by);
          break;
        case 5: {
          const center = (v0 + v1 + v2 + v3) * 0.25;
          if (center < iso) {
            push(lx, ly, bx, by);
            push(rx, ry, tx, ty);
          } else {
            push(lx, ly, tx, ty);
            push(rx, ry, bx, by);
          }
          break;
        }
        case 6:
          push(tx, ty, bx, by);
          break;
        case 7:
          push(lx, ly, bx, by);
          break;
        case 8:
          push(bx, by, lx, ly);
          break;
        case 9:
          push(bx, by, tx, ty);
          break;
        case 10: {
          const center = (v0 + v1 + v2 + v3) * 0.25;
          if (center < iso) {
            push(tx, ty, rx, ry);
            push(bx, by, lx, ly);
          } else {
            push(tx, ty, lx, ly);
            push(bx, by, rx, ry);
          }
          break;
        }
        case 11:
          push(bx, by, rx, ry);
          break;
        case 12:
          push(rx, ry, lx, ly);
          break;
        case 13:
          push(rx, ry, tx, ty);
          break;
        case 14:
          push(tx, ty, lx, ly);
          break;
      }
    }
  }

  return stitch(segments, Math.max(opt.minArea, 0));
}

/** Cose los segmentos sueltos en lazos siguiendo el extremo compartido. */
function stitch(segments: Segment[], minArea: number): Polygon[] {
  if (segments.length === 0) return [];

  const starts = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const k = key(segments[i].ax, segments[i].ay);
    const list = starts.get(k);
    if (list) list.push(i);
    else starts.set(k, [i]);
  }

  const used = new Uint8Array(segments.length);
  const loops: Polygon[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;

    const first = segments[i];
    const poly: Polygon = [{ x: first.ax, y: first.ay }];
    let cx = first.bx;
    let cy = first.by;
    const startKey = key(first.ax, first.ay);

    // Cada segmento se consume una vez: el bucle no puede exceder su numero.
    for (let guard = 0; guard < segments.length + 1; guard++) {
      poly.push({ x: cx, y: cy });
      const k = key(cx, cy);
      if (k === startKey) break;

      const candidates = starts.get(k);
      let next = -1;
      if (candidates) {
        for (const c of candidates) {
          if (!used[c]) {
            next = c;
            break;
          }
        }
      }
      if (next < 0) break; // contorno abierto: toca el borde de la rejilla
      used[next] = 1;
      cx = segments[next].bx;
      cy = segments[next].by;
    }

    if (poly.length < 3) continue;
    if (Math.abs(polygonArea(poly)) < minArea) continue;
    loops.push(simplify(poly, 0.35));
  }

  return loops;
}

export function polygonArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Simplificacion Douglas-Peucker iterativa.
 *
 * Marching squares produce un vertice por celda cruzada; en un campo grande
 * eso son decenas de miles de puntos por lazo. Recortarlos aqui hace que el
 * SVG exportado y el Path2D horneado sigan siendo manejables.
 */
export function simplify(poly: Polygon, tolerance: number): Polygon {
  const n = poly.length;
  if (n < 4 || tolerance <= 0) return poly;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, n - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const a = poly[first];
    const b = poly[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const p = poly[i];
      let d2: number;
      if (lenSq < 1e-12) {
        const ex = p.x - a.x;
        const ey = p.y - a.y;
        d2 = ex * ex + ey * ey;
      } else {
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
        t = clamp(t, 0, 1);
        const ex = p.x - (a.x + dx * t);
        const ey = p.y - (a.y + dy * t);
        d2 = ex * ex + ey * ey;
      }
      if (d2 > maxDist) {
        maxDist = d2;
        index = i;
      }
    }

    if (maxDist > tol2 && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Polygon = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(poly[i]);
  return out.length >= 3 ? out : poly;
}

/**
 * Color representativo de cada lazo: se muestrea el campo un poco hacia
 * dentro del contorno, donde la mezcla ya se estabilizo.
 */
export function loopInteriorPoint(poly: Polygon): { x: number; y: number } {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  return { x: cx / poly.length, y: cy / poly.length };
}
