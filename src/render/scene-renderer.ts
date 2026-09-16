import { identity, multiply, type Mat2D } from '@/core/mat2d'
import { objectMatrix } from '@/scene/object'
import type { SceneDocument } from '@/scene/document'
import type { BlendMode, SceneObject, Style } from '@/scene/types'
import type { Outline } from '@/stroke/types'
import type { Camera } from './camera'
import { buildPath, objectPath } from './path-cache'

const BLEND: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  add: 'lighter',
}

/** A live, uncommitted stroke drawn on top of the cached scene. */
export interface ActiveStroke {
  outline: Outline
  /** Symmetry instances. Always at least one (the identity). */
  transforms: readonly Mat2D[]
  style: Style
  z: number
}

export interface OverlayDraw {
  (ctx: CanvasRenderingContext2D, camera: Camera): void
}

export interface RenderStats {
  drawn: number
  culled: number
  cacheHit: boolean
  frameMs: number
}

/**
 * Canvas2D scene renderer with a committed-layer cache.
 *
 * Everything already in the document is composited once into an offscreen
 * buffer. While the user draws, each frame is a single blit of that buffer plus
 * the live stroke — so stroke latency does not grow with document size. The
 * buffer is only rebuilt when the document changes or the camera moves, and
 * even then only objects intersecting the viewport are touched.
 */
