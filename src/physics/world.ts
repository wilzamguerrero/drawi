import { clamp, clamp01 } from '@/core/math'
import type { Id } from '@/core/id'
import { applyX, applyY, identity, meanScale } from '@/core/mat2d'
import { objectMatrix, touchObject } from '@/scene/object'
import type { SceneDocument } from '@/scene/document'
import type { Behavior, SceneObject } from '@/scene/types'
import { SPINE_STRIDE } from '@/scene/types'
import { ribbonFromSpine, ringFromParticles } from '@/stroke/ribbon'
import { emptyBounds, growBounds, type Bounds } from '@/stroke/types'

/** Target spacing between particles, in document units. */
const PARTICLE_SPACING = 14
const MIN_PARTICLES = 6
const MAX_PARTICLES = 96

export interface Grab {
  bodyId: Id
  particle: number
  x: number
  y: number
  /** How hard the grab pulls, 0..1 per iteration. */
  strength: number
}

interface Body {
  objectId: Id
  behavior: Behavior
  start: number
  count: number
  /** True when the particles are the outline itself (a filled mass). */
  fromOutline: boolean
  closed: boolean
  /** Neighbour distance constraints, as index pairs into the global arrays. */
  ca: Int32Array
  cb: Int32Array
  crest: Float32Array
  /** Bending constraints (i, i+2), kept separate so stiffness can differ. */
  ba: Int32Array
  bb: Int32Array
  brest: Float32Array
  /** Rest area for the internal pressure term. */
  restArea: number
  /** Rest shape relative to its centroid, for shape matching. */
  restX: Float32Array
  restY: Float32Array
  /** Cached radii, used for collisions and for rebuilding the ribbon. */
  radius: Float32Array
  /** Reused output buffer for the rebuilt ribbon. */
  outlineOut: Float32Array | null
  revision: number
  /** Centroid the rest shape was captured around. */
  restCentroidX: number
  restCentroidY: number
}

/**
 * Position Based Dynamics solver.
 *
 * Everything is one model with different coefficients rather than four separate
 * engines: particles plus distance constraints plus an optional area term plus
 * optional shape matching. A rope is that model with no area and no shape
 * matching; a jelly is the same model with both turned partway up; a rigid body
 * is shape matching at full strength. That is why an object can switch
 * behaviour mid-simulation without being rebuilt — only the coefficients change.
 *
 * Solving positions directly (rather than integrating forces) is also what
 * makes direct manipulation feel right: dragging a particle is just moving it,
 * and the constraints sort out the rest within the same frame.
 */
export class PhysicsWorld {
  /** Document units per second squared. */
  gravityX = 0
  gravityY = 1400
  windX = 0
  windY = 0
  /** Velocity lost per second to the medium, 0..1. */
  drag = 0.08
  /** Pairwise body attraction. Negative repels. */
  attraction = 0
  attractionRange = 420
  /** Constraint iterations per substep. More is stiffer and slower. */
  iterations = 5
  substeps = 2
  /** Optional container. Bodies bounce off the inside of it. */
  container: Bounds | null = null
  /** Particle-particle collisions between different bodies. */
  collisions = true

  running = false

  private capacity = 0
  private count = 0
  private x = new Float32Array(0)
  private y = new Float32Array(0)
  private px = new Float32Array(0)
  private py = new Float32Array(0)
  private vx = new Float32Array(0)
  private vy = new Float32Array(0)
  private invMass = new Float32Array(0)
  private radius = new Float32Array(0)
  private bodyOf = new Int32Array(0)
  private pinned = new Uint8Array(0)

  private readonly bodies: Body[] = []
  private readonly byObject = new Map<Id, Body>()

  private grabState: Grab | null = null

  /** Collision grid, rebuilt per substep. */
  private cellSize = 24
  private readonly cells = new Map<number, number[]>()

  get bodyCount(): number {
    return this.bodies.length
  }

  get particleCount(): number {
    return this.count
  }

  hasBody(objectId: Id): boolean {
    return this.byObject.has(objectId)
  }

