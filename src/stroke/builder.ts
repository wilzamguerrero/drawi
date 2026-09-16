import { clamp01, damp, TAU } from '@/core/math'
import { fbm1 } from '@/core/random'
import { PressureModel, tiltToNib } from './pressure'
import {
  emptyBounds,
  growBounds,
  type Bounds,
  type Outline,
  type RawSample,
  type SpinePoint,
  type StrokeOptions,
} from './types'

/** Turn angle beyond which the outer side of a corner gets an arc fan. */
const CORNER_THRESHOLD = 0.32
/** Radians per fan segment. */
const CORNER_STEP = 0.4
const START_CAP_SEGMENTS = 14
const END_CAP_SEGMENTS = 14
const DOT_SEGMENTS = 24

/**
 * Streaming stroke geometry.
 *
 * `perfect-freehand` is a pure function: it takes the whole point list and
 * returns the whole outline, so a live stroke recomputes every vertex on every
 * frame — quadratic work over the length of the stroke, which is why long
 * strokes get sticky in naive implementations.
 *
 * This builder keeps the same geometric ideas but makes them incremental. Each
 * sample appends to the two side buffers, and nothing before the taper tail is
 * ever touched again, so cost per sample stays constant no matter how long the
 * stroke gets. Only the tail — the region the end taper can still reach — is
 * rebuilt, and that region is bounded in document units.
 */
export class StrokeBuilder {
  readonly options: StrokeOptions

  private readonly pressure: PressureModel
  private readonly spine: SpinePoint[] = []

  /** Flat [x, y, ...] buffers for the two sides of the ribbon. */
  private readonly left: number[] = []
  private readonly right: number[] = []
  /** Buffer lengths recorded before each spine point was emitted. */
  private readonly leftMark: number[] = []
  private readonly rightMark: number[] = []

  /** Smoothed position carried by the streamline filter. */
  private sx = 0
  private sy = 0
  private lastTime = 0
  private totalLength = 0
  private smoothedRadius = 0
  private nibAzimuth = 0
  private nibSquash = 0

  /** First spine index that still needs rebuilding (the taper tail). */
  private dirtyFrom = 0
  private finished = false

  private outlineBuffer = new Float32Array(1024)
  private outlineCount = 0
  private readonly bounds: Bounds = emptyBounds()

  constructor(options: StrokeOptions) {
    this.options = options
    this.pressure = new PressureModel(
      options.pressureSource,
      options.pressureCurve,
      options.velocityMax
    )
  }

  get isEmpty(): boolean {
    return this.spine.length === 0
  }

  get pointCount(): number {
    return this.spine.length
  }

  get length(): number {
    return this.totalLength
  }

  get usingRealPressure(): boolean {
    return this.pressure.usingRealPressure
  }

  /** The resolved spine — what the physics and field layers consume. */
  getSpine(): readonly SpinePoint[] {
    return this.spine
  }

  /**
   * Feeds a device sample. Returns true when it produced a new spine point.
   * Samples closer than a fraction of the nib are dropped: they carry no shape
   * information and only add jitter.
   */
  push(sample: RawSample): boolean {
    const o = this.options

    if (this.spine.length === 0) {
      this.sx = sample.x
      this.sy = sample.y
      this.lastTime = sample.time
      const p = this.pressure.push(sample, 0, 0)
      this.applyNib(sample)
      this.emit(sample.x, sample.y, 0, 0, p, 0, 0, sample.time)
      return true
    }

    // Streamline: pull the raw point toward the running smoothed position.
    const alpha = 1 - clamp01(o.streamline) * 0.86
    const nx = this.sx + (sample.x - this.sx) * alpha
    const ny = this.sy + (sample.y - this.sy) * alpha

    const prev = this.spine[this.spine.length - 1]
    const dx = nx - prev.x
    const dy = ny - prev.y
    const distance = Math.hypot(dx, dy)

    // Minimum travel before a point earns its place in the spine.
    const minStep = Math.max(0.45, o.size * 0.055)
    if (distance < minStep && !this.finished) {
      // Still advance the smoothed position so the filter keeps converging.
      this.sx = nx
      this.sy = ny
      return false
    }

    this.sx = nx
    this.sy = ny
    const dt = Math.max(1, sample.time - this.lastTime)
    this.lastTime = sample.time

    const p = this.pressure.push(sample, distance, dt)
    this.applyNib(sample)

    this.totalLength += distance
    const inv = distance > 1e-6 ? 1 / distance : 0
    this.emit(
      nx,
      ny,
      dx * inv,
      dy * inv,
      p,
      this.pressure.currentSpeed,
      this.totalLength,
      sample.time
    )
    return true
  }

  /** Closes the stroke. After this the tail taper is final. */
  finish(): void {
    this.finished = true
    this.markTailDirty()
  }

  private applyNib(sample: RawSample): void {
    if (this.options.tiltInfluence <= 0) return
    const nib = tiltToNib(sample)
    this.nibAzimuth = nib.azimuth
    this.nibSquash = nib.squash * clamp01(this.options.tiltInfluence)
  }

