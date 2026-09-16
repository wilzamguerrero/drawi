import {
  identity,
  multiply,
  reflectionAcross,
  rotationAround,
  type Mat2D,
} from '@/core/mat2d'

/**
 * Symmetry is expressed as a set of affine transforms rather than as a special
 * drawing mode. One stroke is built once, then instanced through every
 * transform — so a 16-fold mandala costs the same geometry work as a single
 * stroke, and every copy is exact rather than approximately mirrored.
 *
 * The axis has a movable origin and a free rotation, so the mirror line can sit
 * anywhere on the canvas at any angle, not just on the centre of the viewport.
 */
export interface SymmetrySettings {
  enabled: boolean
  /** Axis origin in document space. */
  originX: number
  originY: number
  /** Axis rotation in radians. 0 means the primary axis is horizontal. */
  angle: number
  /** Reflect across the primary axis. */
  mirror: boolean
  /** Also reflect across the perpendicular axis — together these give 4-way. */
  mirrorPerpendicular: boolean
  /** Rotational copies around the origin. 1 disables rotation. */
  radial: number
  /** Draw the axis guides on the canvas. */
  showGuides: boolean
}

export const defaultSymmetry = (): SymmetrySettings => ({
  enabled: false,
  originX: 0,
  originY: 0,
  angle: Math.PI / 2,
  mirror: true,
  mirrorPerpendicular: false,
  radial: 1,
  showGuides: true,
})

export const MAX_RADIAL = 48

const IDENTITY_ONLY: readonly Mat2D[] = [identity()]

/**
 * Builds the instance transforms for the current settings.
 *
 * Order matters: mirrors are composed first so each rotational copy carries the
 * mirrored pair with it. That produces a true kaleidoscope instead of a ring of
 * unrelated reflections.
 */
export const buildSymmetryTransforms = (
  s: SymmetrySettings
): readonly Mat2D[] => {
  if (!s.enabled) return IDENTITY_ONLY

  const radial = Math.max(1, Math.min(MAX_RADIAL, Math.round(s.radial)))
  if (!s.mirror && !s.mirrorPerpendicular && radial === 1) return IDENTITY_ONLY

  let base: Mat2D[] = [identity()]

  if (s.mirror) {
    const m = reflectionAcross(s.angle, s.originX, s.originY)
    base = base.concat(base.map((t) => multiply(m, t)))
  }

  if (s.mirrorPerpendicular) {
    const m = reflectionAcross(
      s.angle + Math.PI / 2,
      s.originX,
      s.originY
    )
    base = base.concat(base.map((t) => multiply(m, t)))
  }

  if (radial === 1) return base

  const out: Mat2D[] = []
  const step = (Math.PI * 2) / radial
  for (let k = 0; k < radial; k++) {
    const r = rotationAround(step * k, s.originX, s.originY)
    for (const t of base) out.push(k === 0 ? t : multiply(r, t))
  }
  return out
}

/** How many copies the current settings produce. */
export const symmetryInstanceCount = (s: SymmetrySettings): number => {
  if (!s.enabled) return 1
  const radial = Math.max(1, Math.min(MAX_RADIAL, Math.round(s.radial)))
  let n = 1
  if (s.mirror) n *= 2
  if (s.mirrorPerpendicular) n *= 2
  return n * radial
}

/** Screen-space guide lines for the axis overlay, in document space. */
export const symmetryGuideLines = (
  s: SymmetrySettings,
  extent: number
): Array<[number, number, number, number]> => {
  const lines: Array<[number, number, number, number]> = []
  const push = (angle: number): void => {
    const dx = Math.cos(angle) * extent
    const dy = Math.sin(angle) * extent
    lines.push([
      s.originX - dx,
      s.originY - dy,
      s.originX + dx,
      s.originY + dy,
    ])
  }
  if (s.mirror) push(s.angle)
  if (s.mirrorPerpendicular) push(s.angle + Math.PI / 2)
  const radial = Math.max(1, Math.round(s.radial))
  if (radial > 1) {
    const step = Math.PI / radial
    for (let k = 0; k < radial; k++) push(s.angle + step * k)
  }
  return lines
}