  /**
   * Brings the world in line with the document: adds bodies for objects whose
   * behaviour is simulated, drops the rest. Called whenever behaviour changes.
   */
  sync(doc: SceneDocument): void {
    for (const object of doc.objects.values()) {
      const wants = object.physics.behavior !== 'static'
      const existing = this.byObject.get(object.id)
      if (wants && !existing) this.addBody(object)
      else if (!wants && existing) this.removeBody(object.id)
      else if (wants && existing) {
        existing.behavior = object.physics.behavior
        if (existing.revision !== object.revision) {
          // Geometry changed under the simulation: rebuild from the new shape.
          this.removeBody(object.id)
          this.addBody(object)
        }
      }
    }
    for (const body of [...this.bodies]) {
      if (!doc.objects.has(body.objectId)) this.removeBody(body.objectId)
    }
    this.rebuildIndices()
  }

  /**
   * Bakes the object transform into its geometry and creates particles in world
   * space. Simulating in world space keeps gravity and collisions honest: a
   * rotated object should not fall sideways.
   */
  private addBody(object: SceneObject): void {
    const sampled = sampleParticles(object)
    if (sampled.count < 2) return

    const start = this.count
    this.ensureCapacity(start + sampled.count)

    const props = object.physics
    const massPerParticle = Math.max(0.02, props.mass)

    for (let i = 0; i < sampled.count; i++) {
      const idx = start + i
      this.x[idx] = sampled.xs[i]
      this.y[idx] = sampled.ys[i]
      this.px[idx] = sampled.xs[i]
      this.py[idx] = sampled.ys[i]
      this.vx[idx] = 0
      this.vy[idx] = 0
      this.invMass[idx] = 1 / massPerParticle
      this.radius[idx] = sampled.radii[i]
      this.pinned[idx] = 0
      this.bodyOf[idx] = this.bodies.length
    }
    for (const p of props.pinned) {
      if (p >= 0 && p < sampled.count) {
        this.pinned[start + p] = 1
        this.invMass[start + p] = 0
      }
    }
    this.count = start + sampled.count

    const body = buildBody(
      object,
      start,
      sampled,
      this.x,
      this.y
    )
    this.bodies.push(body)
    this.byObject.set(object.id, body)
  }

  removeBody(objectId: Id): void {
    const body = this.byObject.get(objectId)
    if (!body) return
    const index = this.bodies.indexOf(body)
    if (index < 0) return

    const removed = body.count
    const from = body.start

    // Compact the particle arrays so the hot loops stay contiguous.
    const tail = this.count - (from + removed)
    if (tail > 0) {
      const move = (a: Float32Array): void => {
        a.copyWithin(from, from + removed, this.count)
      }
      move(this.x)
      move(this.y)
      move(this.px)
      move(this.py)
      move(this.vx)
      move(this.vy)
      move(this.invMass)
      move(this.radius)
      this.bodyOf.copyWithin(from, from + removed, this.count)
      this.pinned.copyWithin(from, from + removed, this.count)
    }
    this.count -= removed

    this.bodies.splice(index, 1)
    this.byObject.delete(objectId)

    // Shift every body that lived after the removed one.
    for (const other of this.bodies) {
      if (other.start > from) {
        const delta = removed
        other.start -= delta
        shiftIndices(other.ca, delta, from)
        shiftIndices(other.cb, delta, from)
        shiftIndices(other.ba, delta, from)
        shiftIndices(other.bb, delta, from)
      }
    }
    if (this.grabState?.bodyId === objectId) this.grabState = null
    this.rebuildIndices()
  }

  private rebuildIndices(): void {
    for (let b = 0; b < this.bodies.length; b++) {
      const body = this.bodies[b]
      for (let i = 0; i < body.count; i++) this.bodyOf[body.start + i] = b
    }
  }

  clear(): void {
    this.bodies.length = 0
    this.byObject.clear()
    this.count = 0
    this.grabState = null
  }

