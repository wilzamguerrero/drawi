import { clamp, TAU } from '@/core/math'
import type { Id } from '@/core/id'
import {
  applyDirX,
  applyDirY,
  applyX,
  applyY,
  identity,
  isIdentity,
  meanScale,
  type Mat2D,
} from '@/core/mat2d'
import { randomSeed } from '@/core/random'
import { FieldSourceBuffer } from '@/field/source'
import { appendSpineSources, buildFieldSources } from '@/field/build'
import { defaultContourOptions, traceField } from '@/field/marching'
import { PointerInput, type PointerFrame } from '@/input/pointer'
import { bakeObjectTransform, PhysicsWorld } from '@/physics/world'
import { Camera } from '@/render/camera'
import { FieldRenderer } from '@/render/field-renderer'
import { SceneRenderer, type ActiveStroke } from '@/render/scene-renderer'
import { SceneDocument } from '@/scene/document'
import {
  createObject,
  geometryFromBuilder,
  geometryFromRing,
  hitTestObject,
  objectWorldBounds,
  touchObject,
} from '@/scene/object'
import type { Behavior, Geometry, SceneObject } from '@/scene/types'
import { SPINE_STRIDE } from '@/scene/types'
import { useStore, type AppState } from '@/state/store'
import { StrokeBuilder } from '@/stroke/builder'
import {
  emptyBounds,
  growBounds,
  type Bounds,
  type RawSample,
} from '@/stroke/types'
import {
  buildSymmetryTransforms,
  symmetryGuideLines,
} from '@/symmetry/symmetry'
import { buildBlob, buildSplat } from '@/tools/shapes'
import { History } from './history'
import {
  download,
  downloadText,
  renderToCanvas,
  serialize,
  deserialize,
  toSVG,
} from '@/io/project'

const PHYSICS_STEP = 1 / 120
const MAX_PHYSICS_STEPS = 4

type Gesture =
  | { kind: 'none' }
  | { kind: 'draw' }
  | { kind: 'splat'; created: Id[]; lastX: number; lastY: number }
  | { kind: 'blob'; object: SceneObject; cx: number; cy: number }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'grab' }
  | { kind: 'erase'; removed: Array<{ object: SceneObject; index: number }> }
  | {
      kind: 'move'
      ids: Id[]
      startX: number
      startY: number
      origins: Array<{ x: number; y: number }>
    }
  | { kind: 'symmetry'; rotating: boolean }

/**
 * The editor.
 *
 * This is the imperative core: it owns the document, the camera, both
 * renderers, the solver and the input layer, and runs the frame loop. React
 * never sees a pointer move — it only reads the settings store and issues
 * commands here. That separation is what keeps stroke latency independent of
 * how much interface is on screen.
 */
export class Editor {
  doc = new SceneDocument()
  readonly camera = new Camera()
  readonly physics = new PhysicsWorld()
  readonly history = new History()

  private scene: SceneRenderer | null = null
  private field: FieldRenderer | null = null
  private host: HTMLElement | null = null
  private readonly input = new PointerInput()
  private readonly sources = new FieldSourceBuffer(1024)

  private builder: StrokeBuilder | null = null
  private drawingFill = false
  private activeTransforms: readonly Mat2D[] = [identity()]
  private gesture: Gesture = { kind: 'none' }

  private raf = 0
  private lastTime = 0
  private accumulator = 0
  private fpsAccumulator = 0
  private fpsFrames = 0

  private hoverX = 0
  private hoverY = 0
  private hoverActive = false
  private spaceDown = false

  private sourcesKey = ''
  private settingsKey = ''
  private resizeObserver: ResizeObserver | null = null
  private unsubscribe: (() => void) | null = null

  private get settings(): AppState {
    return useStore.getState()
  }

  attach(
    host: HTMLElement,
    sceneCanvas: HTMLCanvasElement,
    fieldCanvas: HTMLCanvasElement
  ): void {
    this.host = host
    this.scene = new SceneRenderer(sceneCanvas)
    this.field = new FieldRenderer(fieldCanvas)

    if (!this.field.available) {
      useStore.getState().patch({
        notice: `Liquid layer disabled — ${this.field.unsupportedReason}`,
      })
    }

    this.input.attach(host, {
      onDown: (f) => this.onDown(f),
      onMove: (f) => this.onMove(f),
      onUp: (f) => this.onUp(f),
      onCancel: () => this.onCancel(),
      onHover: (f) => this.onHover(f),
      onLeave: () => {
        this.hoverActive = false
      },
      onWheel: (dx, dy, x, y, zoom) => this.onWheel(dx, dy, x, y, zoom),
      onGesture: (px, py, scale, cx, cy) =>
        this.onGesture(px, py, scale, cx, cy),
      onGestureEnd: () => undefined,
    })

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(host)
    this.handleResize()

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)

    this.unsubscribe = useStore.subscribe(() => this.applySettings())
    this.history.subscribe(() => {
      useStore.getState().patch({
        canUndo: this.history.canUndo,
        canRedo: this.history.canRedo,
      })
    })
    this.applySettings()

    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  detach(): void {
    cancelAnimationFrame(this.raf)
    this.input.detach()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.unsubscribe?.()
    this.unsubscribe = null
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.field?.dispose()
    this.scene = null
    this.field = null
    this.host = null
  }

