import type { Vec2 } from "./vec2";

/**
 * Matriz afin 2D en convencion canvas: [a c e ; b d f].
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export interface Mat2d {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const identity = (): Mat2d => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export const isIdentity = (m: Mat2d): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

/** m1 seguido de m2 (aplica primero m1). */
export const multiply = (m2: Mat2d, m1: Mat2d): Mat2d => ({
  a: m2.a * m1.a + m2.c * m1.b,
  b: m2.b * m1.a + m2.d * m1.b,
  c: m2.a * m1.c + m2.c * m1.d,
  d: m2.b * m1.c + m2.d * m1.d,
  e: m2.a * m1.e + m2.c * m1.f + m2.e,
  f: m2.b * m1.e + m2.d * m1.f + m2.f,
});

export const apply = (m: Mat2d, p: Vec2, out: Vec2 = { x: 0, y: 0 }): Vec2 => {
  const x = p.x;
  const y = p.y;
  out.x = m.a * x + m.c * y + m.e;
  out.y = m.b * x + m.d * y + m.f;
  return out;
};

/** Solo la parte lineal: util para direcciones y normales. */
export const applyDir = (m: Mat2d, p: Vec2, out: Vec2 = { x: 0, y: 0 }): Vec2 => {
  const x = p.x;
  const y = p.y;
  out.x = m.a * x + m.c * y;
  out.y = m.b * x + m.d * y;
  return out;
};

export const translation = (tx: number, ty: number): Mat2d => ({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: tx,
  f: ty,
});

export const rotationAround = (angle: number, ox: number, oy: number): Mat2d => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    a: c,
    b: s,
    c: -s,
    d: c,
    e: ox - (c * ox - s * oy),
    f: oy - (s * ox + c * oy),
  };
};

/** Reflexion respecto de la recta que pasa por (ox, oy) con angulo `angle`. */
export const reflectionAbout = (angle: number, ox: number, oy: number): Mat2d => {
  const c = Math.cos(2 * angle);
  const s = Math.sin(2 * angle);
  return {
    a: c,
    b: s,
    c: s,
    d: -c,
    e: ox - (c * ox + s * oy),
    f: oy - (s * ox - c * oy),
  };
};

export const scaleAround = (sx: number, sy: number, ox: number, oy: number): Mat2d => ({
  a: sx,
  b: 0,
  c: 0,
  d: sy,
  e: ox - sx * ox,
  f: oy - sy * oy,
});

export const determinant = (m: Mat2d): number => m.a * m.d - m.b * m.c;

/** Factor de escala medio: sirve para ajustar grosores tras transformar. */
export const meanScale = (m: Mat2d): number => Math.sqrt(Math.abs(determinant(m))) || 1;

export const invert = (m: Mat2d): Mat2d | null => {
  const det = determinant(m);
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
};

export const setTransform = (ctx: CanvasRenderingContext2D, m: Mat2d): void => {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
};

export const transformCtx = (ctx: CanvasRenderingContext2D, m: Mat2d): void => {
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
};

export const toSvgMatrix = (m: Mat2d, digits = 4): string =>
  `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Number(v.toFixed(digits))).join(" ")})`;