  /** Advances the simulation by `dt` seconds. */
  step(dt: number, doc: SceneDocument): void {
    if (this.count === 0 || dt <= 0) return
    const sub = Math.max(1, this.substeps)
    const h = Math.min(dt, 1 / 30) / sub

    for (let s = 0; s < sub; s++) {
      this.integrate(h, doc)
      if (this.collisions) this.buildCollisionGrid()
      for (let it = 0; it < this.iterations; it++) {
        this.solveConstraints(doc)
        if (this.collisions) this.solveCollisions()
        this.solveContainer()
        this.solveGrab()
      }
      this.finalize(h)
    }
  }

  private integrate(h: number, doc: SceneDocument): void {
    if (this.attraction !== 0) this.applyAttraction(doc)

    const dragFactor = Math.pow(1 - clamp01(this.drag), h)
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) {
        this.px[i] = this.x[i]
        this.py[i] = this.y[i]
        continue
      }
      const body = this.bodies[this.bodyOf[i]]
      const object = doc.get(body.objectId)
      const gs = object ? object.physics.gravityScale : 1

      this.vx[i] = (this.vx[i] + (this.gravityX * gs + this.windX) * h) * dragFactor
      this.vy[i] = (this.vy[i] + (this.gravityY * gs + this.windY) * h) * dragFactor