  private handleResize(): void {
    const host = this.host
    if (!host) return
    const rect = host.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    this.camera.resize(rect.width, rect.height, dpr)
    this.scene?.resize(rect.width, rect.height, dpr)
    this.field?.resize(rect.width, rect.height, dpr)
  }

  /** Mirrors store settings into the engine objects that need them. */
  private applySettings(): void {
    const s = this.settings
    // Stats tick through the same store every half second; without this guard
    // the committed-layer cache would be thrown away twice a second for nothing.
    const key = `${s.showGrid}|${s.liquid.resolution}|${JSON.stringify(s.physics)}`
    if (key === this.settingsKey) return
    this.settingsKey = key

    if (this.scene) {
      this.scene.showGrid = s.showGrid
      this.scene.invalidate()
    }
    if (this.field && this.field.resolutionScale !== s.liquid.resolution) {
      this.field.resolutionScale = clamp(s.liquid.resolution, 0.25, 1)
      const host = this.host
      if (host) {
        const rect = host.getBoundingClientRect()
        this.field.resize(
          rect.width,
          rect.height,
          Math.min(window.devicePixelRatio || 1, 2.5)
        )
      }
    }

    const p = s.physics
    this.physics.gravityX = p.gravityX
    this.physics.gravityY = p.gravityY
    this.physics.windX = p.windX
    this.physics.windY = p.windY
    this.physics.drag = p.drag
    this.physics.attraction = p.attraction
    this.physics.attractionRange = p.attractionRange
    this.physics.iterations = p.iterations
    this.physics.collisions = p.collisions
    this.physics.running = p.running
    this.physics.container = p.container
      ? this.camera.visibleBounds(-20)
      : null
    this.sourcesKey = ''
  }

  // ---------------------------------------------------------------- frame loop

  private readonly tick = (time: number): void => {
    const dt = Math.min(0.1, (time - this.lastTime) / 1000)
    this.lastTime = time

    this.fpsAccumulator += dt
    this.fpsFrames += 1

    if (this.physics.running || this.physics.grabbing) {
      this.accumulator += dt
      let steps = 0
      while (this.accumulator >= PHYSICS_STEP && steps < MAX_PHYSICS_STEPS) {
        this.physics.step(PHYSICS_STEP, this.doc)
        this.accumulator -= PHYSICS_STEP
        steps += 1
      }
      if (steps > 0) {
        this.physics.writeBack(this.doc)
        this.scene?.invalidate()
      }
    } else {
      this.accumulator = 0
    }

    this.render()

    if (this.fpsAccumulator >= 0.5) {
      const fps = this.fpsFrames / this.fpsAccumulator
      this.fpsAccumulator = 0
      this.fpsFrames = 0
      useStore.getState().setStats({
        fps: Math.round(fps),
        frameMs: this.scene?.stats.frameMs ?? 0,
        objects: this.doc.objects.size,
        drawn: this.scene?.stats.drawn ?? 0,
        sources: this.sources.count,
        particles: this.physics.particleCount,
        bodies: this.physics.bodyCount,
        realPressure: this.builder?.usingRealPressure ?? false,
      })
    }

    this.raf = requestAnimationFrame(this.tick)
  }

  private render(): void {
    const scene = this.scene
    if (!scene) return
    const s = this.settings

    let active: ActiveStroke | null = null
    if (this.builder && !this.builder.isEmpty) {
      active = {
        outline: this.builder.getOutline(),
        transforms: this.activeTransforms,
        style: {
          color: s.color,
          opacity: s.opacity,
          blend: s.blend,
          outlineWidth: 0,
          outlineColor: '#000',
        },
        z: s.z,
      }
    }

    scene.render(this.doc, this.camera, active, (ctx, camera) =>
      this.drawOverlay(ctx, camera)
    )

    this.renderField()
  }

  private renderField(): void {
    const field = this.field
    const s = this.settings
    if (!field || !field.available) return
    if (!s.liquid.visible) {
      field.clear()
      return
    }

    const view = this.camera.visibleBounds()
    const pad = 200 / this.camera.zoom
    const liveKey = this.builder ? this.builder.pointCount : 0
    const key = `${this.doc.revision}|${this.camera.signature()}|${liveKey}`

    if (key !== this.sourcesKey) {
      buildFieldSources(this.sources, this.doc, view, pad)
      if (this.builder && s.liquid.autoJoin) {
        appendSpineSources(
          this.sources,
          this.builder.getSpine(),
          1,
          1,
          Math.max(1, s.brush.size * 0.6)
        )
      }
      this.sourcesKey = key
    }

    field.render(this.sources, this.camera, s.liquid.style)
  }

  // ------------------------------------------------------------------- overlay

  private drawOverlay(
    ctx: CanvasRenderingContext2D,
    camera: Camera
  ): void {
    const s = this.settings

    if (s.symmetry.enabled && s.symmetry.showGuides) {
      this.drawSymmetryGuides(ctx, camera, s)
    }

    if (s.selection.length > 0) this.drawSelection(ctx, camera, s.selection)

    if (s.showParticles) this.drawParticles(ctx, camera, s.selection)

    if (this.hoverActive && !this.builder) this.drawCursor(ctx, s)
  }