  private emit(
    x: number,
    y: number,
    dx: number,
    dy: number,
    pressure: number,
    speed: number,
    length: number,
    time: number
  ): void {
    // Inherit direction on a stationary sample so caps keep a valid axis.
    if (this.spine.length > 0 && dx === 0 && dy === 0) {
      const prev = this.spine[this.spine.length - 1]
      dx = prev.dx
      dy = prev.dy
    }
    this.spine.push({ x, y, dx, dy, radius: 0, pressure, speed, length, time })
    this.markTailDirty()
  }

  /**
   * Walks back from the end far enough that every point the end taper can
   * still influence will be re-emitted, and marks that range dirty.
   */
  private markTailDirty(): void {
    const tail = this.taperEndDistance()
    if (tail <= 0) {
      this.dirtyFrom = Math.min(
        this.dirtyFrom,
        Math.max(0, this.spine.length - 2)
      )
      return
    }
    const cutoff = this.totalLength - tail
    let i = this.spine.length - 1
    while (i > 0 && this.spine[i].length > cutoff) i--
    this.dirtyFrom = Math.min(this.dirtyFrom, Math.max(0, i - 1))
  }

  private taperStartDistance(): number {
    const t = this.options.taperStart
    if (t === false || t === 0) return 0
    if (t === true) return Math.max(this.options.size, this.totalLength)
    return t as number
  }

  private taperEndDistance(): number {
    const t = this.options.taperEnd
    if (t === false || t === 0) return 0
    if (t === true) return Math.max(this.options.size, this.totalLength)
    return t as number
  }

  /**
   * Radius at a spine point, before per-side irregularity.
   * Pressure thins it; the taper envelope shapes the two ends.
   */
  private radiusAt(point: SpinePoint, index: number): number {
    const o = this.options
    const base = o.size * 0.5
    let r = base * (1 - o.thinning * (1 - point.pressure))

    const ts = this.taperStartDistance()
    if (ts > 0) r *= Math.sin(clamp01(point.length / ts) * (Math.PI / 2))

    const te = this.taperEndDistance()
    if (te > 0 && this.finished) {
      const fromEnd = this.totalLength - point.length
      r *= Math.sin(clamp01(fromEnd / te) * (Math.PI / 2))
    }

    // Radius smoothing along arc length, seeded from the previous point.
    if (index === 0) this.smoothedRadius = r
    else if (o.smoothing > 0) {
      const halfLife = 1 + o.smoothing * 22
      this.smoothedRadius = damp(this.smoothedRadius, r, halfLife, 8)
      r = this.smoothedRadius
    } else this.smoothedRadius = r

    return Math.max(0.05, r)
  }

  /**
   * Per-side radius modulation. Driving each side with its own noise band is
   * what makes an edge read as organic rather than as a wobbling ribbon: the
   * two contours stop being mirror images of each other.
   */
  private sideRadius(
    radius: number,
    point: SpinePoint,
    side: number,
    normalX: number,
    normalY: number
  ): number {
    const o = this.options
    let r = radius

    if (o.irregularity > 0) {
      const scale = Math.max(1, o.irregularityScale)
      const n = fbm1(point.length / scale, 3, o.seed + (side > 0 ? 0 : 977))
      r *= 1 + n * o.irregularity * 0.62
    }

    if (this.nibSquash > 0) {
      // Elliptical nib: the contour tightens where the normal aligns with the
      // direction the pen is leaning.
      const align = Math.abs(
        normalX * Math.cos(this.nibAzimuth) + normalY * Math.sin(this.nibAzimuth)
      )
      r *= 1 - this.nibSquash * 0.62 * align
    }

    return Math.max(0.03, r)
  }

  /** Rebuilds the dirty tail of both side buffers. */
  private rebuild(): void {
    const from = Math.max(0, this.dirtyFrom)
    if (from >= this.spine.length) {
      this.dirtyFrom = this.spine.length
      return
    }

    // Truncate both sides back to the state before `from` was emitted.
    if (this.leftMark.length > from) {
      this.left.length = this.leftMark[from]
      this.right.length = this.rightMark[from]
      this.leftMark.length = from
      this.rightMark.length = from
    }

    // Re-seed the radius smoother from the last surviving point.
    if (from > 0) this.smoothedRadius = this.spine[from - 1].radius

    for (let i = from; i < this.spine.length; i++) {
      this.leftMark.push(this.left.length)
      this.rightMark.push(this.right.length)

      const pt = this.spine[i]
      const radius = this.radiusAt(pt, i)
      pt.radius = radius

      // Normal is the direction rotated by -90 degrees in screen space.
      const nx = pt.dy
      const ny = -pt.dx

      if (i > 0) this.emitCorner(i)

      const rl = this.sideRadius(radius, pt, 1, nx, ny)
      const rr = this.sideRadius(radius, pt, -1, -nx, -ny)
      this.left.push(pt.x + nx * rl, pt.y + ny * rl)
      this.right.push(pt.x - nx * rr, pt.y - ny * rr)
    }

    this.dirtyFrom = this.spine.length
  }

