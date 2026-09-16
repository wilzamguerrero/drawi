import { applyX, applyY, meanScale } from '@/core/mat2d'
import { objectMatrix, objectWorldBounds } from '@/scene/object'
import type { SceneDocument } from '@/scene/document'
import type { SceneObject } from '@/scene/types'
import { SPINE_STRIDE } from '@/scene/types'
import { boundsIntersect, type Bounds } from '@/stroke/types'
import type { SpinePoint } from '@/stroke/types'
import { FieldSourceBuffer, type FieldSource } from './source'

/**
 * Turns scene objects into field sources.
 *
 * The conversion is the same for every kind of drawable, which is the point:
 * a pressure-tapered stroke, a splat and a blob all arrive at the field as
 * swept circles, so any of them can fuse with any other. The spine radius
 * carries the pressure the user applied, so a hard press really does produce a
 * fatter piece of liquid.
 */

const push = (
  buffer: FieldSourceBuffer,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ra: number,
  rb: number,
  strength: number,
  influence: number
): void => {
  buffer.push(ax, ay, bx, by, ra, rb, strength, influence)
}

/** Appends one object's sources, transformed into world space. */
export const appendObjectSources = (
  buffer: FieldSourceBuffer,
  object: SceneObject
): void => {
  const f = object.field
  if (!f.enabled) return

  const m = objectMatrix(object)
  const scale = meanScale(m)
  const strength = f.strength * f.polarity
  const influence = Math.max(1, f.smoothness * scale)

  const spine = object.geometry.spine
  const n = object.geometry.spineCount

  if (n === 0) {
    // No skeleton: fall back to the bounds, so even an imported shape can fuse.
    const b = objectWorldBounds(object)
    const cx = (b.minX + b.maxX) * 0.5
    const cy = (b.minY + b.maxY) * 0.5
    const r = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.5
    push(buffer, cx, cy, cx, cy, r, r, strength, influence)
    return
  }

  if (n === 1) {
    const x = applyX(m, spine[0], spine[1])
    const y = applyY(m, spine[0], spine[1])
    const r = Math.max(0.5, spine[2] * f.radiusScale * scale)
    push(buffer, x, y, x, y, r, r, strength, influence)
    return
  }

  let px = applyX(m, spine[0], spine[1])
  let py = applyY(m, spine[0], spine[1])
  let pr = Math.max(0.5, spine[2] * f.radiusScale * scale)

  for (let i = 1; i < n; i++) {
    const o = i * SPINE_STRIDE
    const x = applyX(m, spine[o], spine[o + 1])
    const y = applyY(m, spine[o], spine[o + 1])
    const r = Math.max(0.5, spine[o + 2] * f.radiusScale * scale)
    push(buffer, px, py, x, y, pr, r, strength, influence)
    px = x
    py = y
    pr = r
  }

  if (object.geometry.closed && n > 2) {
    const x0 = applyX(m, spine[0], spine[1])
    const y0 = applyY(m, spine[0], spine[1])
    const r0 = Math.max(0.5, spine[2] * f.radiusScale * scale)
    push(buffer, px, py, x0, y0, pr, r0, strength, influence)
  }
}

/** Appends sources for a live, uncommitted stroke spine. */
export const appendSpineSources = (
  buffer: FieldSourceBuffer,
  spine: readonly SpinePoint[],
  radiusScale: number,
  strength: number,
  influence: number
): void => {
  if (spine.length === 0) return
  if (spine.length === 1) {
    const p = spine[0]
    const r = Math.max(0.5, p.radius * radiusScale)
    push(buffer, p.x, p.y, p.x, p.y, r, r, strength, influence)
    return
  }
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1]
    const b = spine[i]
    push(
      buffer,
      a.x,
      a.y,
      b.x,
      b.y,
      Math.max(0.5, a.radius * radiusScale),
      Math.max(0.5, b.radius * radiusScale),
      strength,
      influence
    )
  }
}

/**
 * Rebuilds the whole source buffer for a frame.
 * Objects outside the padded viewport are skipped: a source that cannot reach
 * the screen cannot affect it, and the padding accounts for its influence.
 */
export const buildFieldSources = (
  buffer: FieldSourceBuffer,
  doc: SceneDocument,
  view: Bounds,
  pad: number
): FieldSourceBuffer => {
  buffer.reset()
  for (const object of doc.renderList()) {
    if (!object.field.enabled || !object.visible) continue
    const layer = doc.layers.find((l) => l.id === object.layerId)
    if (layer && !layer.visible) continue
    if (!boundsIntersect(objectWorldBounds(object), view, pad)) continue
    appendObjectSources(buffer, object)
  }
  return buffer
}

/** Reads one packed source back out of the buffer. */
export const readSource = (
  buffer: FieldSourceBuffer,
  index: number,
  out: FieldSource
): FieldSource => {
  const o = index * 8
  const d = buffer.data
  out.ax = d[o]
  out.ay = d[o + 1]
  out.bx = d[o + 2]
  out.by = d[o + 3]
  out.ra = d[o + 4]
  out.rb = d[o + 5]
  out.strength = d[o + 6]
  out.influence = d[o + 7]
  return out
}
