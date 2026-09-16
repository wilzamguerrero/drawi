import { clamp } from '@/core/math'
import { identity, multiply, type Mat2D } from '@/core/mat2d'
import { emptyBounds, growBounds, type Bounds } from '@/stroke/types'

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 64

/**
 * The 2.5D camera.
 *
 * The document is flat in x/y, but every object carries a `z`. Tilting the
 * camera shears the stack: objects at different depths slide past each other
 * and scale very slightly. That reads as depth without any of the cost or
 * complexity of a real 3D pipeline, and every projection stays affine — so a
 * whole depth slice can still be drawn with one `setTransform` call.
 */
export class Camera {
  /** Camera target in document space. */
  x = 0
  y = 0
  zoom = 1
  /** Parallax per unit of depth, in document units. */
  tiltX = 0
  tiltY = 0
  /** Scale gained per unit of depth. Keeps the shear from looking flat. */
  depthGain = 0.0012

  /** Viewport size in CSS pixels. */
  width = 1
  height = 1
  dpr = 1

  /** Bumped whenever anything that affects projection changes. */
  revision = 1

  private readonly scratch: Mat2D = identity()

  resize(width: number, height: number, dpr: number): void {
    if (this.width === width && this.height === height && this.dpr === dpr) {
      return
    }
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.dpr = dpr
    this.revision += 1
  }

  setPan(x: number, y: number): void {
    if (this.x === x && this.y === y) return
    this.x = x
    this.y = y
    this.revision += 1
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.setPan(this.x - dxScreen / this.zoom, this.y - dyScreen / this.zoom)
  }

  setTilt(tiltX: number, tiltY: number): void {
    if (this.tiltX === tiltX && this.tiltY === tiltY) return
    this.tiltX = tiltX
    this.tiltY = tiltY
    this.revision += 1
  }

  /** Zooms about a screen-space anchor so the point under the cursor stays put. */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const next = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM)
    if (next === this.zoom) return
    const before = this.toWorld(screenX, screenY, 0)
    this.zoom = next
    const after = this.toWorld(screenX, screenY, 0)
    this.x += before.x - after.x
    this.y += before.y - after.y
    this.revision += 1
  }

  setZoom(zoom: number): void {
    const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
    if (next === this.zoom) return
    this.zoom = next
    this.revision += 1
  }

  private depthScale(z: number): number {
    return Math.max(0.05, 1 + z * this.depthGain)
  }

  /**
   * Document-to-screen matrix for a given depth, in CSS pixels.
   * `out` is reused, so callers must not hold onto it across frames.
   */
  matrixFor(z: number, out: Mat2D = this.scratch): Mat2D {
    const s = this.zoom * this.depthScale(z)
    const cx = this.width * 0.5
    const cy = this.height * 0.5
    const px = z * this.tiltX
    const py = z * this.tiltY
    out.a = s
    out.b = 0
    out.c = 0
    out.d = s
    out.e = cx - (this.x - px) * s
    out.f = cy - (this.y - py) * s
    return out
  }

  /** Combines the camera with an object's local matrix. */
  combine(z: number, local: Mat2D, out: Mat2D): Mat2D {
    return multiply(this.matrixFor(z, out === local ? identity() : out), local, out)
  }

  toScreen(
    wx: number,
    wy: number,
    z = 0,
    out = { x: 0, y: 0 }
  ): { x: number; y: number } {
    const s = this.zoom * this.depthScale(z)
    out.x = this.width * 0.5 + (wx + z * this.tiltX - this.x) * s
    out.y = this.height * 0.5 + (wy + z * this.tiltY - this.y) * s
    return out
  }

  toWorld(
    sx: number,
    sy: number,
    z = 0,
    out = { x: 0, y: 0 }
  ): { x: number; y: number } {
    const s = this.zoom * this.depthScale(z)
    out.x = (sx - this.width * 0.5) / s + this.x - z * this.tiltX
    out.y = (sy - this.height * 0.5) / s + this.y - z * this.tiltY
    return out
  }

  /**
   * Document-space bounds of the viewport at depth 0, padded so strokes that
   * straddle the edge are still considered visible.
   */
  visibleBounds(pad = 0, out: Bounds = emptyBounds()): Bounds {
    out.minX = Infinity
    out.minY = Infinity
    out.maxX = -Infinity
    out.maxY = -Infinity
    const a = this.toWorld(0, 0)
    growBounds(out, a.x, a.y, pad)
    const b = this.toWorld(this.width, this.height)
    growBounds(out, b.x, b.y, pad)
    return out
  }

  /** How many document units one CSS pixel covers. Drives adaptive detail. */
  get unitsPerPixel(): number {
    return 1 / this.zoom
  }

  signature(): string {
    return `${this.x.toFixed(3)}:${this.y.toFixed(3)}:${this.zoom.toFixed(5)}:${this.tiltX}:${this.tiltY}:${this.width}:${this.height}:${this.dpr}`
  }
}