export class SceneRenderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  private cacheCanvas: HTMLCanvasElement | null = null
  private cacheCtx: CanvasRenderingContext2D | null = null
  private cacheKey = ''

  private readonly matrix: Mat2D = identity()
  private readonly cameraMatrix: Mat2D = identity()

  /** Background colour of the infinite canvas. */
  background = '#0e0f12'
  /** Draw the reference grid. */
  showGrid = true
  /** Depth cue strength: how much distant objects fade toward the background. */
  depthFog = 0.35

  readonly stats: RenderStats = {
    drawn: 0,
    culled: 0,
    cacheHit: false,
    frameMs: 0,
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
  }

  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.canvas.style.width = `${width}px`
      this.canvas.style.height = `${height}px`
      this.cacheKey = ''
    }
    if (
      !this.cacheCanvas ||
      this.cacheCanvas.width !== w ||
      this.cacheCanvas.height !== h
    ) {
      const cache = this.cacheCanvas ?? document.createElement('canvas')
      cache.width = w
      cache.height = h
      this.cacheCanvas = cache
      this.cacheCtx = cache.getContext('2d', { alpha: false })
      this.cacheKey = ''
    }
  }

  /** Forces the committed layer to rebuild on the next frame. */
  invalidate(): void {
    this.cacheKey = ''
  }

  render(
    doc: SceneDocument,
    camera: Camera,
    active: ActiveStroke | null,
    overlay?: OverlayDraw
  ): RenderStats {
    const t0 = performance.now()
    const dpr = camera.dpr
    const cacheCtx = this.cacheCtx

    const key = `${doc.revision}|${camera.signature()}|${this.showGrid ? 1 : 0}|${this.depthFog}`
    const hit = key === this.cacheKey && cacheCtx !== null

    this.stats.drawn = 0
    this.stats.culled = 0
    this.stats.cacheHit = hit

    if (!hit && cacheCtx) {
      cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      cacheCtx.globalCompositeOperation = 'source-over'
      cacheCtx.globalAlpha = 1
      cacheCtx.fillStyle = this.background
      cacheCtx.fillRect(0, 0, camera.width, camera.height)
      if (this.showGrid) this.drawGrid(cacheCtx, camera)
      this.drawObjects(cacheCtx, doc, camera)
      this.cacheKey = key
    }

    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    if (this.cacheCanvas) ctx.drawImage(this.cacheCanvas, 0, 0)
    else {
      ctx.fillStyle = this.background
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    }

    if (active && active.outline.count > 2) this.drawActive(ctx, camera, active)

    if (overlay) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      overlay(ctx, camera)
    }

    this.stats.frameMs = performance.now() - t0
    return this.stats
  }

  private drawObjects(
    ctx: CanvasRenderingContext2D,
    doc: SceneDocument,
    camera: Camera
  ): void {
    const view = camera.visibleBounds(64 / camera.zoom)
    const visible = doc.query(view)
    const visibleIds = new Set(visible.map((o) => o.id))
    const dpr = camera.dpr

    // Smooth paths only pay off once a stroke is large on screen.
    const smooth = camera.zoom > 0.75

    for (const object of doc.renderList()) {
      if (!visibleIds.has(object.id)) {
        this.stats.culled += 1
        continue
      }
      if (!object.visible) continue
      const layer = doc.layers.find((l) => l.id === object.layerId)
      if (layer && !layer.visible) continue

      const alpha = object.style.opacity * (layer?.opacity ?? 1)
      if (alpha <= 0.002) continue

      this.paintObject(ctx, camera, object, alpha, smooth, dpr)
      this.stats.drawn += 1
    }
  }

  private paintObject(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    object: SceneObject,
    alpha: number,
    smooth: boolean,
    dpr: number
  ): void {
    const local = objectMatrix(object)
    const cam = camera.matrixFor(object.transform.z, this.cameraMatrix)
    const m = multiply(cam, local, this.matrix)

    ctx.setTransform(
      m.a * dpr,
      m.b * dpr,
      m.c * dpr,
      m.d * dpr,
      m.e * dpr,
      m.f * dpr
    )
    ctx.globalCompositeOperation = BLEND[object.style.blend]
    ctx.globalAlpha = alpha * this.depthAlpha(object.transform.z)
    ctx.fillStyle = object.style.color

    const path = objectPath(object, smooth)
    ctx.fill(path)

    if (object.style.outlineWidth > 0) {
      ctx.lineWidth = object.style.outlineWidth
      ctx.strokeStyle = object.style.outlineColor
      ctx.lineJoin = 'round'
      ctx.stroke(path)
    }
  }

  /** Objects far from the focal plane sit back a little. */
  private depthAlpha(z: number): number {
    if (this.depthFog <= 0 || z === 0) return 1
    const t = Math.min(1, Math.abs(z) / 900)
    return 1 - t * this.depthFog
  }

  private drawActive(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    active: ActiveStroke
  ): void {
    const dpr = camera.dpr
    const path = buildPath(
      active.outline.points,
      active.outline.count,
      camera.zoom > 0.75
    )
    const cam = camera.matrixFor(active.z, this.cameraMatrix)

    ctx.globalCompositeOperation = BLEND[active.style.blend]
    ctx.globalAlpha = active.style.opacity
    ctx.fillStyle = active.style.color

    for (const instance of active.transforms) {
      const m = multiply(cam, instance, this.matrix)
      ctx.setTransform(
        m.a * dpr,
        m.b * dpr,
        m.c * dpr,
        m.d * dpr,
        m.e * dpr,
        m.f * dpr
      )
      ctx.fill(path)
      if (active.style.outlineWidth > 0) {
        ctx.lineWidth = active.style.outlineWidth
        ctx.strokeStyle = active.style.outlineColor
        ctx.lineJoin = 'round'
        ctx.stroke(path)
      }
    }
  }

  /**
   * Adaptive reference grid. The spacing snaps to a power of ten so the grid
   * stays readable at any zoom instead of dissolving into moiré.
   */
  private drawGrid(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const targetPx = 64
    const raw = targetPx / camera.zoom
    const pow = Math.pow(10, Math.floor(Math.log10(raw)))
    const candidates = [pow, pow * 2, pow * 5, pow * 10]
    let step = candidates[0]
    for (const c of candidates) {
      if (c * camera.zoom >= targetPx * 0.6) {
        step = c
        break
      }
    }

    const view = camera.visibleBounds()
    const x0 = Math.floor(view.minX / step) * step
    const y0 = Math.floor(view.minY / step) * step

    ctx.save()
    ctx.setTransform(camera.dpr, 0, 0, camera.dpr, 0, 0)
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = x0; x <= view.maxX; x += step) {
      const s = camera.toScreen(x, 0)
      ctx.moveTo(Math.round(s.x) + 0.5, 0)
      ctx.lineTo(Math.round(s.x) + 0.5, camera.height)
    }
    for (let y = y0; y <= view.maxY; y += step) {
      const s = camera.toScreen(0, y)
      ctx.moveTo(0, Math.round(s.y) + 0.5)
      ctx.lineTo(camera.width, Math.round(s.y) + 0.5)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.035)'
    ctx.stroke()

    // Origin axes, so the user can always find document zero.
    const origin = camera.toScreen(0, 0)
    ctx.beginPath()
    ctx.moveTo(Math.round(origin.x) + 0.5, 0)
    ctx.lineTo(Math.round(origin.x) + 0.5, camera.height)
    ctx.moveTo(0, Math.round(origin.y) + 0.5)
    ctx.lineTo(camera.width, Math.round(origin.y) + 0.5)
    ctx.strokeStyle = 'rgba(255,255,255,0.075)'
    ctx.stroke()
    ctx.restore()
  }
}