      this.px[i] = this.x[i]
      this.py[i] = this.y[i]
      this.x[i] += this.vx[i] * h
      this.y[i] += this.vy[i] * h
    }
  }

  private finalize(h: number): void {
    const inv = 1 / h
    for (let i = 0; i < this.count; i++) {
      this.vx[i] = (this.x[i] - this.px[i]) * inv
      this.vy[i] = (this.y[i] - this.py[i]) * inv
    }
  }

  private solveConstraints(doc: SceneDocument): void {
    for (const body of this.bodies) {
      const object = doc.get(body.objectId)
      if (!object) continue
      const props = object.physics
      const stiffness = clamp01(props.stiffness)

      this.solveDistance(body.ca, body.cb, body.crest, stiffness)

      if (body.behavior === 'rope') {
        // Bending constraints are what separate a limp cord from a stiff cable.
        this.solveDistance(
          body.ba,
          body.bb,
          body.brest,
          stiffness * 0.55
        )
      }

      if (body.closed && body.behavior === 'soft' && props.internalPressure > 0) {
        this.solvePressure(body, props.internalPressure)
      }

      if (body.behavior === 'rigid') {
        this.solveShapeMatch(body, 1)
      } else if (body.behavior === 'soft') {
        // A little shape memory keeps a jelly from slowly melting.
        this.solveShapeMatch(body, stiffness * 0.28)
      }
    }
  }

  private solveDistance(
    a: Int32Array,
    b: Int32Array,
    rest: Float32Array,
    stiffness: number
  ): void {
    if (stiffness <= 0) return
    for (let c = 0; c < a.length; c++) {
      const i = a[c]
      const j = b[c]
      const wi = this.invMass[i]
      const wj = this.invMass[j]
      const w = wi + wj
      if (w === 0) continue

      const dx = this.x[j] - this.x[i]
      const dy = this.y[j] - this.y[i]
      const d = Math.hypot(dx, dy)
      if (d < 1e-8) continue

      const diff = (d - rest[c]) / d
      const scale = stiffness * diff
      const cx = dx * scale
      const cy = dy * scale
      this.x[i] += cx * (wi / w)
      this.y[i] += cy * (wi / w)
      this.x[j] -= cx * (wj / w)
      this.y[j] -= cy * (wj / w)
    }
  }

  /**
   * Internal pressure. The area error is distributed along outward normals, so
   * a squashed blob pushes back instead of folding in on itself — the thing
   * that makes a soft body feel inflated rather than hollow.
   */
  private solvePressure(body: Body, pressure: number): void {
    const n = body.count
    const start = body.start
    let area = 0
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = this.x[start + i]
      const yi = this.y[start + i]
      const xj = this.x[start + j]
      const yj = this.y[start + j]
      area += xj * yi - xi * yj
    }
    area *= 0.5

    const target = body.restArea
    if (Math.abs(target) < 1e-6) return
    const error = target / (Math.abs(area) < 1e-6 ? 1e-6 : area) - 1
    if (!Number.isFinite(error)) return

    const gain = clamp(error * pressure * 0.22, -0.4, 0.4)
    const sign = target >= 0 ? 1 : -1

    for (let i = 0; i < n; i++) {
      const idx = start + i
      if (this.invMass[idx] === 0) continue
      const prev = start + ((i - 1 + n) % n)
      const next = start + ((i + 1) % n)
      // Outward normal of the edge pair through this vertex.
      const ex = this.x[next] - this.x[prev]
      const ey = this.y[next] - this.y[prev]
      const l = Math.hypot(ex, ey)
      if (l < 1e-8) continue
      const nx = (ey / l) * sign
      const ny = (-ex / l) * sign
      this.x[idx] += nx * gain * l * 0.5
      this.y[idx] += ny * gain * l * 0.5
    }
  }

  /**
   * Shape matching: find the rigid transform that best maps the rest shape onto
   * the current particles, then pull toward it. In 2D the optimal rotation has
   * a closed form, so this costs one pass and no matrix decomposition.
   */
  private solveShapeMatch(body: Body, strength: number): void {
    if (strength <= 0.0001) return
    const n = body.count
    const start = body.start

    let cx = 0
    let cy = 0
    for (let i = 0; i < n; i++) {
      cx += this.x[start + i]
      cy += this.y[start + i]
    }
    cx /= n
    cy /= n

    let sumCross = 0
    let sumDot = 0
    for (let i = 0; i < n; i++) {
      const qx = body.restX[i]
      const qy = body.restY[i]
      const rx = this.x[start + i] - cx
      const ry = this.y[start + i] - cy
      sumCross += qx * ry - qy * rx
      sumDot += qx * rx + qy * ry
    }
    const angle = Math.atan2(sumCross, sumDot)
    const ca = Math.cos(angle)
    const sa = Math.sin(angle)

    for (let i = 0; i < n; i++) {
      const idx = start + i
      if (this.invMass[idx] === 0) continue
      const qx = body.restX[i]
      const qy = body.restY[i]
      const gx = cx + qx * ca - qy * sa
      const gy = cy + qx * sa + qy * ca
      this.x[idx] += (gx - this.x[idx]) * strength
      this.y[idx] += (gy - this.y[idx]) * strength
    }
  }

  private buildCollisionGrid(): void {
    this.cells.clear()
    let maxRadius = 4
    for (let i = 0; i < this.count; i++) {
      if (this.radius[i] > maxRadius) maxRadius = this.radius[i]
    }
    this.cellSize = Math.max(8, maxRadius * 2)
    for (let i = 0; i < this.count; i++) {
      const key = this.cellKey(this.x[i], this.y[i])
      const bucket = this.cells.get(key)
      if (bucket) bucket.push(i)
      else this.cells.set(key, [i])
    }
  }

  private cellKey(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize) + 0x40000
    const cy = Math.floor(y / this.cellSize) + 0x40000
    return (cx << 19) | cy
  }

  /** Particle-particle separation between different bodies only. */
  private solveCollisions(): void {
    for (const bucket of this.cells.values()) {
      for (let a = 0; a < bucket.length; a++) {
        const i = bucket[a]
        const bodyI = this.bodyOf[i]
        // Only the 4 forward neighbours are needed to cover every pair once.
        for (let ox = 0; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            if (ox === 0 && oy < 0) continue
            const neighbours =
              ox === 0 && oy === 0
                ? bucket
                : this.cells.get(
                    this.cellKey(
                      this.x[i] + ox * this.cellSize,
                      this.y[i] + oy * this.cellSize
                    )
                  )
            if (!neighbours) continue
            for (let b = 0; b < neighbours.length; b++) {
              const j = neighbours[b]
              if (j <= i && neighbours === bucket) continue
              if (j === i) continue
              if (this.bodyOf[j] === bodyI) continue
              this.separate(i, j)
            }
          }
        }
      }
    }
  }

  private separate(i: number, j: number): void {
    const wi = this.invMass[i]
    const wj = this.invMass[j]
    const w = wi + wj
    if (w === 0) return
    const dx = this.x[j] - this.x[i]
    const dy = this.y[j] - this.y[i]
    const minDist = (this.radius[i] + this.radius[j]) * 0.85
    const d2 = dx * dx + dy * dy
    if (d2 >= minDist * minDist || d2 < 1e-10) return
    const d = Math.sqrt(d2)
    const push = (minDist - d) / d
    const cx = dx * push
    const cy = dy * push
    this.x[i] -= cx * (wi / w)
    this.y[i] -= cy * (wi / w)
    this.x[j] += cx * (wj / w)
    this.y[j] += cy * (wj / w)
  }

  private solveContainer(): void {
    const c = this.container
    if (!c) return
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue
      const r = this.radius[i]
      if (this.x[i] - r < c.minX) this.x[i] = c.minX + r
      else if (this.x[i] + r > c.maxX) this.x[i] = c.maxX - r
      if (this.y[i] - r < c.minY) this.y[i] = c.minY + r
      else if (this.y[i] + r > c.maxY) this.y[i] = c.maxY - r
    }
  }

  private solveGrab(): void {
    const g = this.grabState
    if (!g) return
    const body = this.byObject.get(g.bodyId)
    if (!body) return
    const idx = body.start + g.particle
    if (idx < 0 || idx >= this.count) return
    this.x[idx] += (g.x - this.x[idx]) * g.strength
    this.y[idx] += (g.y - this.y[idx]) * g.strength
  }

  /** Body-to-body attraction, applied to every particle of the pair. */
  private applyAttraction(doc: SceneDocument): void {
    const n = this.bodies.length
    if (n < 2) return
    const cx = new Float32Array(n)
    const cy = new Float32Array(n)
    for (let b = 0; b < n; b++) {
      const body = this.bodies[b]
      let sx = 0
      let sy = 0
      for (let i = 0; i < body.count; i++) {
        sx += this.x[body.start + i]
        sy += this.y[body.start + i]
      }
      cx[b] = sx / body.count
      cy[b] = sy / body.count
    }

    const range2 = this.attractionRange * this.attractionRange
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const dx = cx[b] - cx[a]
        const dy = cy[b] - cy[a]
        const d2 = dx * dx + dy * dy
        if (d2 > range2 || d2 < 1e-6) continue
        const d = Math.sqrt(d2)
        // Linear falloff to zero at the range edge keeps it controllable.
        const falloff = 1 - d / this.attractionRange
        const force = this.attraction * falloff
        const ux = dx / d
        const uy = dy / d
        this.pushBody(a, ux * force, uy * force, doc)
        this.pushBody(b, -ux * force, -uy * force, doc)
      }
    }
  }

  private pushBody(
    index: number,
    ax: number,
    ay: number,
    doc: SceneDocument
  ): void {
    const body = this.bodies[index]
    const object = doc.get(body.objectId)
    const scale = object ? 1 / Math.max(0.05, object.physics.mass) : 1
    for (let i = 0; i < body.count; i++) {
      const idx = body.start + i
      if (this.invMass[idx] === 0) continue
      this.vx[idx] += ax * scale
      this.vy[idx] += ay * scale
    }
  }

  /** Grabs the nearest particle within `radius` of a world point. */
  grab(wx: number, wy: number, radius: number, strength = 0.85): Grab | null {
    let best = -1
    let bestDist = radius * radius
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - wx
      const dy = this.y[i] - wy
      const d2 = dx * dx + dy * dy
      if (d2 < bestDist) {
        bestDist = d2
        best = i
      }
    }
    if (best < 0) return null
    const body = this.bodies[this.bodyOf[best]]
    this.grabState = {
      bodyId: body.objectId,
      particle: best - body.start,
      x: wx,
      y: wy,
      strength,
    }
    return this.grabState
  }

  moveGrab(wx: number, wy: number): void {
    if (!this.grabState) return
    this.grabState.x = wx
    this.grabState.y = wy
  }

  releaseGrab(): void {
    this.grabState = null
  }

  get grabbing(): boolean {
    return this.grabState !== null
  }

  /** Writes simulated positions back into document geometry. */
  writeBack(doc: SceneDocument): void {
    for (const body of this.bodies) {
      const object = doc.get(body.objectId)
      if (!object) continue

      if (body.fromOutline) {
        const result = ringFromParticles(
          this.x,
          this.y,
          body.start,
          body.count,
          object.geometry.outline.length >= body.count * 2
            ? object.geometry.outline
            : undefined
        )
        object.geometry.outline = result.points
        object.geometry.outlineCount = result.count
        object.geometry.bounds = result.bounds
        // Keep the skeleton in step so the field still tracks the shape.
        this.writeSpineFromParticles(object, body)
      } else {
        this.writeSpineFromParticles(object, body)
        const result = ribbonFromSpine(
          object.geometry.spine,
          object.geometry.spineCount,
          body.outlineOut ?? undefined
        )
        body.outlineOut = result.points
        object.geometry.outline = result.points
        object.geometry.outlineCount = result.count
        object.geometry.bounds = result.bounds
      }

      touchObject(object)
      body.revision = object.revision
      doc.reindex(object.id)
    }
  }

  private writeSpineFromParticles(object: SceneObject, body: Body): void {
    const needed = body.count * SPINE_STRIDE
    let spine = object.geometry.spine
    if (spine.length < needed) {
      spine = new Float32Array(needed)
      object.geometry.spine = spine
    }
    for (let i = 0; i < body.count; i++) {
      const o = i * SPINE_STRIDE
      spine[o] = this.x[body.start + i]
      spine[o + 1] = this.y[body.start + i]
      spine[o + 2] = body.radius[i]
      spine[o + 3] = 1
    }
    object.geometry.spineCount = body.count
  }

  /** Restores every body to the shape it was created with. */
  reset(doc: SceneDocument): void {
    for (const body of this.bodies) {
      for (let i = 0; i < body.count; i++) {
        const idx = body.start + i
        this.x[idx] = body.restX[i] + body.restCentroidX
        this.y[idx] = body.restY[i] + body.restCentroidY
        this.px[idx] = this.x[idx]
        this.py[idx] = this.y[idx]
        this.vx[idx] = 0
        this.vy[idx] = 0
      }
    }
    this.writeBack(doc)
  }

  /** World-space particle positions of one body, for overlay drawing. */
  forEachParticle(
    objectId: Id,
    visit: (index: number, x: number, y: number, r: number) => void
  ): void {
    const body = this.byObject.get(objectId)
    if (!body) return
    for (let i = 0; i < body.count; i++) {
      visit(i, this.x[body.start + i], this.y[body.start + i], body.radius[i])
    }
  }

  private ensureCapacity(needed: number): void {
    if (this.capacity >= needed) return
    let next = Math.max(512, this.capacity || 512)
    while (next < needed) next *= 2

    // The return type is inferred rather than annotated: an explicit
    // `Float32Array` widens the buffer parameter and no longer matches the
    // fields, which are backed by a plain ArrayBuffer.
    const grow = (a: Float32Array) => {
      const b = new Float32Array(next)
      b.set(a.subarray(0, this.count))
      return b
    }
    this.x = grow(this.x)
    this.y = grow(this.y)
    this.px = grow(this.px)
    this.py = grow(this.py)
    this.vx = grow(this.vx)
    this.vy = grow(this.vy)
    this.invMass = grow(this.invMass)
    this.radius = grow(this.radius)

    const bodyOf = new Int32Array(next)
    bodyOf.set(this.bodyOf.subarray(0, this.count))
    this.bodyOf = bodyOf

    const pinned = new Uint8Array(next)
    pinned.set(this.pinned.subarray(0, this.count))
    this.pinned = pinned

    this.capacity = next
  }
}

