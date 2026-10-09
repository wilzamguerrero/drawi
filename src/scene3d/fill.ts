/**
 * Manchas rellenas sobre un plano.
 *
 * En 2D un relleno es tinta dentro de un contorno. En 3D no puede ser eso: la
 * cinta con la que se dibujan los trazos es un quad por segmento, y un quad no
 * tiene interior. Una mancha es una SUPERFICIE con area, asi que es una primitiva
 * propia.
 *
 * El dato que se guarda es el CONTORNO -lo que el usuario dibujo- y los
 * triangulos son geometria derivada, como los segmentos lo son del trazo. De ahi
 * salen dos cosas: editar la mancha mas adelante sera editar su contorno, y el
 * archivo guarda lo que se dibujo y no el resultado de triangulacion, que cambia
 * en cuanto se toque el algoritmo.
 */

import { v3, type V3 } from "./vec3";
import { EMPTY_BOUNDS3, type Bounds3 } from "./types";

export interface Fill3D {
  id: string;
  color: string;
  layerId: string;
  /** Contorno cerrado en mundo: `count` puntos, tres floats cada uno. */
  outline: Float32Array;
  count: number;
  bounds: Bounds3;
  /** Normal del plano sobre el que se dibujo. Es lo que permite sombrear la
   *  mancha como una superficie plana en vez de como un recorte sin orientacion. */
  planeNormal: V3 | null;
}

/** Puntos maximos del contorno. Mas alla, la triangulacion deja de compensar. */
export const MAX_OUTLINE_POINTS = 512;

/** Caja envolvente de un contorno suelto (sin radio que sumar). */
export const outlineBounds = (outline: Float32Array, count: number): Bounds3 => {
  if (count <= 0) return { ...EMPTY_BOUNDS3 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const x = outline[o];
    const y = outline[o + 1];
    const z = outline[o + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
};

/**
 * Normal del contorno por el metodo de Newell.
 *
 * Se prefiere la del plano de dibujo cuando la hay. Newell es el respaldo para un
 * contorno trazado en el aire: promedia las normales de las triangulaciones
 * implicitas, asi que un contorno con ruido no la desvia como haria un producto
 * cruzado de dos aristas cualesquiera.
 */
export const outlineNormal = (outline: Float32Array, count: number, out: V3 = v3()): V3 => {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < count; i++) {
    const a = i * 3;
    const b = ((i + 1) % count) * 3;
    const ax = outline[a];
    const ay = outline[a + 1];
    const az = outline[a + 2];
    const bx = outline[b];
    const by = outline[b + 1];
    const bz = outline[b + 2];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) return v3(0, 0, 1);
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return out;
};

/** Base ortonormal del plano del contorno: eje X, eje Y y normal. */
const planeBasis = (
  outline: Float32Array,
  count: number,
  normal: V3,
): { ux: number; uy: number; uz: number; wx: number; wy: number; wz: number } => {
  // El eje X sale de la arista mas larga: es la que menos se nota si el contorno
  // tiene los primeros puntos casi pegados.
  let bestI = 0;
  let bestJ = 1 % count;
  let best = -1;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const dx = outline[j * 3] - outline[i * 3];
    const dy = outline[j * 3 + 1] - outline[i * 3 + 1];
    const dz = outline[j * 3 + 2] - outline[i * 3 + 2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d > best) {
      best = d;
      bestI = i;
      bestJ = j;
    }
  }
  let ux = outline[bestJ * 3] - outline[bestI * 3];
  let uy = outline[bestJ * 3 + 1] - outline[bestI * 3 + 1];
  let uz = outline[bestJ * 3 + 2] - outline[bestI * 3 + 2];
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // w = normal x u
  const wx = normal.y * uz - normal.z * uy;
  const wy = normal.z * ux - normal.x * uz;
  const wz = normal.x * uy - normal.y * ux;
  const wl = Math.hypot(wx, wy, wz) || 1;
  return { ux, uy, uz, wx: wx / wl, wy: wy / wl, wz: wz / wl };
};

/** Area con signo de un poligono 2D. Positiva en sentido antihorario. */
const signedArea = (xs: Float64Array, ys: Float64Array, n: number): number => {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return a * 0.5;
};

/** ¿Esta el punto dentro del triangulo (a, b, c)? Sirve para descartar orejas. */
const inTriangle = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean => {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
};

/**
 * Triangula el contorno y devuelve las posiciones listas para la GPU.
 *
 * Se usa **recorte de orejas** y no un abanico desde el centro: un abanico solo
 * rellena bien lo convexo, y un contorno trazado a mano tiene entrantes con
 * facilidad, donde el abanico deja triangulos fuera y huecos dentro.
 *
 * Si el contorno se cruza consigo mismo el recorte no encuentra orejas y se
 * abandona; entonces se cae al abanico, que al menos rellena la silueta convexa en
 * vez de no dibujar nada.
 *
 * Devuelve un array vacio si el contorno no tiene area.
 */
