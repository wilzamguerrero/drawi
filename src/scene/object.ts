import { makeId, type Id } from '@/core/id'
import {
  identity,
  multiply,
  rotation,
  scaling,
  translation,
  type Mat2D,
} from '@/core/mat2d'
import { randomSeed } from '@/core/random'
import type { StrokeBuilder } from '@/stroke/builder'
import { emptyBounds, growBounds, type Bounds } from '@/stroke/types'
import {
  defaultField,
  defaultPhysics,
  defaultStyle,
  defaultTransform,
  SPINE_STRIDE,
  type Geometry,
  type ObjectKind,
  type SceneObject,
  type Style,
} from './types'

/** Snapshots a live stroke builder into immutable document geometry. */
export const geometryFromBuilder = (
  builder: StrokeBuilder,
  closed = false
): Geometry => {
  const outline = builder.getOutline()
  const points = new Float32Array(outline.count * 2)
  points.set(outline.points.subarray(0, outline.count * 2))

  const spinePoints = builder.getSpine()
  const spine = new Float32Array(spinePoints.length * SPINE_STRIDE)
  for (let i = 0; i < spinePoints.length; i++) {
    const p = spinePoints[i]
    const o = i * SPINE_STRIDE
    spine[o] = p.x
    spine[o + 1] = p.y
    spine[o + 2] = p.radius
    spine[o + 3] = p.pressure
  }

  return {
    outline: points,
    outlineCount: outline.count,
    spine,
    spineCount: spinePoints.length,
    closed,
    bounds: { ...outline.bounds },
  }
}

/** Builds geometry from an explicit ring, deriving a one-point spine if needed. */
export const geometryFromRing = (
  ring: Float32Array,
  count: number,
  spine?: Float32Array,
  spineCount = 0,
  closed = true
): Geometry => {
  const bounds = emptyBounds()
  for (let i = 0; i < count; i++) growBounds(bounds, ring[i * 2], ring[i * 2 + 1])
  return {
    outline: ring,
    outlineCount: count,
    spine: spine ?? new Float32Array(0),
    spineCount: spine ? spineCount : 0,
    closed,
    bounds,
  }
}

export const cloneGeometry = (g: Geometry): Geometry => ({
  outline: g.outline.slice(),
  outlineCount: g.outlineCount,
  spine: g.spine.slice(),
  spineCount: g.spineCount,
  closed: g.closed,
  bounds: { ...g.bounds },
})

export interface CreateObjectInput {
  kind: ObjectKind
  layerId: Id
  geometry: Geometry
  style?: Partial<Style>
  z?: number
  seed?: number
  name?: string
}

export const createObject = (input: CreateObjectInput): SceneObject => {
  const transform = defaultTransform()
  transform.z = input.z ?? 0
  return {
    id: makeId(input.kind[0]),
    kind: input.kind,
    name: input.name ?? input.kind,
    layerId: input.layerId,
    geometry: input.geometry,
    transform,
    style: { ...defaultStyle(), ...input.style },
    physics: defaultPhysics(),
    field: defaultField(),
    seed: input.seed ?? randomSeed(),
    visible: true,
    locked: false,
    revision: 1,
    worldBounds: emptyBounds(),
    worldBoundsRevision: 0,
    matrix: identity(),
    matrixRevision: 0,
  }
}

/** Marks an object changed so every downstream cache recomputes. */
export const touchObject = (o: SceneObject): void => {
  o.revision += 1
}

/**
 * Local-to-world matrix, cached against the object's revision.
 * Order is translate · rotate · scale, so rotation pivots on the object origin.
 */
export const objectMatrix = (o: SceneObject): Mat2D => {
  if (o.matrixRevision === o.revision) return o.matrix
  const t = o.transform
  const m = multiply(
    translation(t.x, t.y),
    multiply(rotation(t.rotation), scaling(t.scaleX, t.scaleY))
  )
  o.matrix = m
  o.matrixRevision = o.revision
  return m
}

/** World-space bounds, cached against the object's revision. */
export const objectWorldBounds = (o: SceneObject): Bounds => {
  if (o.worldBoundsRevision === o.revision) return o.worldBounds
  const m = objectMatrix(o)
  const b = o.geometry.bounds
  const out = emptyBounds()
  // Transform the four local corners: cheaper than the full point list and
  // exact for an affine transform.
  const xs = [b.minX, b.maxX, b.maxX, b.minX]
  const ys = [b.minY, b.minY, b.maxY, b.maxY]
  for (let i = 0; i < 4; i++) {
    growBounds(
      out,
      m.a * xs[i] + m.c * ys[i] + m.e,
      m.b * xs[i] + m.d * ys[i] + m.f
    )
  }
  o.worldBounds = out
  o.worldBoundsRevision = o.revision
  return out
}

/** Even-odd point test against the object's outline, in world space. */
export const hitTestObject = (
  o: SceneObject,
  wx: number,
  wy: number,
  tolerance = 0
): boolean => {
  const wb = objectWorldBounds(o)
  if (
    wx < wb.minX - tolerance ||
    wx > wb.maxX + tolerance ||
    wy < wb.minY - tolerance ||
    wy > wb.maxY + tolerance
  ) {
    return false
  }

  // Move the probe into local space instead of transforming every vertex.
  const m = objectMatrix(o)
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return false
  const inv = 1 / det
  const dx = wx - m.e
  const dy = wy - m.f
  const lx = (dx * m.d - dy * m.c) * inv
  const ly = (dy * m.a - dx * m.b) * inv

  const pts = o.geometry.outline
  const n = o.geometry.outlineCount
  if (n < 3) return false
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2]
    const yi = pts[i * 2 + 1]
    const xj = pts[j * 2]
    const yj = pts[j * 2 + 1]
    if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