const shiftIndices = (arr: Int32Array, delta: number, threshold: number): void => {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] >= threshold) arr[i] -= delta
  }
}

interface SampledParticles {
  xs: Float32Array
  ys: Float32Array
  radii: Float32Array
  count: number
  closed: boolean
  fromOutline: boolean
}

/**
 * Chooses what to turn into particles.
 *
 * A filled mass simulates its own contour, so its outline becomes the particle
 * ring and deforming it deforms the drawing directly. An open stroke simulates
 * its skeleton, and the ribbon is rebuilt around it each frame — so a line
 * keeps its pressure profile while it swings.
 */
const sampleParticles = (object: SceneObject): SampledParticles => {
  const g = object.geometry
  const m = objectMatrix(object)
  const scale = meanScale(m)
  const useOutline = g.closed || g.spineCount < 2

  if (useOutline && g.outlineCount >= 3) {
    const target = clamp(
      Math.round(perimeter(g.outline, g.outlineCount, true) * scale / PARTICLE_SPACING),
      MIN_PARTICLES,
      MAX_PARTICLES
    )
    const resampled = resampleRing(g.outline, g.outlineCount, target)
    const xs = new Float32Array(target)
    const ys = new Float32Array(target)
    const radii = new Float32Array(target)
    for (let i = 0; i < target; i++) {
      const lx = resampled[i * 2]
      const ly = resampled[i * 2 + 1]
      xs[i] = applyX(m, lx, ly)
      ys[i] = applyY(m, lx, ly)
      radii[i] = PARTICLE_SPACING * 0.5
    }
    return { xs, ys, radii, count: target, closed: true, fromOutline: true }
  }

  const n = g.spineCount
  const target = clamp(
    Math.round((spineLength(g.spine, n) * scale) / PARTICLE_SPACING) + 1,
    MIN_PARTICLES,
    MAX_PARTICLES
  )
  const xs = new Float32Array(target)
  const ys = new Float32Array(target)
  const radii = new Float32Array(target)
  for (let i = 0; i < target; i++) {
    const t = (i / (target - 1)) * (n - 1)
    const i0 = Math.min(n - 1, Math.floor(t))
    const i1 = Math.min(n - 1, i0 + 1)
    const f = t - i0
    const lx = lerpAt(g.spine, i0, i1, 0, f)
    const ly = lerpAt(g.spine, i0, i1, 1, f)
    xs[i] = applyX(m, lx, ly)
    ys[i] = applyY(m, lx, ly)
    radii[i] = Math.max(1, lerpAt(g.spine, i0, i1, 2, f) * scale)
  }
  return { xs, ys, radii, count: target, closed: false, fromOutline: false }
}