export const triangulateOutline = (
  outline: Float32Array,
  count: number,
  planeNormal: V3 | null,
): Float32Array => {
  if (count < 3) return new Float32Array(0);

  const n = planeNormal ? planeNormal : outlineNormal(outline, count);
  const basis = planeBasis(outline, count, n);
  const ox = outline[0];
  const oy = outline[1];
  const oz = outline[2];

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const dx = outline[i * 3] - ox;
    const dy = outline[i * 3 + 1] - oy;
    const dz = outline[i * 3 + 2] - oz;
    xs[i] = dx * basis.ux + dy * basis.uy + dz * basis.uz;
    ys[i] = dx * basis.wx + dy * basis.wy + dz * basis.wz;
  }

  const area = signedArea(xs, ys, count);
  if (Math.abs(area) < 1e-9) return new Float32Array(0);

  // El recorte de orejas exige un sentido de giro concreto; si el contorno se
  // dibujo al reves, se invierte el orden de los indices y listo.
  const order: number[] = [];
  if (area > 0) for (let i = 0; i < count; i++) order.push(i);
  else for (let i = count - 1; i >= 0; i--) order.push(i);

  const tris: number[] = [];
  const remaining = order.slice();
  let guard = remaining.length * remaining.length + 16;

  while (remaining.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i + remaining.length - 1) % remaining.length];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % remaining.length];

      // Oreja convexa: el giro en `ib` tiene que ir en el sentido del poligono.
      const cross = (xs[ib] - xs[ia]) * (ys[ic] - ys[ib]) - (ys[ib] - ys[ia]) * (xs[ic] - xs[ib]);
      if (cross <= 0) continue;

      let limpia = true;
      for (const k of remaining) {
        if (k === ia || k === ib || k === ic) continue;
        if (inTriangle(xs[k], ys[k], xs[ia], ys[ia], xs[ib], ys[ib], xs[ic], ys[ic])) {
          limpia = false;
          break;
        }
      }
      if (!limpia) continue;

      tris.push(ia, ib, ic);
      remaining.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }

  if (remaining.length === 3) {
    // El triangulo que queda siempre es valido: es el que cierra el poligono.
    tris.push(remaining[0], remaining[1], remaining[2]);
  } else if (remaining.length > 3) {
    // El recorte se atasco a medio camino -pasa si el contorno se cruza consigo
    // mismo-. Se remata lo que queda con un abanico desde su primer vertice, que
    // al menos cierra ese trozo, en vez de tirar tambien las orejas ya cortadas.
    for (let i = 1; i + 1 < remaining.length; i++) {
      tris.push(remaining[0], remaining[i], remaining[i + 1]);
    }
  }

  const out = new Float32Array(tris.length * 3);
  for (let t = 0; t < tris.length; t++) {
    const p = tris[t] * 3;
    out[t * 3] = outline[p];
    out[t * 3 + 1] = outline[p + 1];
    out[t * 3 + 2] = outline[p + 2];
  }
  return out;
};

/**
 * Area de una lista de triangulos. Es la magnitud con la que se comprueba que la
 * triangulacion cubre el contorno y no lo deja a medias.
 */
export const trianglesArea = (positions: Float32Array): number => {
  let total = 0;
  for (let t = 0; t + 8 < positions.length; t += 9) {
    const ax = positions[t];
    const ay = positions[t + 1];
    const az = positions[t + 2];
    const bx = positions[t + 3];
    const by = positions[t + 4];
    const bz = positions[t + 5];
    const cx = positions[t + 6];
    const cy = positions[t + 7];
    const cz = positions[t + 8];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    total += Math.hypot(nx, ny, nz) * 0.5;
  }
  return total;
};

/** Area del contorno proyectada sobre su plano. */
export const outlineArea = (outline: Float32Array, count: number, planeNormal: V3 | null): number => {
  if (count < 3) return 0;
  const n = planeNormal ? planeNormal : outlineNormal(outline, count);
  const basis = planeBasis(outline, count, n);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const dx = outline[i * 3] - outline[0];
    const dy = outline[i * 3 + 1] - outline[1];
    const dz = outline[i * 3 + 2] - outline[2];
    xs[i] = dx * basis.ux + dy * basis.uy + dz * basis.uz;
    ys[i] = dx * basis.wx + dy * basis.wy + dz * basis.wz;
  }
  return Math.abs(signedArea(xs, ys, count));
};

