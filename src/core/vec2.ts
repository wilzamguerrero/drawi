/**
 * Flat, mutation-first 2D vector helpers.
 *
 * The hot paths (stroke outlining, physics solving, field sampling) run tens of
 * thousands of times per frame, so every function here has an `*Into` variant
 * that writes to a caller-owned target and never allocates.
 */

export type Vec2 = { x: number; y: number }

export const vec = (x = 0, y = 0): Vec2 => ({ x, y })

export const set = (out: Vec2, x: number, y: number): Vec2 => {
  out.x = x
  out.y = y
  return out
}

export const copy = (out: Vec2, a: Vec2): Vec2 => set(out, a.x, a.y)

export const addInto = (out: Vec2, a: Vec2, b: Vec2): Vec2 =>
  set(out, a.x + b.x, a.y + b.y)

export const subInto = (out: Vec2, a: Vec2, b: Vec2): Vec2 =>
  set(out, a.x - b.x, a.y - b.y)

export const scaleInto = (out: Vec2, a: Vec2, s: number): Vec2 =>
  set(out, a.x * s, a.y * s)

/** out = a + b * s — the fused multiply-add of vector code. */
export const addScaledInto = (out: Vec2, a: Vec2, b: Vec2, s: number): Vec2 =>
  set(out, a.x + b.x * s, a.y + b.y * s)

export const lerpInto = (out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 =>
  set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y

/** 2D cross product magnitude — the z of the 3D cross. Sign gives turn direction. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x

export const len = (a: Vec2): number => Math.hypot(a.x, a.y)

export const len2 = (a: Vec2): number => a.x * a.x + a.y * a.y

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y)

export const dist2 = (a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dx * dx + dy * dy
}

export const normalizeInto = (out: Vec2, a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y)
  return l > 1e-9 ? set(out, a.x / l, a.y / l) : set(out, 0, 0)
}

/** Left-hand perpendicular: rotates by -90 degrees in screen space. */
export const perpInto = (out: Vec2, a: Vec2): Vec2 => set(out, a.y, -a.x)

export const rotateInto = (out: Vec2, a: Vec2, angle: number): Vec2 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return set(out, a.x * c - a.y * s, a.x * s + a.y * c)
}

export const rotateAroundInto = (
  out: Vec2,
  a: Vec2,
  center: Vec2,
  angle: number
): Vec2 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const dx = a.x - center.x
  const dy = a.y - center.y
  return set(out, center.x + dx * c - dy * s, center.y + dx * s + dy * c)
}

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x)

/**
 * Closest point on segment `a`-`b` to `p`, returned as the parametric position
 * along the segment clamped to [0, 1].
 */
export const projectOnSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const l2 = abx * abx + aby * aby
  if (l2 < 1e-12) return 0
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** Distance from `p` to the segment `a`-`b`. The capsule SDF without the radius. */
export const distToSegment = (p: Vec2, a: Vec2, b: Vec2): number => {
  const t = projectOnSegment(p, a, b)
  const cx = a.x + (b.x - a.x) * t
  const cy = a.y + (b.y - a.y) * t
  return Math.hypot(p.x - cx, p.y - cy)
}
