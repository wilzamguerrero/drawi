import { clamp, TAU } from '@/core/math'
import { makeRng } from '@/core/random'
import { fbm1 } from '@/core/random'
import {
  defaultContourOptions,
  traceField,
  ringArea,
  type Ring,
} from '@/field/marching'
import { FieldSourceBuffer } from '@/field/source'
import { SPINE_STRIDE } from '@/scene/types'
import { emptyBounds, growBounds, type Bounds } from '@/stroke/types'

/**
 * Procedural mass generators.
 *
 * Neither of these rasterises anything. A splat is a set of droplets, and its
 * visible contour is traced out of the droplets' own implicit field — the same
 * field the GPU renderer uses — so the mark the user sees is exactly what the
 * liquid mode would fuse, and it stays a real editable outline. A blob is a
 * closed vector ring with a noise-modulated radius.
 *
 * Both keep their generating parameters and a seed, so either can be re-rolled,
 * re-scaled or re-traced at any time without losing the original intent.
 */

export interface SplatOptions {
  /** Radius of the main mass, in document units. */
  size: number
  /** Number of satellite droplets. */
  count: number
  /** How far satellites travel, as a multiple of `size`. */
  scatter: number
  /** Stretch along the travel direction, 0..1. */
  elongation: number
  /** Droplet radius variance, 0..1. */
  irregularity: number
  /** Field blend radius. Higher values make droplets merge into one mass. */
  smoothness: number
  seed: number
}

export const defaultSplatOptions = (): SplatOptions => ({
  size: 26,
  count: 9,
  scatter: 1.6,
  elongation: 0.45,
  irregularity: 0.55,
  smoothness: 9,
  seed: 1,
})

export interface Droplet {
  x: number
  y: number
  r: number
}

/**
 * Scatters droplets around a point.
 *
 * `pressure` grows both the mass and the number of satellites; `direction` and
 * `speed` throw them forward, so a fast flick reads as a flick and a slow press
 * reads as a blot. That mapping is the whole reason the tool feels physical.
 */
export const generateDroplets = (
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  speed: number,
  pressure: number,
  options: SplatOptions
): Droplet[] => {
  const rng = makeRng(options.seed)
  const size = options.size * (0.45 + pressure * 0.85)
  const satellites = Math.max(
    0,
    Math.round(options.count * (0.35 + pressure * 0.9))
  )

  const droplets: Droplet[] = [{ x: cx, y: cy, r: size }]

  const dirLength = Math.hypot(dirX, dirY)
  const ux = dirLength > 1e-6 ? dirX / dirLength : 1
  const uy = dirLength > 1e-6 ? dirY / dirLength : 0
  const throwStrength = clamp(speed * 90, 0, 3.2) * options.elongation

  for (let i = 0; i < satellites; i++) {
    const angle = rng() * TAU
    // Square root keeps the scatter area uniform instead of clumping at the centre.
    const spread = Math.sqrt(rng()) * options.scatter * size
    const forward = (0.35 + rng() * 1.5) * throwStrength * size

    const x = cx + Math.cos(angle) * spread + ux * forward
    const y = cy + Math.sin(angle) * spread + uy * forward

    const falloff = 1 - Math.min(1, spread / (options.scatter * size + 1e-6))
    const variance = 1 + (rng() * 2 - 1) * options.irregularity
    const r = Math.max(
      size * 0.08,
      size * (0.16 + falloff * 0.42) * variance
    )
    droplets.push({ x, y, r })
  }
  return droplets
}

export interface SplatResult {
  rings: Ring[]
  droplets: Droplet[]
  /** Skeleton, flat [x, y, radius, pressure, ...] — one entry per droplet. */
  spine: Float32Array
  bounds: Bounds
}

/**
 * Builds a splat and traces its contour out of the droplet field.
 * Returns one ring per separated mass, so an exploded splat becomes several
 * independent objects rather than one shape with impossible topology.
 */
export const buildSplat = (
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  speed: number,
  pressure: number,
  options: SplatOptions
): SplatResult => {
  const droplets = generateDroplets(
    cx,
    cy,
    dirX,
    dirY,
    speed,
    pressure,
    options
  )

  const sources = new FieldSourceBuffer(droplets.length + 4)
  const influence = Math.max(1, options.smoothness)
  const bounds = emptyBounds()
  for (const d of droplets) {
    sources.push(d.x, d.y, d.x, d.y, d.r, d.r, 1, influence)
    growBounds(bounds, d.x, d.y, d.r + influence)
  }

  const contour = defaultContourOptions()
  // Cell size follows droplet scale, so a tiny splat is not undersampled and a
  // huge one does not blow up the grid.
  const smallest = droplets.reduce((m, d) => Math.min(m, d.r), Infinity)
  contour.cell = clamp(smallest * 0.45, 0.6, 12)
  contour.simplify = contour.cell * 0.18
  contour.minArea = contour.cell * contour.cell * 3

  const rings = traceField(sources, bounds, contour)
  rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))

  const spine = new Float32Array(droplets.length * SPINE_STRIDE)
  droplets.forEach((d, i) => {
    const o = i * SPINE_STRIDE
    spine[o] = d.x
    spine[o + 1] = d.y
    spine[o + 2] = d.r
    spine[o + 3] = pressure
  })

  return { rings, droplets, spine, bounds }
}

export interface BlobOptions {
  radius: number
  /** Ring resolution. More points give finer wobble. */
  segments: number
  /** Radial noise amount, 0..1. */
  wobble: number
  /** Noise frequency around the ring. */
  wobbleScale: number
  /** Aspect ratio: 1 is a circle. */
  squash: number
  seed: number
}

export const defaultBlobOptions = (): BlobOptions => ({
  radius: 60,
  segments: 64,
  wobble: 0.22,
  wobbleScale: 2.4,
  squash: 1,
  seed: 1,
})

/**
 * A closed vector ring. It is stored as ordinary outline geometry, so it can be
 * rotated, scaled, turned into a soft body or fused into the field exactly like
 * a hand-drawn mass — a primitive, not a special case.
 */
export const buildBlob = (
  options: BlobOptions
): { ring: Float32Array; spine: Float32Array; bounds: Bounds } => {
  const segments = Math.max(12, Math.min(256, Math.round(options.segments)))
  const ring = new Float32Array(segments * 2)
  const bounds = emptyBounds()

  for (let i = 0; i < segments; i++) {
    const t = i / segments
    const angle = t * TAU
    // Sample the noise on a circle so the ring closes seamlessly.
    const n = fbm1(
      Math.cos(angle) * options.wobbleScale +
        Math.sin(angle) * options.wobbleScale * 0.5 +
        4,
      3,
      options.seed
    )
    const r = options.radius * (1 + n * options.wobble)
    const x = Math.cos(angle) * r
    const y = Math.sin(angle) * r * options.squash
    ring[i * 2] = x
    ring[i * 2 + 1] = y
    growBounds(bounds, x, y)
  }

  // A single central spine point lets the blob act as one field source.
  const spine = new Float32Array(SPINE_STRIDE)
  spine[0] = 0
  spine[1] = 0
  spine[2] = options.radius * 0.92
  spine[3] = 1

  return { ring, spine, bounds }
}