  /**
   * On a sharp turn the outer side has to travel around the corner. Without a
   * fan the ribbon pinches and self-intersects; with one it reads as a real
   * brush pivoting on the page.
   */
  private emitCorner(index: number): void {
    const pt = this.spine[index]
    const prev = this.spine[index - 1]
    const turn = Math.atan2(
      prev.dx * pt.dy - prev.dy * pt.dx,
      prev.dx * pt.dx + prev.dy * pt.dy
    )
    const magnitude = Math.abs(turn)
    if (magnitude < CORNER_THRESHOLD || magnitude > Math.PI - 0.05) return

    const segments = Math.min(12, Math.ceil(magnitude / CORNER_STEP))
    const radius = pt.radius
    // A positive turn in screen space puts the outer edge on the left.
    const outerIsLeft = turn > 0
    const target = outerIsLeft ? this.left : this.right
    const sign = outerIsLeft ? 1 : -1

    const prevNx = prev.dy
    const prevNy = -prev.dx
    const startX = prevNx * sign * radius
    const startY = prevNy * sign * radius

    for (let s = 1; s < segments; s++) {
      const a = turn * (s / segments)
      const c = Math.cos(a)
      const sn = Math.sin(a)
      target.push(
        pt.x + startX * c - startY * sn,
        pt.y + startX * sn + startY * c
      )
    }
  }

  /**
   * Assembles the closed ring: left side forward, end cap, right side backward,
   * start cap. The buffer is reused between calls, so a live stroke allocates
   * nothing per frame.
   */
  getOutline(): Outline {
    this.rebuild()

    const n = this.spine.length
    const b = this.bounds
    b.minX = Infinity
    b.minY = Infinity
    b.maxX = -Infinity
    b.maxY = -Infinity

    if (n === 0) {
      this.outlineCount = 0
      return { points: this.outlineBuffer, count: 0, bounds: b }
    }

    if (n === 1 || this.totalLength < this.options.size * 0.1) {
      return this.buildDot()
    }

    const leftCount = this.left.length / 2
    const rightCount = this.right.length / 2
    const capCount =
      (this.options.capEnd ? END_CAP_SEGMENTS : 2) +
      (this.options.capStart ? START_CAP_SEGMENTS : 2)
    this.ensureCapacity((leftCount + rightCount + capCount + 4) * 2)

    const out = this.outlineBuffer
    let w = 0

    const write = (x: number, y: number): void => {
      out[w++] = x
      out[w++] = y
      growBounds(b, x, y)
    }

    for (let i = 0; i < this.left.length; i += 2) {
      write(this.left[i], this.left[i + 1])
    }

    const end = this.spine[n - 1]
    const endLeftX = this.left[this.left.length - 2]
    const endLeftY = this.left[this.left.length - 1]
    if (this.options.capEnd) {
      this.writeCap(write, end.x, end.y, endLeftX, endLeftY, END_CAP_SEGMENTS)
    }

    for (let i = this.right.length - 2; i >= 0; i -= 2) {
      write(this.right[i], this.right[i + 1])
    }

    const start = this.spine[0]
    if (this.options.capStart) {
      this.writeCap(
        write,
        start.x,
        start.y,
        this.right[0],
        this.right[1],
        START_CAP_SEGMENTS
      )
    }

    this.outlineCount = w / 2
    return { points: out, count: this.outlineCount, bounds: b }
  }

  /** Sweeps a point half a turn around a centre, writing the intermediate arc. */
  private writeCap(
    write: (x: number, y: number) => void,
    cx: number,
    cy: number,
    fromX: number,
    fromY: number,
    segments: number
  ): void {
    const rx = fromX - cx
    const ry = fromY - cy
    for (let s = 1; s < segments; s++) {
      const a = Math.PI * (s / segments)
      const c = Math.cos(a)
      const sn = Math.sin(a)
      write(cx + rx * c - ry * sn, cy + rx * sn + ry * c)
    }
  }

  /** A tap, or a stroke too short to have a direction: draw the nib itself. */
  private buildDot(): Outline {
    const pt = this.spine[0]
    const radius = Math.max(0.4, this.radiusAt(pt, 0))
    pt.radius = radius
    this.ensureCapacity(DOT_SEGMENTS * 2)
    const out = this.outlineBuffer
    const b = this.bounds
    let w = 0
    for (let s = 0; s < DOT_SEGMENTS; s++) {
      const a = (s / DOT_SEGMENTS) * TAU
      const nx = Math.cos(a)
      const ny = Math.sin(a)
      const r = this.sideRadius(radius, pt, s < DOT_SEGMENTS / 2 ? 1 : -1, nx, ny)
      const x = pt.x + nx * r
      const y = pt.y + ny * r
      out[w++] = x
      out[w++] = y
      growBounds(b, x, y)
    }
    this.outlineCount = w / 2
    return { points: out, count: this.outlineCount, bounds: b }
  }

  private ensureCapacity(needed: number): void {
    if (this.outlineBuffer.length >= needed) return
    let size = this.outlineBuffer.length || 1024
    while (size < needed) size *= 2
    this.outlineBuffer = new Float32Array(size)
  }
}