const lerpAt = (
  spine: Float32Array,
  i0: number,
  i1: number,
  component: number,
  f: number
): number => {
  const a = spine[i0 * SPINE_STRIDE + component]
  const b = spine[i1 * SPINE_STRIDE + component]
  return a + (b - a) * f
}

const spineLength = (spine: Float32Array, count: number): number => {
  let total = 0
  for (let i = 1; i < count; i++) {
    total += Math.hypot(
      spine[i * SPINE_STRIDE] - spine[(i - 1) * SPINE_STRIDE],
      spine[i * SPINE_STRIDE + 1] - spine[(i - 1) * SPINE_STRIDE + 1]
    )
  }
  return total
}

const perimeter = (
  pts: Float32Array,
  count: number,
  closed: boolean
): number => {
  let total = 0
  for (let i = 1; i < count; i++) {
    total += Math.hypot(
      pts[i * 2] - pts[(i - 1) * 2],
      pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]
    )
  }
  if (closed && count > 2) {
    total += Math.hypot(
      pts[0] - pts[(count - 1) * 2],
      pts[1] - pts[(count - 1) * 2 + 1]
    )
  }
  return total
}

/** Even arc-length resampling of a closed ring. */
const resampleRing = (
  pts: Float32Array,
  count: number,
  target: number
): Float32Array => {
  const total = perimeter(pts, count, true)
  const step = total / target
  const out = new Float32Array(target * 2)
  let w = 0
  let i = 0
  let acc = 0

  out[w++] = pts[0]
  out[w++] = pts[1]

  while (w < target * 2 && i < count) {
    const j = (i + 1) % count
    const ax = pts[i * 2]
    const ay = pts[i * 2 + 1]
    const bx = pts[j * 2]
    const by = pts[j * 2 + 1]
    const segment = Math.hypot(bx - ax, by - ay)
    if (segment < 1e-9) {
      i++
      continue
    }
    const nextMark = (w / 2) * step
    if (acc + segment >= nextMark) {
      const f = (nextMark - acc) / segment
      out[w++] = ax + (bx - ax) * f
      out[w++] = ay + (by - ay) * f
      continue
    }
    acc += segment
    i++
  }

  // Pad in the unlikely case rounding left the tail short.
  while (w < target * 2) {
    out[w] = out[w - 2]
    out[w + 1] = out[w - 1]
    w += 2
  }
  return out
}