  private drawSymmetryGuides(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    s: AppState
  ): void {
    const extent = Math.max(camera.width, camera.height) / camera.zoom
    const lines = symmetryGuideLines(s.symmetry, extent)

    ctx.save()
    ctx.lineWidth = 1
    ctx.strokeStyle =
      s.tool === 'symmetry' ? 'rgba(120,200,255,0.75)' : 'rgba(120,200,255,0.28)'
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    for (const [x0, y0, x1, y1] of lines) {
      const a = camera.toScreen(x0, y0)
      ctx.moveTo(a.x, a.y)
      const b = camera.toScreen(x1, y1)
      ctx.lineTo(b.x, b.y)
    }
    ctx.stroke()
    ctx.setLineDash([])

    const origin = camera.toScreen(s.symmetry.originX, s.symmetry.originY)
    ctx.beginPath()
    ctx.arc(origin.x, origin.y, 6, 0, TAU)
    ctx.fillStyle = 'rgba(120,200,255,0.9)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(8,10,14,0.9)'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()
  }

  private drawSelection(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    ids: Id[]
  ): void {
    ctx.save()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,196,96,0.9)'
    ctx.setLineDash([4, 4])
    for (const id of ids) {
      const object = this.doc.get(id)
      if (!object) continue
      const b = objectWorldBounds(object)
      const a = camera.toScreen(b.minX, b.minY, object.transform.z)
      const c = camera.toScreen(b.maxX, b.maxY, object.transform.z)
      ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y)
    }
    ctx.restore()
  }

  private drawParticles(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    selection: Id[]
  ): void {
    const highlight = new Set(selection)
    ctx.save()
    for (const object of this.doc.objects.values()) {
      if (!this.physics.hasBody(object.id)) continue
      const isSelected = highlight.has(object.id)
      ctx.fillStyle = isSelected
        ? 'rgba(255,196,96,0.9)'
        : 'rgba(120,200,255,0.55)'
      this.physics.forEachParticle(object.id, (_i, x, y) => {
        const p = camera.toScreen(x, y, object.transform.z)
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.5, 0, TAU)
        ctx.fill()
      })
    }
    ctx.restore()
  }

  private drawCursor(ctx: CanvasRenderingContext2D, s: AppState): void {
    const size =
      s.tool === 'splat'
        ? s.splat.size
        : s.tool === 'blob'
          ? s.blob.radius
          : s.tool === 'fill'
            ? s.brush.size * 3.2
            : s.brush.size
    const r = Math.max(2, (size * 0.5) * this.camera.zoom)
    ctx.save()
    ctx.beginPath()
    ctx.arc(this.hoverX, this.hoverY, r, 0, TAU)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(this.hoverX, this.hoverY, 1.5, 0, TAU)
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fill()
    ctx.restore()
  }

  // --------------------------------------------------------------- input

  private toWorld(f: PointerFrame): { x: number; y: number } {
    return this.camera.toWorld(f.x, f.y, this.settings.z)
  }

  private sampleFrom(f: PointerFrame): RawSample {
    const w = this.toWorld(f)
    return {
      x: w.x,
      y: w.y,
      pressure: f.pressure,
      tiltX: f.tiltX,
      tiltY: f.tiltY,
      twist: f.twist,
      time: f.time,
    }
  }

  private onDown(f: PointerFrame): void {
    const s = this.settings

    // Middle button or space always pans, whatever tool is active.
    if (f.buttons === 4 || this.spaceDown) {
      this.gesture = { kind: 'pan', lastX: f.x, lastY: f.y }
      return
    }

    const tool = f.eraser ? 'erase' : s.tool
    const world = this.toWorld(f)

    switch (tool) {
      case 'stroke':
      case 'fill':
        this.beginStroke(f, tool === 'fill')
        break
      case 'splat':
        this.gesture = {
          kind: 'splat',
          created: [],
          lastX: world.x,
          lastY: world.y,
        }
        this.emitSplat(world.x, world.y, 0, 0, 0, f.pressure || 0.5)
        break
      case 'blob':
        this.beginBlob(world.x, world.y)
        break
      case 'grab':
        this.physics.grab(world.x, world.y, 60 / this.camera.zoom)
        this.gesture = { kind: 'grab' }
        break
      case 'erase':
        this.gesture = { kind: 'erase', removed: [] }
        this.eraseAt(world.x, world.y)
        break
      case 'symmetry':
        this.gesture = { kind: 'symmetry', rotating: f.shiftKey }
        this.updateSymmetryFromPointer(world.x, world.y, f.shiftKey)
        break
      case 'select':
        this.beginSelect(world.x, world.y, f.shiftKey)
        break
      default:
        break
    }
  }

  private onMove(f: PointerFrame): void {
    this.hoverX = f.x
    this.hoverY = f.y
    this.hoverActive = true

    const world = this.toWorld(f)

    switch (this.gesture.kind) {
      case 'pan': {
        this.camera.panBy(f.x - this.gesture.lastX, f.y - this.gesture.lastY)
        this.gesture.lastX = f.x
        this.gesture.lastY = f.y
        break
      }
      case 'draw': {
        this.builder?.push(this.sampleFrom(f))
        break
      }
      case 'splat': {
        const dx = world.x - this.gesture.lastX
        const dy = world.y - this.gesture.lastY
        const travelled = Math.hypot(dx, dy)
        const spacing = this.settings.splat.size * 1.05
        if (travelled >= spacing) {
          const speed = travelled / Math.max(1, 16)
          this.emitSplat(world.x, world.y, dx, dy, speed, f.pressure || 0.5)
          this.gesture.lastX = world.x
          this.gesture.lastY = world.y
        }
        break
      }
      case 'blob': {
        this.updateBlob(world.x, world.y)
        break
      }
      case 'grab': {
        this.physics.moveGrab(world.x, world.y)
        break
      }
      case 'erase': {
        this.eraseAt(world.x, world.y)
        break
      }
      case 'symmetry': {
        this.updateSymmetryFromPointer(world.x, world.y, this.gesture.rotating)
        break
      }
      case 'move': {
        const move = this.gesture
        const dx = world.x - move.startX
        const dy = world.y - move.startY
        move.ids.forEach((id, i) => {
          const object = this.doc.get(id)
          if (!object) return
          object.transform.x = move.origins[i].x + dx
          object.transform.y = move.origins[i].y + dy
          touchObject(object)
          this.doc.reindex(id)
        })
        this.scene?.invalidate()
        break
      }
      default:
        break
    }
  }

  private onUp(_f: PointerFrame): void {
    switch (this.gesture.kind) {
      case 'draw':
        this.commitStroke()
        break
      case 'splat':
        this.finishSplatGesture(this.gesture.created)
        break
      case 'blob':
        this.finishBlob(this.gesture.object)
        break
      case 'grab':
        this.physics.releaseGrab()
        break
      case 'erase':
        this.finishErase(this.gesture.removed)
        break
      case 'move':
        this.finishMove(this.gesture.ids, this.gesture.origins)
        break
      default:
        break
    }
    this.gesture = { kind: 'none' }
  }

  private onCancel(): void {
    if (this.gesture.kind === 'draw') this.builder = null
    if (this.gesture.kind === 'grab') this.physics.releaseGrab()
    this.gesture = { kind: 'none' }
  }

  private onHover(f: PointerFrame): void {
    this.hoverX = f.x
    this.hoverY = f.y
    this.hoverActive = true
  }

  private onWheel(
    deltaX: number,
    deltaY: number,
    x: number,
    y: number,
    zoom: boolean
  ): void {
    if (zoom) {
      this.camera.zoomAt(Math.exp(-deltaY * 0.01), x, y)
    } else {
      this.camera.panBy(-deltaX, -deltaY)
    }
  }

  private onGesture(
    panX: number,
    panY: number,
    scale: number,
    cx: number,
    cy: number
  ): void {
    this.camera.panBy(panX, panY)
    if (Math.abs(scale - 1) > 0.001) this.camera.zoomAt(scale, cx, cy)
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

    if (e.code === 'Space') {
      this.spaceDown = true
      return
    }

    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      this.redo()
      return
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      this.saveProject()
      return
    }

    const store = useStore.getState()
    switch (e.key.toLowerCase()) {
      case 'v':
        store.setTool('select')
        break
      case 'b':
        store.setTool('stroke')
        break
      case 'f':
        store.setTool('fill')
        break
      case 'x':
        store.setTool('splat')
        break
      case 'o':
        store.setTool('blob')
        break
      case 'g':
        store.setTool('grab')
        break
      case 'e':
        store.setTool('erase')
        break
      case 'm':
        store.setTool('symmetry')
        break
      case 'delete':
      case 'backspace':
        this.deleteSelection()
        break
      case 'escape':
        store.setSelection([])
        break
      default:
        break
    }
    if (e.key === ' ') e.preventDefault()
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.spaceDown = false
  }

  // ---------------------------------------------------------------- drawing

  private beginStroke(f: PointerFrame, isFill: boolean): void {
    const s = this.settings
    this.drawingFill = isFill
    const options = { ...s.brush, seed: randomSeed() }
    if (isFill) {
      // Fill is the same engine with a much wider, flatter nib: the user paints
      // a mass directly instead of outlining one and filling it afterwards.
      options.size = s.brush.size * 3.2
      options.thinning = s.brush.thinning * 0.45
      options.streamline = Math.min(0.85, s.brush.streamline + 0.1)
    }
    this.builder = new StrokeBuilder(options)
    this.activeTransforms = buildSymmetryTransforms(s.symmetry)
    this.builder.push(this.sampleFrom(f))
    this.gesture = { kind: 'draw' }
  }

  /**
   * Turns the live stroke into document objects.
   *
   * Symmetry is expanded here rather than at draw time: one stroke is built,
   * then baked through each instance transform into its own object. The user
   * gets independently editable copies, and the drawing cost never scales with
   * the number of mirrors.
   */
  private commitStroke(): void {
    const builder = this.builder
    this.builder = null
    if (!builder || builder.isEmpty) return

    builder.finish()
    const s = this.settings
    const base = geometryFromBuilder(builder)
    if (base.outlineCount < 3) return

    // Only the fill tool turns a closed gesture into a solid mass: a loop drawn
    // with the brush is a ring the user meant to see, not a disc.
    const closed = this.drawingFill ? this.detectClosure(builder) : null
    const geometry = closed ?? base

    const pressure = averagePressure(geometry)
    const created: SceneObject[] = []

    for (const m of this.activeTransforms) {
      const instance = isIdentity(m)
        ? cloneGeometryData(geometry)
        : transformGeometry(geometry, m)
      const object = createObject({
        kind: this.drawingFill ? 'fill' : 'stroke',
        layerId: this.doc.activeLayerId,
        geometry: instance,
        style: { color: s.color, opacity: s.opacity, blend: s.blend },
        z: s.z,
        seed: builder.options.seed,
      })
      this.applyPressureMapping(object, pressure)
      if (s.liquid.autoJoin) object.field.enabled = true
      created.push(object)
    }

    this.addObjects(created, created.length > 1 ? 'Draw (symmetry)' : 'Draw')
    this.activeTransforms = [identity()]
  }

  /**
   * If the gesture came back to where it started, treat the spine as a closed
   * ring — the stroke becomes a filled mass rather than a ribbon, which is what
   * makes it usable as a soft body straight away.
   */
  private detectClosure(builder: StrokeBuilder): Geometry | null {
    const spine = builder.getSpine()
    if (spine.length < 8) return null
    const first = spine[0]
    const last = spine[spine.length - 1]
    const gap = Math.hypot(last.x - first.x, last.y - first.y)
    const nib = builder.options.size
    if (gap > nib * 1.4 || builder.length < nib * 4) return null

    const ring = new Float32Array(spine.length * 2)
    const spineData = new Float32Array(spine.length * SPINE_STRIDE)
    const bounds = emptyBounds()
    spine.forEach((p, i) => {
      ring[i * 2] = p.x
      ring[i * 2 + 1] = p.y
      growBounds(bounds, p.x, p.y)
      const o = i * SPINE_STRIDE
      spineData[o] = p.x
      spineData[o + 1] = p.y
      spineData[o + 2] = p.radius
      spineData[o + 3] = p.pressure
    })
    return {
      outline: ring,
      outlineCount: spine.length,
      spine: spineData,
      spineCount: spine.length,
      closed: true,
      bounds,
    }
  }

  /**
   * Pressure is recorded on every point regardless; this decides what else it
   * controls. Routing it to mass or elasticity instead of width is the feature
   * that makes the pen a physical instrument rather than a width dial.
   */
  private applyPressureMapping(object: SceneObject, pressure: number): void {
    const target = this.settings.pressureTarget
    switch (target) {
      case 'mass':
        object.physics.mass = 0.25 + pressure * 3.5
        break
      case 'elasticity':
        object.physics.stiffness = clamp(1.05 - pressure * 0.85, 0.08, 1)
        break
      case 'density':
        object.field.strength = 0.45 + pressure * 1.5
        break
      case 'force':
        object.physics.gravityScale = 0.2 + pressure * 2.2
        break
      case 'opacity':
        object.style.opacity = clamp(0.15 + pressure * 0.85, 0.05, 1)
        break
      case 'scatter':
        object.field.smoothness = 6 + pressure * 40
        break
      case 'width':
      default:
        break
    }
  }

  private emitSplat(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    speed: number,
    pressure: number
  ): void {
    const s = this.settings
    const seed = randomSeed()
    const created: SceneObject[] = []

    for (const m of buildSymmetryTransforms(s.symmetry)) {
      const px = applyX(m, x, y)
      const py = applyY(m, x, y)
      const dx = applyDirX(m, dirX, dirY)
      const dy = applyDirY(m, dirX, dirY)
      const scale = meanScale(m)

      const result = buildSplat(px, py, dx, dy, speed, pressure, {
        ...s.splat,
        seed,
        size: s.splat.size * scale,
      })
      for (const ring of result.rings) {
        const geometry = geometryFromRing(
          ring,
          ring.length / 2,
          result.spine.slice(),
          result.spine.length / SPINE_STRIDE,
          true
        )
        const object = createObject({
          kind: 'splat',
          layerId: this.doc.activeLayerId,
          geometry,
          style: { color: s.color, opacity: s.opacity, blend: s.blend },
          z: s.z,
          seed,
        })
        this.applyPressureMapping(object, pressure)
        if (s.liquid.autoJoin) object.field.enabled = true
        created.push(object)
      }
    }

    for (const object of created) this.doc.add(object)
    this.scene?.invalidate()

    if (this.gesture.kind === 'splat') {
      this.gesture.created.push(...created.map((o) => o.id))
    }
  }

  private finishSplatGesture(ids: Id[]): void {
    if (ids.length === 0) return
    const objects = ids
      .map((id) => this.doc.get(id))
      .filter((o): o is SceneObject => Boolean(o))
    this.history.push({
      label: 'Splat',
      undo: () => {
        for (const o of objects) this.doc.remove(o.id)
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
      redo: () => {
        for (const o of objects) this.doc.add(o)
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
    })
  }

  private beginBlob(x: number, y: number): void {
    const s = this.settings
    const seed = randomSeed()
    const built = buildBlob({ ...s.blob, seed })
    const geometry = geometryFromRing(
      built.ring,
      built.ring.length / 2,
      built.spine,
      1,
      true
    )
    const object = createObject({
      kind: 'blob',
      layerId: this.doc.activeLayerId,
      geometry,
      style: { color: s.color, opacity: s.opacity, blend: s.blend },
      z: s.z,
      seed,
    })
    object.transform.x = x
    object.transform.y = y
    if (s.liquid.autoJoin) object.field.enabled = true
    touchObject(object)
    this.doc.add(object)
    this.scene?.invalidate()
    this.gesture = { kind: 'blob', object, cx: x, cy: y }
  }

  /** Dragging out of a blob sets its scale and rotation in one motion. */
  private updateBlob(x: number, y: number): void {
    if (this.gesture.kind !== 'blob') return
    const { object, cx, cy } = this.gesture
    const dx = x - cx
    const dy = y - cy
    const distance = Math.hypot(dx, dy)
    if (distance < 1) return
    const scale = clamp(distance / this.settings.blob.radius, 0.15, 12)
    object.transform.scaleX = scale
    object.transform.scaleY = scale
    object.transform.rotation = Math.atan2(dy, dx)
    touchObject(object)
    this.doc.reindex(object.id)
    this.scene?.invalidate()
  }

  private finishBlob(object: SceneObject): void {
    this.history.push({
      label: 'Blob',
      undo: () => {
        this.doc.remove(object.id)
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
      redo: () => {
        this.doc.add(object)
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
    })
    useStore.getState().setSelection([object.id])
  }

  private eraseAt(x: number, y: number): void {
    if (this.gesture.kind !== 'erase') return
    const radius = this.settings.brush.size * 0.75
    const probe: Bounds = {
      minX: x - radius,
      minY: y - radius,
      maxX: x + radius,
      maxY: y + radius,
    }
    // Bounds give the candidates; the actual contour decides. Erasing on
    // bounds alone would take out anything whose box happens to overlap.
    const hits = this.doc
      .query(probe)
      .filter((o) => !o.locked && hitTestObject(o, x, y, radius))
    for (const object of hits) {
      const index = this.doc.order.indexOf(object.id)
      this.doc.remove(object.id)
      this.gesture.removed.push({ object, index })
    }
    if (hits.length > 0) {
      this.physics.sync(this.doc)
      this.scene?.invalidate()
    }
  }

  private finishErase(
    removed: Array<{ object: SceneObject; index: number }>
  ): void {
    if (removed.length === 0) return
    this.history.push({
      label: 'Erase',
      undo: () => {
        for (const entry of removed) {
          this.doc.add(entry.object)
          // Restore the original paint order.
          const current = this.doc.order.indexOf(entry.object.id)
          if (current >= 0) {
            this.doc.order.splice(current, 1)
            this.doc.order.splice(
              Math.min(entry.index, this.doc.order.length),
              0,
              entry.object.id
            )
          }
        }
        this.doc.revision += 1
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
      redo: () => {
        for (const entry of removed) this.doc.remove(entry.object.id)
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
    })
  }

  private beginSelect(x: number, y: number, additive: boolean): void {
    const store = useStore.getState()
    const hit = this.doc.pick(x, y, 4 / this.camera.zoom)
    if (!hit) {
      if (!additive) store.setSelection([])
      this.gesture = { kind: 'none' }
      return
    }

    const current = new Set(store.selection)
    if (additive) {
      if (current.has(hit.id)) current.delete(hit.id)
      else current.add(hit.id)
    } else if (!current.has(hit.id)) {
      current.clear()
      current.add(hit.id)
    }
    const ids = [...current]
    store.setSelection(ids)

    this.gesture = {
      kind: 'move',
      ids,
      startX: x,
      startY: y,
      origins: ids.map((id) => {
        const object = this.doc.get(id)
        return { x: object?.transform.x ?? 0, y: object?.transform.y ?? 0 }
      }),
    }
  }

  private finishMove(
    ids: Id[],
    origins: Array<{ x: number; y: number }>
  ): void {
    const after = ids.map((id) => {
      const object = this.doc.get(id)
      return { x: object?.transform.x ?? 0, y: object?.transform.y ?? 0 }
    })
    const moved = after.some(
      (p, i) => p.x !== origins[i].x || p.y !== origins[i].y
    )
    if (!moved) return

    const apply = (values: Array<{ x: number; y: number }>): void => {
      ids.forEach((id, i) => {
        const object = this.doc.get(id)
        if (!object) return
        object.transform.x = values[i].x
        object.transform.y = values[i].y
        touchObject(object)
        this.doc.reindex(id)
      })
      this.physics.sync(this.doc)
      this.scene?.invalidate()
    }
    this.history.push({
      label: 'Move',
      undo: () => apply(origins),
      redo: () => apply(after),
    })
  }

  private updateSymmetryFromPointer(
    x: number,
    y: number,
    rotating: boolean
  ): void {
    const store = useStore.getState()
    if (rotating) {
      const s = store.symmetry
      store.patchSymmetry({
        angle: Math.atan2(y - s.originY, x - s.originX),
      })
    } else {
      store.patchSymmetry({ originX: x, originY: y })
    }
  }

  // ----------------------------------------------------------- public actions

  private addObjects(objects: SceneObject[], label: string): void {
    for (const object of objects) this.doc.add(object)
    this.physics.sync(this.doc)
    this.scene?.invalidate()
    this.history.push({
      label,
      undo: () => {
        for (const object of objects) this.doc.remove(object.id)
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
      redo: () => {
        for (const object of objects) this.doc.add(object)
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
    })
  }

  undo(): void {
    this.history.undo()
    this.physics.sync(this.doc)
    this.scene?.invalidate()
  }

  redo(): void {
    this.history.redo()
    this.physics.sync(this.doc)
    this.scene?.invalidate()
  }

  deleteSelection(): void {
    const store = useStore.getState()
    const removed = store.selection
      .map((id) => {
        const object = this.doc.get(id)
        return object
          ? { object, index: this.doc.order.indexOf(id) }
          : null
      })
      .filter((v): v is { object: SceneObject; index: number } => Boolean(v))
    if (removed.length === 0) return
    for (const entry of removed) this.doc.remove(entry.object.id)
    this.physics.sync(this.doc)
    this.scene?.invalidate()
    store.setSelection([])
    this.finishErase(removed)
  }

  selectAll(): void {
    useStore.getState().setSelection([...this.doc.order])
  }

  /** Switches the behaviour of the current selection. */
  setBehavior(behavior: Behavior): void {
    const store = useStore.getState()
    const ids = store.selection
    if (ids.length === 0) return

    const before = ids.map((id) => this.doc.get(id)?.physics.behavior ?? 'static')
    const apply = (values: Behavior[]): void => {
      ids.forEach((id, i) => {
        const object = this.doc.get(id)
        if (!object) return
        if (values[i] !== 'static') bakeObjectTransform(object)
        object.physics.behavior = values[i]
        touchObject(object)
      })
      this.physics.sync(this.doc)
      this.scene?.invalidate()
    }

    apply(ids.map(() => behavior))
    this.history.push({
      label: `Behavior: ${behavior}`,
      undo: () => apply(before),
      redo: () => apply(ids.map(() => behavior)),
    })
  }

  /** Adds or removes the selection from the implicit field. */
  toggleField(enabled?: boolean): void {
    const store = useStore.getState()
    const ids = store.selection
    if (ids.length === 0) return
    const before = ids.map((id) => this.doc.get(id)?.field.enabled ?? false)
    const next = enabled ?? !before[0]

    const apply = (values: boolean[]): void => {
      ids.forEach((id, i) => {
        const object = this.doc.get(id)
        if (!object) return
        object.field.enabled = values[i]
        touchObject(object)
      })
      this.sourcesKey = ''
      this.scene?.invalidate()
    }
    apply(ids.map(() => next))
    this.history.push({
      label: next ? 'Join liquid' : 'Leave liquid',
      undo: () => apply(before),
      redo: () => apply(ids.map(() => next)),
    })
  }

  /** Sets the polarity of the selection: fuse into the field, or carve out of it. */
  setFieldPolarity(polarity: 1 | -1): void {
    const ids = useStore.getState().selection
    const before = ids.map((id) => this.doc.get(id)?.field.polarity ?? 1)
    const apply = (values: Array<1 | -1>): void => {
      ids.forEach((id, i) => {
        const object = this.doc.get(id)
        if (!object) return
        object.field.polarity = values[i]
        object.field.enabled = true
        touchObject(object)
      })
      this.sourcesKey = ''
    }
    apply(ids.map(() => polarity))
    this.history.push({
      label: polarity > 0 ? 'Fuse' : 'Carve',
      undo: () => apply(before),
      redo: () => apply(ids.map(() => polarity)),
    })
  }

  /**
   * Traces the current liquid surface and turns it into ordinary vector
   * objects. This is the round trip the whole architecture exists for: a
   * simulated, fused, carved mass becomes an editable outline again.
   */
  vectorizeLiquid(): number {
    const view = this.camera.visibleBounds(200 / this.camera.zoom)
    buildFieldSources(this.sources, this.doc, view, 200 / this.camera.zoom)
    if (this.sources.count === 0) return 0

    const s = this.settings
    const options = defaultContourOptions()
    options.iso = s.liquid.style.iso
    options.cell = clamp(2.5 / this.camera.zoom, 0.8, 14)
    options.simplify = options.cell * 0.25
    options.minArea = options.cell * options.cell * 4

    const bounds = emptyBounds()
    for (const object of this.doc.objects.values()) {
      if (!object.field.enabled) continue
      const b = objectWorldBounds(object)
      growBounds(bounds, b.minX, b.minY, object.field.smoothness * 2)
      growBounds(bounds, b.maxX, b.maxY, object.field.smoothness * 2)
    }
    if (!Number.isFinite(bounds.minX)) return 0

    const rings = traceField(this.sources, bounds, options)
    if (rings.length === 0) return 0

    const created = rings.map((ring) =>
      createObject({
        kind: 'blob',
        layerId: this.doc.activeLayerId,
        geometry: geometryFromRing(ring, ring.length / 2, undefined, 0, true),
        style: {
          color: rgbToHex(s.liquid.style.color),
          opacity: s.liquid.style.opacity,
          blend: s.blend,
        },
        z: s.z,
        name: 'liquid',
      })
    )
    this.addObjects(created, 'Vectorize liquid')
    useStore.getState().setSelection(created.map((o) => o.id))
    return created.length
  }

  resetPhysics(): void {
    this.physics.reset(this.doc)
    this.scene?.invalidate()
  }

  clearAll(): void {
    const objects = [...this.doc.objects.values()]
    const order = [...this.doc.order]
    if (objects.length === 0) return
    this.doc.clear()
    this.physics.clear()
    this.scene?.invalidate()
    useStore.getState().setSelection([])
    this.history.push({
      label: 'Clear',
      undo: () => {
        for (const object of objects) this.doc.add(object)
        this.doc.order.length = 0
        this.doc.order.push(...order)
        this.doc.revision += 1
        this.physics.sync(this.doc)
        this.scene?.invalidate()
      },
      redo: () => {
        this.doc.clear()
        this.physics.clear()
        this.scene?.invalidate()
      },
    })
  }

  frameAll(): void {
    const b = this.doc.boundsOf()
    if (!Number.isFinite(b.minX)) return
    const width = Math.max(1, b.maxX - b.minX)
    const height = Math.max(1, b.maxY - b.minY)
    const zoom = Math.min(
      (this.camera.width * 0.85) / width,
      (this.camera.height * 0.85) / height
    )
    this.camera.setZoom(zoom)
    this.camera.setPan((b.minX + b.maxX) * 0.5, (b.minY + b.maxY) * 0.5)
  }

  resetView(): void {
    this.camera.setZoom(1)
    this.camera.setPan(0, 0)
    this.camera.setTilt(0, 0)
  }

  exportSVG(): void {
    const bounds = this.doc.boundsOf()
    if (!Number.isFinite(bounds.minX)) return
    downloadText(
      'drawi.svg',
      toSVG(this.doc, bounds, undefined),
      'image/svg+xml'
    )
  }

  exportPNG(scale = 2): void {
    const bounds = this.doc.boundsOf()
    if (!Number.isFinite(bounds.minX)) return
    const canvas = renderToCanvas(
      this.doc,
      bounds,
      scale,
      this.scene?.background ?? '#0e0f12',
      false
    )
    canvas.toBlob((blob) => {
      if (blob) download('drawi.png', blob)
    }, 'image/png')
  }

  saveProject(): void {
    downloadText(
      'drawi-project.json',
      serialize(this.doc, this.camera),
      'application/json'
    )
  }

  async loadProject(file: File): Promise<void> {
    const text = await file.text()
    const doc = deserialize(text, this.camera)
    this.doc = doc
    this.physics.clear()
    this.physics.sync(this.doc)
    this.history.clear()
    this.sourcesKey = ''
    this.scene?.invalidate()
    useStore.getState().setSelection([])
  }
}

// ------------------------------------------------------------------ helpers

const cloneGeometryData = (g: Geometry): Geometry => ({
  outline: g.outline.slice(0, g.outlineCount * 2),
  outlineCount: g.outlineCount,
  spine: g.spine.slice(0, g.spineCount * SPINE_STRIDE),
  spineCount: g.spineCount,
  closed: g.closed,
  bounds: { ...g.bounds },
})

/** Bakes a matrix into a copy of the geometry, keeping radii proportional. */
const transformGeometry = (g: Geometry, m: Mat2D): Geometry => {
  const outline = new Float32Array(g.outlineCount * 2)
  const bounds = emptyBounds()
  for (let i = 0; i < g.outlineCount; i++) {
    const x = g.outline[i * 2]
    const y = g.outline[i * 2 + 1]
    const tx = applyX(m, x, y)
    const ty = applyY(m, x, y)
    outline[i * 2] = tx
    outline[i * 2 + 1] = ty
    growBounds(bounds, tx, ty)
  }

  const scale = meanScale(m)
  const spine = new Float32Array(g.spineCount * SPINE_STRIDE)
  for (let i = 0; i < g.spineCount; i++) {
    const o = i * SPINE_STRIDE
    const x = g.spine[o]
    const y = g.spine[o + 1]
    spine[o] = applyX(m, x, y)
    spine[o + 1] = applyY(m, x, y)
    spine[o + 2] = g.spine[o + 2] * scale
    spine[o + 3] = g.spine[o + 3]
  }

  return {
    outline,
    outlineCount: g.outlineCount,
    spine,
    spineCount: g.spineCount,
    closed: g.closed,
    bounds,
  }
}

const averagePressure = (g: Geometry): number => {
  if (g.spineCount === 0) return 0.5
  let sum = 0
  for (let i = 0; i < g.spineCount; i++) sum += g.spine[i * SPINE_STRIDE + 3]
  return sum / g.spineCount
}

const rgbToHex = (rgb: [number, number, number]): string => {
  const channel = (v: number): string =>
    Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`
}
