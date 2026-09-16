import { emptyBounds, growBounds, type Bounds } from './types'

/**
 * Rebuilds a stroke outline from a bare skeleton.
 *
 * The full `StrokeBuilder` needs a live input stream — pressure, timing,
 * velocity. Once a stroke is being driven by the solver, all of that is gone
 * and only positions and radii remain, so this is the cheap path used every
 * frame while a rope or a soft body is moving: offset the spine on both sides,
 * cap the ends, done. No smoothing, no taper recomputation, no allocation
 * beyond the output buffer.
 */

const CAP_SEGMENTS = 10

export interface RibbonResult {
  points: Float32Array
  count: number
  bounds: Bounds
}

/**
 * @param spine  flat [x, y, radius, pressure, ...] — stride 4
 * @param count  number of spine points
 * @param out    reusable output buffer; grown if too small
 */
export const ribbonFromSpine = (
  spine: Float32Array,
  count: number,
  out?: Float32Array
): RibbonResult => {
  const bounds = emptyBounds()

  if (count === 0) {
    return { points: out ?? new Float32Array(0), count: 0, bounds }
  }

  const needed = (count * 2 + CAP_SEGMENTS * 2 + 4) * 2
  let buffer = out
  if (!buffer || buffer.length < needed) buffer = new Float32Array(needed)

  if (count === 1) {
    const cx = spine[0]
    const cy = spine[1]
    const r = Math.max(0.2, spine[2])
    let w = 0
    const segments = CAP_SEGMENTS * 2
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2
      const x = cx + Math.cos(a) * r
      const y = cy + Math.sin(a) * r
      buffer[w++] = x
      buffer[w++] = y
      growBounds(bounds, x, y)
    }
    return { points: buffer, count: w / 2, bounds }
  }

  let w = 0
  const write = (x: number, y: number): void => {
    buffer[w++] = x
    buffer[w++] = y
    growBounds(bounds, x, y)
  }

  // Left side, forward.
  for (let i = 0; i < count; i++) {
    const o = i * 4
    const x = spine[o]
    const y = spine[o + 1]
    const r = Math.max(0.1, spine[o + 2])
    const [nx, ny] = normalAt(spine, count, i)
    write(x + nx * r, y + ny * r)
  }

  // End cap.
  {
    const o = (count - 1) * 4
    const cx = spine[o]
    const cy = spine[o + 1]
    const rx = buffer[w - 2] - cx
    const ry = buffer[w - 1] - cy
    for (let s = 1; s < CAP_SEGMENTS; s++) {
      const a = Math.PI * (s / CAP_SEGMENTS)
      const c = Math.cos(a)
      const sn = Math.sin(a)
      write(cx + rx * c - ry * sn, cy + rx * sn + ry * c)
    }
  }

  // Right side, backward.
  for (let i = count - 1; i >= 0; i--) {
    const o = i * 4
    const x = spine[o]
    const y = spine[o + 1]
    const r = Math.max(0.1, spine[o + 2])
    const [nx, ny] = normalAt(spine, count, i)
    write(x - nx * r, y - ny * r)
  }

  // Start cap.
  {
    const cx = spine[0]
    const cy = spine[1]
    const rx = buffer[w - 2] - cx
    const ry = buffer[w - 1] - cy
    for (let s = 1; s < CAP_SEGMENTS; s++) {
      const a = Math.PI * (s / CAP_SEGMENTS)
      const c = Math.cos(a)
      const sn = Math.sin(a)
      write(cx + rx * c - ry * sn, cy + rx * sn + ry * c)
    }
  }

  return { points: buffer, count: w / 2, bounds }
}

const scratchNormal: [number, number] = [0, 0]

/** Averaged normal at a spine point, so joints do not kink. */
const normalAt = (
  spine: Float32Array,
  count: number,
  index: number
): [number, number] => {
  const i0 = Math.max(0, index - 1)
  const i1 = Math.min(count - 1, index + 1)
  const dx = spine[i1 * 4] - spine[i0 * 4]
  const dy = spine[i1 * 4 + 1] - spine[i0 * 4 + 1]
  const l = Math.hypot(dx, dy)
  if (l < 1e-8) {
    scratchNormal[0] = 0
    scratchNormal[1] = -1
    return scratchNormal
  }
  scratchNormal[0] = dy / l
  scratchNormal[1] = -dx / l
  return scratchNormal
}

/**
 * Rebuilds a closed outline directly from a ring of particles.
 * A filled mass simulates its own contour, so the particles *are* the outline —
 * there is nothing to offset.
 */
export const ringFromParticles = (
  xs: Float32Array,
  ys: Float32Array,
  start: number,
  count: number,
  out?: Float32Array
): RibbonResult => {
  const bounds = emptyBounds()
  const needed = count * 2
  let buffer = out
  if (!buffer || buffer.length < needed) buffer = new Float32Array(needed)
  for (let i = 0; i < count; i++) {
    const x = xs[start + i]
    const y = ys[start + i]
    buffer[i * 2] = x
    buffer[i * 2 + 1] = y
    growBounds(bounds, x, y)
  }
  return { points: buffer, count, bounds }
}
