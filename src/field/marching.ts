import type { Bounds } from '@/stroke/types'
import { sampleField } from './evaluate'
import type { FieldSourceBuffer } from './source'

/**
 * Marching squares with exact edge identity.
 *
 * Naive implementations emit loose segments and then re-link them by comparing
 * coordinates, which fails on shared vertices and leaves shapes open. Here each
 * crossing is keyed by the grid edge it sits on, so linking is exact and every
 * contour closes — which matters, because these rings become real editable
 * vector objects, not just a preview.
 */

export interface ContourOptions {
  /** Iso value to trace. Must match what the renderer is thresholding at. */
  iso: number
  /** Sample spacing in document units. Smaller is more faithful and slower. */
  cell: number
  /** Douglas-Peucker tolerance in document units. 0 keeps every vertex. */
  simplify: number
  /** Drop rings whose area is below this, in square document units. */
  minArea: number
}

export const defaultContourOptions = (): ContourOptions => ({
  iso: 0.42,
  cell: 4,
  simplify: 0.6,
  minArea: 12,
})

/** A traced ring: flat [x, y, ...] in document space, closed implicitly. */
export type Ring = Float32Array

/** Horizontal edges get even ids, vertical edges odd, so keys never collide. */
const hEdge = (x: number, y: number, w: number): number => 2 * (y * w + x)
const vEdge = (x: number, y: number, w: number): number => 2 * (y * w + x) + 1

export const traceField = (
  sources: FieldSourceBuffer,
  bounds: Bounds,
  options: ContourOptions
): Ring[] => {
  const cell = Math.max(0.5, options.cell)
  const pad = cell * 2
  const minX = bounds.minX - pad
  const minY = bounds.minY - pad
  const cols = Math.max(2, Math.ceil((bounds.maxX - bounds.minX + pad * 2) / cell) + 1)
  const rows = Math.max(2, Math.ceil((bounds.maxY - bounds.minY + pad * 2) / cell) + 1)

  // Guard against a huge sample grid on an extreme zoom-out.
  if (cols * rows > 4_000_000) return []

  const values = new Float32Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    const wy = minY + y * cell
    for (let x = 0; x < cols; x++) {
      values[y * cols + x] = sampleField(sources, minX + x * cell, wy)
    }
  }

  const iso = options.iso
  /** Interpolated crossing position per edge id. */
  const points = new Map<number, [number, number]>()
  /** Directed adjacency: from edge id to edge id. */
  const next = new Map<number, number>()

  const interpolate = (v0: number, v1: number): number => {
    const d = v1 - v0
    return Math.abs(d) < 1e-9 ? 0.5 : (iso - v0) / d
  }

  const edgePoint = (
    id: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    v0: number,
    v1: number
  ): number => {
    if (!points.has(id)) {
      const t = interpolate(v0, v1)
      points.set(id, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
    }
    return id
  }

  const link = (from: number, to: number): void => {
    if (from !== to) next.set(from, to)
  }

  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const i00 = y * cols + x
      const v00 = values[i00]
      const v10 = values[i00 + 1]
      const v01 = values[i00 + cols]
      const v11 = values[i00 + cols + 1]

      let code = 0
      if (v00 > iso) code |= 1
      if (v10 > iso) code |= 2
      if (v11 > iso) code |= 4
      if (v01 > iso) code |= 8
      if (code === 0 || code === 15) continue

      const wx = minX + x * cell
      const wy = minY + y * cell

      // Edge ids, named by the cell side they sit on.
      const top = () => edgePoint(hEdge(x, y, cols), wx, wy, wx + cell, wy, v00, v10)
      const bottom = () =>
        edgePoint(
          hEdge(x, y + 1, cols),
          wx,
          wy + cell,
          wx + cell,
          wy + cell,
          v01,
          v11
        )
      const left = () =>
        edgePoint(vEdge(x, y, cols), wx, wy, wx, wy + cell, v00, v01)
      const right = () =>
        edgePoint(
          vEdge(x + 1, y, cols),
          wx + cell,
          wy,
          wx + cell,
          wy + cell,
          v10,
          v11
        )

      // Directed so the interior stays on a consistent side and rings all wind
      // the same way, which keeps even-odd fills and area signs predictable.
      switch (code) {
        case 1:
          link(left(), top())
          break
        case 2:
          link(top(), right())
          break
        case 3:
          link(left(), right())
          break
        case 4:
          link(right(), bottom())
          break
        case 5:
          // Ambiguous saddle: resolve with the cell centre value.
          if ((v00 + v10 + v01 + v11) * 0.25 > iso) {
            link(left(), top())
            link(right(), bottom())
          } else {
            link(left(), bottom())
            link(right(), top())
          }
          break
        case 6:
          link(top(), bottom())
          break
        case 7:
          link(left(), bottom())
          break
        case 8:
          link(bottom(), left())
          break
        case 9:
          link(bottom(), top())
          break
        case 10:
          if ((v00 + v10 + v01 + v11) * 0.25 > iso) {
            link(top(), right())
            link(bottom(), left())
          } else {
            link(top(), left())
            link(bottom(), right())
          }
          break
        case 11:
          link(bottom(), right())
          break
        case 12:
          link(right(), left())
          break
        case 13:
          link(right(), top())
          break
        case 14:
          link(top(), left())
          break
        default:
          break
      }
    }
  }

  // Walk the adjacency into closed loops.
  const rings: Ring[] = []
  const visited = new Set<number>()
  for (const start of next.keys()) {
    if (visited.has(start)) continue
    const loop: number[] = []
    let current = start
    while (true) {
      if (visited.has(current)) break
      visited.add(current)
      const p = points.get(current)
      if (!p) break
      loop.push(p[0], p[1])
      const following = next.get(current)
      if (following === undefined) break
      current = following
      if (current === start) break
    }
    if (loop.length < 8) continue

    const simplified =
      options.simplify > 0 ? simplifyRing(loop, options.simplify) : loop
    if (simplified.length < 8) continue
    if (Math.abs(ringArea(simplified)) < options.minArea) continue
    rings.push(new Float32Array(simplified))
  }

  return rings
}