const buildBody = (
  object: SceneObject,
  start: number,
  sampled: SampledParticles,
  xs: Float32Array,
  ys: Float32Array
): Body => {
  const n = sampled.count
  const closed = sampled.closed

  const links = closed ? n : n - 1
  const ca = new Int32Array(links)
  const cb = new Int32Array(links)
  const crest = new Float32Array(links)
  for (let i = 0; i < links; i++) {
    const j = (i + 1) % n
    ca[i] = start + i
    cb[i] = start + j
    crest[i] = Math.hypot(xs[start + j] - xs[start + i], ys[start + j] - ys[start + i])
  }

  const bendCount = closed ? n : Math.max(0, n - 2)
  const ba = new Int32Array(bendCount)
  const bb = new Int32Array(bendCount)
  const brest = new Float32Array(bendCount)
  for (let i = 0; i < bendCount; i++) {
    const j = (i + 2) % n
    ba[i] = start + i
    bb[i] = start + j
    brest[i] = Math.hypot(xs[start + j] - xs[start + i], ys[start + j] - ys[start + i])
  }

  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    cx += xs[start + i]
    cy += ys[start + i]
  }
  cx /= n
  cy /= n

  const restX = new Float32Array(n)
  const restY = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    restX[i] = xs[start + i] - cx
    restY[i] = ys[start + i] - cy
  }

  let restArea = 0
  if (closed) {
    for (let i = 0, j = n - 1; i < n; j = i++) {
      restArea += xs[start + j] * ys[start + i] - xs[start + i] * ys[start + j]
    }
    restArea *= 0.5
  }

  return {
    objectId: object.id,
    behavior: object.physics.behavior,
    start,
    count: n,
    fromOutline: sampled.fromOutline,
    closed,
    ca,
    cb,
    crest,
    ba,
    bb,
    brest,
    restArea,
    restX,
    restY,
    radius: sampled.radii,
    outlineOut: null,
    revision: object.revision,
    restCentroidX: cx,
    restCentroidY: cy,
  }
}

