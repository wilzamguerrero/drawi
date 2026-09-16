import type { Mat2d } from "../core/mat2d";
import type { Polygon } from "../stroke/types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

/**
 * Un item de tinta es el resultado de UNA accion de dibujo.
 *
 * Se guarda la geometria base una sola vez y, aparte, la lista de
 * transformaciones de simetria vigentes en el momento de trazarla. Asi mover
 * la simetria despues no deforma lo ya dibujado, y pintar N copias cuesta
 * N `ctx.transform` sobre el mismo Path2D en vez de N geometrias.
 */
export interface InkItem {
  id: string;
  polys: Polygon[];
  transforms: Mat2d[];
  color: string;
  opacity: number;
  /** Silueta suavizada (curvas) o angulosa (modificador splat). */
  smooth: boolean;
  gradient: boolean;
  /** Extremos del degradado en Y de mundo. */
  gy0: number;
  gy1: number;
  bounds: Rect;
}

export const unionRect = (a: Rect | null, b: Rect): Rect => {
  if (!a || a.w <= 0) return { ...b };
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.w, b.x + b.w);
  const maxY = Math.max(a.y + a.h, b.y + b.h);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

export const expandRect = (r: Rect, m: number): Rect => ({
  x: r.x - m,
  y: r.y - m,
  w: r.w + m * 2,
  h: r.h + m * 2,
});

export const rectIntersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