export const ringArea = (pts: ArrayLike<number>): number => {
  const n = pts.length / 2
  if (n < 3) return 0
  let area = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1]
  }
  return area * 0.5
}

/**
 * Douglas-Peucker on a closed ring.
 * Marching squares emits a vertex per grid edge, most of which sit on a
 * straight run; dropping them makes the exported SVG readable and the physics
 * conversion cheap without changing the silhouette.
 */
export const simplifyRing = (pts: number[], tolerance: number): number[] => {
  const n = pts.length / 2
  if (n < 4) return pts

  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1

  const tol2 = tolerance * tolerance
  const stack: Array<[number, number]> = [[0, n - 1]]

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    if (last <= first + 1) continue

    const ax = pts[first * 2]
    const ay = pts[first * 2 + 1]
    const bx = pts[last * 2]
    const by = pts[last * 2 + 1]
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy

    let worst = -1
    let worstIndex = first

    for (let i = first + 1; i < last; i++) {
      const px = pts[i * 2]
      const py = pts[i * 2 + 1]
      let d2: number
      if (lengthSq < 1e-12) {
        const ex = px - ax
        const ey = py - ay
        d2 = ex * ex + ey * ey
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = px - (ax + dx * t)
        const ey = py - (ay + dy * t)
        d2 = ex * ex + ey * ey
      }
      if (d2 > worst) {
        worst = d2
        worstIndex = i
      }
    }

    if (worst > tol2) {
      keep[worstIndex] = 1
      stack.push([first, worstIndex], [worstIndex, last])
    }
  }

  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1])
  }
  return out
}
