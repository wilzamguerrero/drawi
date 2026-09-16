import type { SceneObject } from '@/scene/types'

/**
 * Path2D cache.
 *
 * Paths are built once in the object's *local* space and reused for every
 * frame, every zoom level and every symmetry instance — the transform goes on
 * the context instead. This is the single biggest rendering win in the app:
 * panning and zooming a document with thousands of strokes rebuilds no
 * geometry at all.
 */

interface Entry {
  revision: number
  smooth: boolean
  path: Path2D
}

const cache = new WeakMap<SceneObject, Entry>()

/**
 * Builds a closed path from a flat [x, y, ...] ring.
 *
 * With `smooth`, segments are emitted as quadratic curves through vertex
 * midpoints. The outline is already dense, so this costs nothing visually at
 * normal zoom, but it keeps contours from going faceted when the user zooms
 * deep into a stroke.
 */
export const buildPath = (
  points: Float32Array,
  count: number,
  smooth = true
): Path2D => {
  const path = new Path2D()
  if (count < 2) return path

  if (!smooth || count < 4) {
    path.moveTo(points[0], points[1])
    for (let i = 1; i < count; i++) {
      path.lineTo(points[i * 2], points[i * 2 + 1])
    }
    path.closePath()
    return path
  }

  const midX = (i: number, j: number): number =>
    (points[i * 2] + points[j * 2]) * 0.5
  const midY = (i: number, j: number): number =>
    (points[i * 2 + 1] + points[j * 2 + 1]) * 0.5

  path.moveTo(midX(count - 1, 0), midY(count - 1, 0))
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count
    path.quadraticCurveTo(
      points[i * 2],
      points[i * 2 + 1],
      midX(i, next),
      midY(i, next)
    )
  }
  path.closePath()
  return path
}

/** Returns the cached local-space path for an object, rebuilding if stale. */
export const objectPath = (o: SceneObject, smooth = true): Path2D => {
  const hit = cache.get(o)
  if (hit && hit.revision === o.revision && hit.smooth === smooth) {
    return hit.path
  }
  const path = buildPath(o.geometry.outline, o.geometry.outlineCount, smooth)
  cache.set(o, { revision: o.revision, smooth, path })
  return path
}
