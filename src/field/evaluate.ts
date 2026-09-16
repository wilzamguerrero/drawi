import { distToSegment, type Vec2 } from '@/core/vec2'
import type { FieldSourceBuffer } from './source'
import { SOURCE_STRIDE } from './source'

/**
 * CPU evaluation of the same implicit field the shader renders.
 *
 * It has to match the GPU falloff exactly, because this is what turns a liquid
 * back into an editable vector shape: if the two disagree, the vectorised
 * outline drifts away from what the user was looking at.
 */

const cro = (ax: number, ay: number, bx: number, by: number): number =>
  ax * by - ay * bx

/** Signed distance to a circle swept between two radii (iq's uneven capsule). */
export const sdUnevenCapsule = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ra: number,
  rb: number
): number => {
  let x = px - ax
  let y = py - ay
  const pbx = bx - ax
  const pby = by - ay
  const h = pbx * pbx + pby * pby
  if (h < 1e-8) return Math.hypot(x, y) - ra

  let qx = (x * pby - y * pbx) / h
  const qy = (x * pbx + y * pby) / h
  qx = Math.abs(qx)

  const bdiff = ra - rb
  const cx = Math.sqrt(Math.max(h - bdiff * bdiff, 0))
  const cy = bdiff
  const k = cro(cx, cy, qx, qy)
  const m = cx * qx + cy * qy
  const n = qx * qx + qy * qy

  if (k < 0) return Math.sqrt(h * n) - ra
  if (k > cx) return Math.sqrt(h * (n + 1 - 2 * qy)) - rb
  return m - ra
}

/** Field value at a point. Mirrors the accumulate shader. */
export const sampleField = (
  sources: FieldSourceBuffer,
  px: number,
  py: number
): number => {
  const d = sources.data
  let sum = 0
  for (let i = 0; i < sources.count; i++) {
    const o = i * SOURCE_STRIDE
    const ax = d[o]
    const ay = d[o + 1]
    const bx = d[o + 2]
    const by = d[o + 3]
    const ra = d[o + 4]
    const rb = d[o + 5]
    const strength = d[o + 6]
    const influence = d[o + 7]

    // Cheap rejection before the exact distance: most sources miss most pixels.
    const reach = Math.max(ra, rb) + influence
    const minX = Math.min(ax, bx) - reach
    if (px < minX) continue
    const maxX = Math.max(ax, bx) + reach
    if (px > maxX) continue
    const minY = Math.min(ay, by) - reach
    if (py < minY) continue
    const maxY = Math.max(ay, by) + reach
    if (py > maxY) continue

    const dist = sdUnevenCapsule(px, py, ax, ay, bx, by, ra, rb)
    if (dist >= influence) continue
    const t = dist <= 0 ? 0 : dist / influence
    const w = 1 - t * t
    sum += w * w * w * strength
  }
  return sum
}

/**
 * Field gradient by central differences. Used for the proximity forces: a body
 * inside a neighbour's influence gets pushed along the gradient, which is what
 * makes shapes reach for each other before they visually fuse.
 */
export const sampleFieldGradient = (
  sources: FieldSourceBuffer,
  px: number,
  py: number,
  h: number,
  out: Vec2
): Vec2 => {
  const dx = sampleField(sources, px + h, py) - sampleField(sources, px - h, py)
  const dy = sampleField(sources, px, py + h) - sampleField(sources, px, py - h)
  out.x = dx / (2 * h)
  out.y = dy / (2 * h)
  return out
}

/** Distance from a point to a source's axis, ignoring radius. */
export const distanceToSourceAxis = (
  sources: FieldSourceBuffer,
  index: number,
  p: Vec2,
  a: Vec2,
  b: Vec2
): number => {
  const o = index * SOURCE_STRIDE
  a.x = sources.data[o]
  a.y = sources.data[o + 1]
  b.x = sources.data[o + 2]
  b.y = sources.data[o + 3]
  return distToSegment(p, a, b)
}
