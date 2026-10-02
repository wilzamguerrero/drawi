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

      // Cuello: grueso cuando casi se tocan, se afina al alejarse (t^2).
      const t = 1 - gap / reach;
      const neck = Math.min(a.radius, b.radius) * 0.55 * t * t;
      if (neck < 1) continue;

      const cb = hexToRgb(b.color);
      links.push({
        ax: a.pos.x,
        ay: a.pos.y,
        bx: b.pos.x,
        by: b.pos.y,
        r: neck,
        k: Math.max(4, neck),
        phase: ((i * 73856093) ^ (j * 19349663)) % 628 / 100,
        r8: Math.round((ca.r + cb.r) * 0.5),
        g8: Math.round((ca.g + cb.g) * 0.5),
        b8: Math.round((ca.b + cb.b) * 0.5),
      });
    }
  }
  return links;
}

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

/**
 * Distancia con signo de un puente segun su estilo (espejo CPU del shader).
 *  0 = recto, 1 = desgarrado, 2 = organico (ondula; con `time` se mueve).
 */
export function linkField(
  px: number,
  py: number,
  link: BridgeLink,
  style: number,
  time: number,
): number {
  const bax = link.bx - link.ax;
  const bay = link.by - link.ay;
  const len = Math.max(1e-4, Math.hypot(bax, bay));
  const dirx = bax / len;
  const diry = bay / len;
  const pax = px - link.ax;
  const pay = py - link.ay;
  const along = pax * dirx + pay * diry;
  const h = Math.min(1, Math.max(0, along / len));

  if (style === 1) {
    const proj = Math.min(len, Math.max(0, along));
    const base = Math.hypot(px - (link.ax + dirx * proj), py - (link.ay + diry * proj));
    const beads = 0.5 + 0.5 * Math.cos(h * len * 0.09 + link.phase);
    const rr = link.r * (beads * beads * 1.35 - 0.18);
    return base - rr;
  }
  if (style === 2) {
    const perp = pax * -diry + pay * dirx;
    const amp = link.r * 1.1;
    const freq = 6.2831 * (len / 220 + 0.5);
    const wob = amp * Math.sin(h * freq + time * 1.6 + link.phase);
    const dLine = Math.abs(perp - wob);
    const d =
      along < 0
        ? Math.hypot(pax, pay)
        : along > len
          ? Math.hypot(px - link.bx, py - link.by)
          : dLine;
    return d - link.r;
  }
  const proj = Math.min(len, Math.max(0, along));
  return Math.hypot(px - (link.ax + dirx * proj), py - (link.ay + diry * proj)) - link.r;
}
