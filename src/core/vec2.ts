/** Vector 2D mutable-opcional. Se evitan asignaciones en rutas calientes. */

export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const set = (out: Vec2, x: number, y: number): Vec2 => {
  out.x = x;
  out.y = y;
  return out;
};
export const copy = (out: Vec2, a: Vec2): Vec2 => set(out, a.x, a.y);

export const add = (a: Vec2, b: Vec2, out: Vec2 = v2()): Vec2 => set(out, a.x + b.x, a.y + b.y);
export const sub = (a: Vec2, b: Vec2, out: Vec2 = v2()): Vec2 => set(out, a.x - b.x, a.y - b.y);
export const mul = (a: Vec2, s: number, out: Vec2 = v2()): Vec2 => set(out, a.x * s, a.y * s);
export const addScaled = (a: Vec2, b: Vec2, s: number, out: Vec2 = v2()): Vec2 =>
  set(out, a.x + b.x * s, a.y + b.y * s);

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** Producto cruz escalar (componente z). */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const crossVS = (a: Vec2, s: number, out: Vec2 = v2()): Vec2 => set(out, s * a.y, -s * a.x);
export const crossSV = (s: number, a: Vec2, out: Vec2 = v2()): Vec2 => set(out, -s * a.y, s * a.x);

export const lenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const normalize = (a: Vec2, out: Vec2 = v2()): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? set(out, a.x / l, a.y / l) : set(out, 0, 0);
};

/** Perpendicular hacia la izquierda (rotación +90°). */
export const perp = (a: Vec2, out: Vec2 = v2()): Vec2 => set(out, -a.y, a.x);

export const lerpV = (a: Vec2, b: Vec2, t: number, out: Vec2 = v2()): Vec2 =>
  set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

export const rotate = (a: Vec2, angle: number, out: Vec2 = v2()): Vec2 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return set(out, a.x * c - a.y * s, a.x * s + a.y * c);
};

export const rotateAround = (a: Vec2, pivot: Vec2, angle: number, out: Vec2 = v2()): Vec2 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = a.x - pivot.x;
  const dy = a.y - pivot.y;
  return set(out, pivot.x + dx * c - dy * s, pivot.y + dx * s + dy * c);
};

/** Refleja `a` respecto de una recta que pasa por `origin` con dirección `dir` (unitaria). */
export const reflectLine = (a: Vec2, origin: Vec2, dir: Vec2, out: Vec2 = v2()): Vec2 => {
  const dx = a.x - origin.x;
  const dy = a.y - origin.y;
  const d = dx * dir.x + dy * dir.y;
  return set(out, origin.x + 2 * d * dir.x - dx, origin.y + 2 * d * dir.y - dy);
};

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (angle: number, r = 1, out: Vec2 = v2()): Vec2 =>
  set(out, Math.cos(angle) * r, Math.sin(angle) * r);
