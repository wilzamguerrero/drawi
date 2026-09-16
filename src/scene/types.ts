import type { Mat2D } from '@/core/mat2d'
import type { Id } from '@/core/id'
import type { Bounds } from '@/stroke/types'

/** How an object was created. This never changes; behaviour does. */
export type ObjectKind = 'stroke' | 'fill' | 'splat' | 'blob'

/** What the object currently *is*, physically. Freely switchable at any time. */
export type Behavior = 'static' | 'rigid' | 'rope' | 'soft'

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'add'

/**
 * Geometry is stored twice on purpose.
 *
 * `outline` is the renderable contour — what you see, and what SVG export
 * writes. `spine` is the generative skeleton: centre points with a radius and
 * the pressure that produced them. Physics builds its particles from the spine,
 * and the metaball field builds its capsules from the spine too.
 *
 * Keeping both means switching an object to rope or liquid and back is lossless:
 * the drawing is never consumed by the simulation.
 */
export interface Geometry {
  /** Closed ring, flat [x, y, ...], in the object's local space. */
  outline: Float32Array
  outlineCount: number
  /** Skeleton, flat [x, y, radius, pressure, ...] — stride 4. */
  spine: Float32Array
  spineCount: number
  /** True when the spine forms a loop (a filled mass rather than a line). */
  closed: boolean
  /** Local-space bounds of the outline. */
  bounds: Bounds
}

export const SPINE_STRIDE = 4

export interface Transform25D {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  /**
   * Depth in the 2.5D stack. Drives draw order, parallax under camera tilt and
   * a subtle scale, without committing the document to a real 3D pipeline.
   */
  z: number
}

export const defaultTransform = (): Transform25D => ({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  z: 0,
})

export interface Style {
  color: string
  opacity: number
  blend: BlendMode
  /** Optional contour on top of the fill, in document units. 0 disables it. */
  outlineWidth: number
  outlineColor: string
}

export const defaultStyle = (color = '#f2f2f2'): Style => ({
  color,
  opacity: 1,
  blend: 'normal',
  outlineWidth: 0,
  outlineColor: '#000000',
})

/**
 * Physical properties. These exist on every object even when behaviour is
 * `static`, so turning physics on is a switch rather than a conversion.
 */
export interface PhysicsProps {
  behavior: Behavior
  /** Per-unit-area mass. Pressure can drive this. */
  mass: number
  friction: number
  restitution: number
  /** Structural constraint stiffness, 0..1 per solver iteration. */
  stiffness: number
  /** Velocity retention per second, 0..1. */
  damping: number
  /** Outward pressure that keeps a soft body from collapsing. */
  internalPressure: number
  gravityScale: number
  /** Indices into the particle list that are nailed in place. */
  pinned: number[]
}

export const defaultPhysics = (): PhysicsProps => ({
  behavior: 'static',
  mass: 1,
  friction: 0.06,
  restitution: 0.3,
  stiffness: 0.85,
  damping: 0.02,
  internalPressure: 1,
  gravityScale: 1,
  pinned: [],
})

/**
 * Metaball / implicit field participation.
 *
 * `polarity` is what makes shapes add *or* subtract by proximity: a negative
 * source carves into its neighbours through the same smooth blend that a
 * positive one fuses with them.
 */
export interface FieldProps {
  enabled: boolean
  /** Multiplies the spine radius when the object contributes to the field. */
  radiusScale: number
  /** Field strength. Higher values reach further before falling off. */
  strength: number
  /** +1 unions into the field, -1 carves out of it. */
  polarity: 1 | -1
  /** Blend radius in document units. Larger values fuse from further away. */
  smoothness: number
}

export const defaultField = (): FieldProps => ({
  enabled: false,
  radiusScale: 1,
  strength: 1,
  polarity: 1,
  smoothness: 18,
})

export interface SceneObject {
  id: Id
  kind: ObjectKind
  name: string
  layerId: Id
  geometry: Geometry
  transform: Transform25D
  style: Style
  physics: PhysicsProps
  field: FieldProps
  /** Deterministic seed for every procedural element of this object. */
  seed: number
  visible: boolean
  locked: boolean
  /** Bumped whenever geometry or transform changes, so caches can compare. */
  revision: number
  /** World-space bounds cache, invalidated with `revision`. */
  worldBounds: Bounds
  worldBoundsRevision: number
  /** Cached local-to-world matrix, invalidated with `revision`. */
  matrix: Mat2D
  matrixRevision: number
}

export interface Layer {
  id: Id
  name: string
  visible: boolean
  locked: boolean
  opacity: number
}
