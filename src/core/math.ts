/** Scalar helpers shared across the whole engine. Keep allocation free. */

export const TAU = Math.PI * 2
export const EPS = 1e-6

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Inverse lerp, safe against a === b. */
export const invLerp = (a: number, b: number, v: number): number =>
  Math.abs(b - a) < EPS ? 0 : (v - a) / (b - a)

export const remap = (
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number => lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)))

export const smoothstep = (t: number): number => {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

export const smootherstep = (t: number): number => {
  const x = clamp01(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/**
 * Framerate independent exponential smoothing.
 * `halfLife` is expressed in milliseconds: the time needed to close half the gap.
 */
export const damp = (
  current: number,
  target: number,
  halfLife: number,
  dt: number
): number => {
  if (halfLife <= 0) return target
  const t = 1 - Math.pow(2, -dt / halfLife)
  return current + (target - current) * t
}

/** Shortest signed angular difference in radians, in (-PI, PI]. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  else if (d < -Math.PI) d += TAU
  return d
}

export const lerpAngle = (a: number, b: number, t: number): number =>
  a + angleDelta(a, b) * t

/** Polynomial smooth minimum (iq). k controls the blend radius in world units. */
export const smin = (a: number, b: number, k: number): number => {
  if (k <= EPS) return Math.min(a, b)
  const h = clamp01(0.5 + (0.5 * (b - a)) / k)
  return lerp(b, a, h) - k * h * (1 - h)
}

/** Polynomial smooth maximum — the subtraction counterpart of `smin`. */
export const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k)

/** Applies a gamma-like response curve to a normalised value. */
export const curve = (v: number, gamma: number): number =>
  gamma === 1 ? clamp01(v) : Math.pow(clamp01(v), gamma)

/**
 * Signed area of a polygon (shoelace). Positive when counter-clockwise in a
 * y-down screen space, which is what every canvas path here uses.
 */
export const polygonArea = (pts: ArrayLike<number>): number => {
  const n = pts.length / 2
  if (n < 3) return 0
  let area = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1]
  }
  return area * 0.5
}
