import { hexToRgb } from "../core/color";
import type { Body } from "./world";

/**
 * Puentes dirigidos entre cuerpos.
 *
 * En vez de inflar el radio de fusion global (lo que deforma todo el campo y
 * crea "almendras" flotantes entre cuerpos que no deberian conectarse), se
 * precalcula una lista de enlaces concretos: cada cuerpo tiende un puente SOLO
 * hacia los otros cuerpos que caen dentro de su radio de alcance, a lo largo de
 * la recta que une sus centros. Asi el puente es dirigido (nunca sale "hacia
 * todos lados") y el coste por pixel escala con el numero real de enlaces, no
 * con el cuadrado de los cuerpos.
 */
export interface BridgeLink {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Grosor del cuello en el centro del puente, en unidades de mundo. */
  r: number;
  /** Radio de fusion suave del enlace con el resto del campo. */
  k: number;
  /** Desfase propio del enlace (para que cada puente ondule distinto). */
  phase: number;
  /** Color mezclado de los dos cuerpos. */
  r8: number;
  g8: number;
  b8: number;
  /** Caja envolvente (ya expandida) para descarte rapido por pixel en CPU. */
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

/** Alcance efectivo de un cuerpo: propio si >= 0, si no el global. */
export function bodyReach(body: Body, globalReach: number): number {
  return body.bridgeReach >= 0 ? body.bridgeReach : globalReach;
}

/**
 * Calcula los puentes activos. O(n^2) una sola vez por frame (barato para
 * cientos de cuerpos); el resultado se reutiliza en todos los pixeles.
 */
export function computeBridges(bodies: readonly Body[], globalReach: number): BridgeLink[] {
  const links: BridgeLink[] = [];
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    const ra = bodyReach(a, globalReach);
    if (ra <= 0) continue;
    const ca = hexToRgb(a.color);
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      const rb = bodyReach(b, globalReach);
      if (rb <= 0) continue;
      // Solo se funden cuerpos del mismo grupo (0 = cualquiera), igual que el campo.
      if (a.group !== 0 && b.group !== 0 && a.group !== b.group) continue;

      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const dist = Math.hypot(dx, dy);
      const gap = dist - a.radius - b.radius; // separacion borde a borde
      const reach = Math.max(ra, rb);
      if (gap <= 0 || gap >= reach) continue; // ya se tocan, o demasiado lejos

      // Cuello: grueso cuando casi se tocan, se afina al alejarse (taper lineal).
      // Se corta por debajo de ~4px en vez de dejar un hilo subpixel: un cuello
      // mas fino que una celda de marching squares (o que un pixel en GPU) se
      // rompe en guiones; mejor cortar limpio y que reaparezca al acercar.
      const t = 1 - gap / reach;
      const neck = Math.min(a.radius, b.radius) * 0.6 * t;
      if (neck < 4) continue;

      const cb = hexToRgb(b.color);
      const k = Math.max(4, neck);
      // Margen amplio: hilos, ondulacion organica y ensanche extienden el relleno
      // bastante mas alla del cuello recto; si la caja queda corta, el puente se
      // recorta en CPU. Mejor sobrar que cortar.
      const pad = neck * 4 + k + 4;
      links.push({
        ax: a.pos.x,
        ay: a.pos.y,
        bx: b.pos.x,
        by: b.pos.y,
        r: neck,
        k,
        phase: ((i * 73856093) ^ (j * 19349663)) % 628 / 100,
        r8: Math.round((ca.r + cb.r) * 0.5),
        g8: Math.round((ca.g + cb.g) * 0.5),
        b8: Math.round((ca.b + cb.b) * 0.5),
        minx: Math.min(a.pos.x, b.pos.x) - pad,
        miny: Math.min(a.pos.y, b.pos.y) - pad,
        maxx: Math.max(a.pos.x, b.pos.x) + pad,
        maxy: Math.max(a.pos.y, b.pos.y) + pad,
      });
    }
  }
  return links;
}

/** Parte fraccionaria (espejo de fract() de GLSL). */
const fract = (x: number): number => x - Math.floor(x);

/** Distancia con signo a un segmento (para el cuello capsular del puente). */
export function sdSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom < 1e-9 ? 0 : Math.min(1, Math.max(0, (pax * bax + pay * bay) / denom));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.hypot(dx, dy);
}

/** Opciones de render de los puentes (espejo de los uniforms del shader). */
export interface BridgeOpts {
  style: number;
  threads: number;
  flare: number;
  time: number;
}

export const DEFAULT_BRIDGE_OPTS: BridgeOpts = { style: 0, threads: 1, flare: 0, time: 0 };

/**
 * Distancia con signo de un puente segun su estilo y conectores (espejo CPU
 * del shader). style: 0 recto, 1 desgarrado (agujeros), 2 organico (ondula).
 * `threads` divide el puente en hilos; `flare` lo ensancha en los extremos.
 */
export function linkField(
  px: number,
  py: number,
  link: BridgeLink,
  opts: BridgeOpts,
): number {
  const { style, time } = opts;
  const bax = link.bx - link.ax;
  const bay = link.by - link.ay;
  const len = Math.max(1e-4, Math.hypot(bax, bay));
  const dirx = bax / len;
  const diry = bay / len;
  const pax = px - link.ax;
  const pay = py - link.ay;
  const along = pax * dirx + pay * diry;
  const h = Math.min(1, Math.max(0, along / len));
  const perp = pax * -diry + pay * dirx;

  const ends = Math.pow(Math.abs(2 * h - 1), 2);
  const rLocal = link.r * (1 + opts.flare * 1.6 * ends);
  const fan = Math.pow(Math.abs(2 * h - 1), 1.6);
  const merge = 1 - fan;
  const n = opts.threads < 1 ? 1 : opts.threads;
  const threadR = rLocal * (1 / Math.sqrt(n) + (1 - 1 / Math.sqrt(n)) * merge);
  const spread = link.r * 1.5;
  const env = 1 - ends;
  let best = 1e9;
  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) - 0.5 : 0;
    let off = spread * frac * fan;
    if (style === 2) {
      off += link.r * 1.1 * env * Math.sin(h * (6.2831 * (len / 220 + 0.5)) + time * 1.6 + link.phase + i * 0.6);
    }
    const dline = Math.abs(perp - off);
    const d = along < 0 ? Math.hypot(pax, pay) : along > len ? Math.hypot(px - link.bx, py - link.by) : dline;
    best = Math.min(best, d - threadR);
  }

  if (style === 1) {
    const cell = Math.max(6, link.r * 2.2);
    const idx = Math.floor(along / cell);
    const localc = along - (idx + 0.5) * cell;
    const rnd = fract(Math.sin(idx * 12.9898 + link.phase * 7) * 43758.5453);
    const rnd2 = fract(Math.sin(idx * 78.233 + link.phase * 3) * 24634.6345);
    const holeR = link.r * (0.3 + 0.45 * rnd);
    const perpOff = (rnd2 - 0.5) * link.r * 0.9;
    const dh = Math.hypot(localc, perp - perpOff) - holeR;
    best = Math.max(best, -dh);
  }
  return best;
}
