/**
 * 2D affine transforms in the same component order the Canvas API uses:
 *
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 *
 * Kept as plain objects so they can be stored in the document, serialised to
 * JSON, and handed straight to `ctx.setTransform` without conversion.
 */

export interface Mat2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const identity = (): Mat2D => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

export const copyMat = (m: Mat2D): Mat2D => ({ ...m })

export const isIdentity = (m: Mat2D): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0

/** out = m * n — applies `n` first, then `m`. */
export const multiply = (m: Mat2D, n: Mat2D, out: Mat2D = identity()): Mat2D => {
  const a = m.a * n.a + m.c * n.b
  const b = m.b * n.a + m.d * n.b
  const c = m.a * n.c + m.c * n.d
  const d = m.b * n.c + m.d * n.d
  const e = m.a * n.e + m.c * n.f + m.e
  const f = m.b * n.e + m.d * n.f + m.f
  out.a = a
  out.b = b
  out.c = c
  out.d = d
  out.e = e
  out.f = f
  return out
}

export const translation = (x: number, y: number): Mat2D => ({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: x,
  f: y,
})

export const rotation = (angle: number): Mat2D => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 }
}

export const scaling = (sx: number, sy: number = sx): Mat2D => ({
  a: sx,
  b: 0,
  c: 0,
  d: sy,
  e: 0,
  f: 0,
})

/** Rotation by `angle` about `(cx, cy)`. */
export const rotationAround = (
  angle: number,
  cx: number,
  cy: number
): Mat2D => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return {
    a: c,
    b: s,
    c: -s,
    d: c,
    e: cx - cx * c + cy * s,
    f: cy - cx * s - cy * c,
  }
}

/**
 * Reflection across the line through `(cx, cy)` with direction `angle`.
 * This is the primitive every mirror axis in the symmetry engine is built from.
 */
export const reflectionAcross = (
  angle: number,
  cx: number,
  cy: number
): Mat2D => {
  const c = Math.cos(2 * angle)
  const s = Math.sin(2 * angle)
  return {
    a: c,
    b: s,
    c: s,
    d: -c,
    e: cx - cx * c - cy * s,
    f: cy - cx * s + cy * c,
  }
}

export const determinant = (m: Mat2D): number => m.a * m.d - m.b * m.c

/** True when the transform flips handedness — a mirrored copy. */
export const isMirrored = (m: Mat2D): boolean => determinant(m) < 0

export const invert = (m: Mat2D): Mat2D => {
  const det = determinant(m)
  if (Math.abs(det) < 1e-12) return identity()
  const inv = 1 / det
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  }
}

export const applyX = (m: Mat2D, x: number, y: number): number =>
  m.a * x + m.c * y + m.e

export const applyY = (m: Mat2D, x: number, y: number): number =>
  m.b * x + m.d * y + m.f

/** Transforms a direction (ignores translation). */
export const applyDirX = (m: Mat2D, x: number, y: number): number =>
  m.a * x + m.c * y

export const applyDirY = (m: Mat2D, x: number, y: number): number =>
  m.b * x + m.d * y

/** Average scale factor, used to keep stroke widths consistent under a transform. */
export const meanScale = (m: Mat2D): number =>
  (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) * 0.5

/** Transforms a flat [x, y, ...] buffer in place or into `out`. */
export const applyToBuffer = (
  m: Mat2D,
  points: Float32Array,
  count: number,
  out: Float32Array = points
): Float32Array => {
  for (let i = 0; i < count; i++) {
    const x = points[i * 2]
    const y = points[i * 2 + 1]
    out[i * 2] = m.a * x + m.c * y + m.e
    out[i * 2 + 1] = m.b * x + m.d * y + m.f
  }
  return out
}