/** Construye la mancha a partir de su contorno. */
export const makeFill = (
  id: string,
  outline: Float32Array,
  count: number,
  opts: { color: string; layerId: string; planeNormal: V3 | null },
): Fill3D => ({
  id,
  color: opts.color,
  layerId: opts.layerId,
  outline,
  count,
  bounds: outlineBounds(outline, count),
  planeNormal: opts.planeNormal ? { ...opts.planeNormal } : null,
});

/**
 * Lote de manchas: una malla por pareja (capa, color).
 *
 * Aqui no hay el problema de los trazos -miles de mallas de dos triangulos-, pero
 * la regla es la misma: una llamada de dibujado por lote y nada de una malla por
 * mancha. Y a diferencia de los trazos, aqui **se rehace la malla entera cuando la
 * lista cambia**: las manchas se crean de una en una y se cuentan por decenas, no
 * por miles, asi que retriangular solo lo que cambio seria complicar el codigo
 * para ahorrar un trabajo que no se nota.
 */
export class FillBatch {
  readonly layerId: string;
  readonly color: string;
  /** Posiciones de los triangulos de todas sus manchas, contiguas. */
  positions: Float32Array = new Float32Array(0);
  /**
   * Normal de cada vertice, en el mismo orden que `positions`.
   *
   * Va por vertice y no como uniforme del lote porque un lote agrupa manchas de
   * una misma capa y color, y esas pueden estar en planos distintos.
   */
  normals: Float32Array = new Float32Array(0);
  /** Vertices ocupados (no triangulos). */
  vertices = 0;
  /** Sube con cada cambio: la GPU lo usa para saber si debe resubir. */
  revision = 0;

  constructor(layerId: string, color: string) {
    this.layerId = layerId;
    this.color = color;
  }

  /** Rehace la malla a partir de las manchas dadas. */
  rebuild(fills: readonly Fill3D[]): void {
    const partes: Float32Array[] = [];
    const normales: Float32Array[] = [];
    let total = 0;
    for (const f of fills) {
      const tris = triangulateOutline(f.outline, f.count, f.planeNormal);
      if (tris.length === 0) continue;
      const n = f.planeNormal ?? outlineNormal(f.outline, f.count);
      const ns = new Float32Array(tris.length);
      for (let i = 0; i < tris.length; i += 3) {
        ns[i] = n.x;
        ns[i + 1] = n.y;
        ns[i + 2] = n.z;
      }
      partes.push(tris);
      normales.push(ns);
      total += tris.length;
    }

    const nextP = new Float32Array(total);
    const nextN = new Float32Array(total);
    let at = 0;
    for (let i = 0; i < partes.length; i++) {
      nextP.set(partes[i], at);
      nextN.set(normales[i], at);
      at += partes[i].length;
    }
    this.positions = nextP;
    this.normals = nextN;
    this.vertices = total / 3;
    this.revision++;
  }

  get bytes(): number {
    return this.positions.byteLength + this.normals.byteLength;
  }
}

/** ¿Son la misma lista, objeto a objeto? */
const sameFills = (a: readonly Fill3D[], b: readonly Fill3D[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Conjunto de lotes de manchas de la escena.
 *
 * Igual que `StrokeScene`, es una funcion pura de la lista del documento: de ahi
 * salen gratis deshacer, rehacer y editar. La diferencia es como detecta el
 * cambio: alli se reconcilia trazo a trazo porque son miles, y aqui se comparan
 * las referencias de la lista entera porque son decenas.
 */
export class FillScene {
  private batches = new Map<string, FillBatch>();
  private order: string[] = [];
  private last: readonly Fill3D[] = [];

  get all(): readonly FillBatch[] {
    return this.order.map((k) => this.batches.get(k) as FillBatch);
  }

  /** Devuelve `true` si hubo que rehacer las mallas. */
  sync(fills: readonly Fill3D[]): boolean {
    if (sameFills(this.last, fills)) return false;
    this.last = fills.slice();

    const porClave = new Map<string, Fill3D[]>();
    for (const f of fills) {
      const key = `${f.layerId}|${f.color}`;
      const list = porClave.get(key);
      if (list) list.push(f);
      else porClave.set(key, [f]);
    }

    this.batches.clear();
    this.order = [];
    for (const [key, list] of porClave) {
      const first = list[0];
      const batch = new FillBatch(first.layerId, first.color);
      batch.rebuild(list);
      this.batches.set(key, batch);
      this.order.push(key);
    }
    return true;
  }

  get bytes(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.bytes;
    return n;
  }

  /** Manchas dibujables: lote a lote, cuantas aportan triangulos. */
  get vertices(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.vertices;
    return n;
  }
}
