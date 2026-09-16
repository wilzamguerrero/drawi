import type { Vec2 } from '@/core/vec2'

/** A pointer sample exactly as it left the device, in document space. */
export interface RawSample {
  x: number
  y: number
  /** Device pressure in [0, 1]. 0.5 is the browser default for pressure-less devices. */
  pressure: number
  /** Stylus tilt in degrees, -90..90 on each axis. 0 when unsupported. */
  tiltX: number
  tiltY: number
  /** Barrel rotation in degrees, 0..359. 0 when unsupported. */
  twist: number
  /** High resolution timestamp in milliseconds. */
  time: number
}

/**
 * A resolved point along the stroke spine.
 *
 * This is the structure the rest of the app consumes: it carries geometry *and*
 * the physical quantities the simulation layer later reads (speed becomes
 * momentum, pressure becomes mass or stiffness, and so on).
 */
export interface SpinePoint {
  x: number
  y: number
  /** Unit direction of travel at this point. */
  dx: number
  dy: number
  /** Half-width of the stroke here, in document units. */
  radius: number
  /** Effective pressure after the model resolved real vs. simulated. */
  pressure: number
  /** Speed in document units per millisecond. */
  speed: number
  /** Cumulative arc length from the start of the stroke. */
  length: number
  time: number
}

export type PressureSource = 'auto' | 'pen' | 'velocity' | 'constant'

/** What the pressure signal drives. The signal itself is always recorded. */
export type PressureTarget =
  | 'width'
  | 'opacity'
  | 'mass'
  | 'elasticity'
  | 'density'
  | 'force'
  | 'scatter'

export interface StrokeOptions {
  /** Nominal stroke diameter in document units. */
  size: number
  /** 0..1 — how much low pressure thins the stroke. */
  thinning: number
  /** 0..1 — how much the raw input is pulled toward the previous point. */
  streamline: number
  /** 0..1 — smoothing applied to the radius signal along the stroke. */
  smoothing: number
  /** Taper length in document units at the start. `true` maps to the full length. */
  taperStart: number | boolean
  taperEnd: number | boolean
  /** Rounded vs. flat caps. */
  capStart: boolean
  capEnd: boolean
  /** Edge irregularity 0..1 — the "organic" / splat-like contour. */
  irregularity: number
  /** Spatial frequency of the irregularity, in document units per cycle. */
  irregularityScale: number
  /** 0..1 — how strongly stylus tilt squashes the nib into an ellipse. */
  tiltInfluence: number
  /** Where the pressure signal comes from. */
  pressureSource: PressureSource
  /** Response curve applied to the pressure signal. 1 is linear. */
  pressureCurve: number
  /** Speed (document units per ms) that maps to zero simulated pressure. */
  velocityMax: number
  /** Deterministic seed for every procedural element of this stroke. */
  seed: number
}

export const defaultStrokeOptions = (): StrokeOptions => ({
  size: 16,
  thinning: 0.55,
  streamline: 0.42,
  smoothing: 0.5,
  taperStart: 0,
  taperEnd: 0,
  capStart: true,
  capEnd: true,
  irregularity: 0,
  irregularityScale: 28,
  tiltInfluence: 0,
  pressureSource: 'auto',
  pressureCurve: 1,
  velocityMax: 1.6,
  seed: 1,
})

/** A finished outline: a flat [x, y, x, y, ...] ring in document space. */
export interface Outline {
  points: Float32Array
  /** Number of vertices (points.length / 2). */
  count: number
  bounds: Bounds
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const emptyBounds = (): Bounds => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
})

export const growBounds = (b: Bounds, x: number, y: number, pad = 0): void => {
  if (x - pad < b.minX) b.minX = x - pad
  if (y - pad < b.minY) b.minY = y - pad
  if (x + pad > b.maxX) b.maxX = x + pad
  if (y + pad > b.maxY) b.maxY = y + pad
}

export const boundsWidth = (b: Bounds): number => Math.max(0, b.maxX - b.minX)
export const boundsHeight = (b: Bounds): number => Math.max(0, b.maxY - b.minY)

export const boundsCenter = (b: Bounds, out: Vec2): Vec2 => {
  out.x = (b.minX + b.maxX) * 0.5
  out.y = (b.minY + b.maxY) * 0.5
  return out
}

export const boundsIntersect = (a: Bounds, b: Bounds, pad = 0): boolean =>
  a.minX - pad <= b.maxX &&
  a.maxX + pad >= b.minX &&
  a.minY - pad <= b.maxY &&
  a.maxY + pad >= b.minY