/** World bounds of every simulated particle, for camera framing. */
export const physicsBounds = (world: PhysicsWorld, doc: SceneDocument): Bounds => {
  const out = emptyBounds()
  for (const object of doc.objects.values()) {
    if (!world.hasBody(object.id)) continue
    world.forEachParticle(object.id, (_i, x, y, r) => growBounds(out, x, y, r))
  }
  return out
}

/** Clears any baked transform so simulated geometry stays in world space. */
export const bakeObjectTransform = (object: SceneObject): void => {
  const m = objectMatrix(object)
  const g = object.geometry
  for (let i = 0; i < g.outlineCount; i++) {
    const x = g.outline[i * 2]
    const y = g.outline[i * 2 + 1]
    g.outline[i * 2] = applyX(m, x, y)
    g.outline[i * 2 + 1] = applyY(m, x, y)
  }
  const scale = meanScale(m)
  for (let i = 0; i < g.spineCount; i++) {
    const o = i * SPINE_STRIDE
    const x = g.spine[o]
    const y = g.spine[o + 1]
    g.spine[o] = applyX(m, x, y)
    g.spine[o + 1] = applyY(m, x, y)
    g.spine[o + 2] *= scale
  }
  const b = emptyBounds()
  for (let i = 0; i < g.outlineCount; i++) {
    growBounds(b, g.outline[i * 2], g.outline[i * 2 + 1])
  }
  g.bounds = b
  object.transform.x = 0
  object.transform.y = 0
  object.transform.rotation = 0
  object.transform.scaleX = 1
  object.transform.scaleY = 1
  object.matrix = identity()
  object.matrixRevision = -1
  touchObject(object)
}
