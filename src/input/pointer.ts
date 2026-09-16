/**
 * Pointer input.
 *
 * Three things here matter more than they look:
 *
 *  - `pointerrawupdate` and `getCoalescedEvents` recover the samples the
 *    browser would otherwise throw away. A tablet reporting at 240 Hz into a
 *    60 Hz frame loop loses three quarters of the stroke without them, and that
 *    loss is exactly what makes a line look chunky at speed.
 *  - Palm rejection: while a pen is down, touch pointers are ignored entirely.
 *  - Two-finger gestures are handled here rather than in the tools, so every
 *    tool gets pan and zoom for free and none of them can break it.
 */

export type PointerKind = 'mouse' | 'pen' | 'touch'

export interface PointerFrame {
  pointerId: number
  kind: PointerKind
  /** Position in CSS pixels, relative to the element. */
  x: number
  y: number
  pressure: number
  tiltX: number
  tiltY: number
  twist: number
  time: number
  buttons: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  /** True for eraser-button or inverted-stylus input. */
  eraser: boolean
}

export interface PointerHandlers {
  onDown(frame: PointerFrame): void
  /** Called once per coalesced sample, so it can fire several times a frame. */
  onMove(frame: PointerFrame): void
  onUp(frame: PointerFrame): void
  onCancel(): void
  onHover(frame: PointerFrame): void
  onLeave(): void
  /** Scroll or trackpad zoom. `scale` is 1 for pure panning. */
  onWheel(deltaX: number, deltaY: number, x: number, y: number, zoom: boolean): void
  /** Two-finger gesture update. */
  onGesture(
    panX: number,
    panY: number,
    scale: number,
    centerX: number,
    centerY: number
  ): void
  onGestureEnd(): void
}

interface TouchPoint {
  x: number
  y: number
}

export class PointerInput {
  private element: HTMLElement | null = null
  private handlers: PointerHandlers | null = null

  private activePointerId: number | null = null
  private penActive = false
  private readonly touches = new Map<number, TouchPoint>()

  private gestureActive = false
  private lastGestureDistance = 0
  private lastGestureCenterX = 0
  private lastGestureCenterY = 0

  private readonly boundDown = (e: PointerEvent) => this.handleDown(e)
  private readonly boundMove = (e: PointerEvent) => this.handleMove(e)
  private readonly boundRaw = (e: PointerEvent) => this.handleRaw(e)
  private readonly boundUp = (e: PointerEvent) => this.handleUp(e)
  private readonly boundCancel = (e: PointerEvent) => this.handleCancel(e)
  private readonly boundEnter = (e: PointerEvent) => this.handleHover(e)
  private readonly boundLeave = () => this.handlers?.onLeave()
  private readonly boundWheel = (e: WheelEvent) => this.handleWheel(e)
  private readonly boundContext = (e: Event) => e.preventDefault()

  attach(element: HTMLElement, handlers: PointerHandlers): void {
    this.detach()
    this.element = element
    this.handlers = handlers

    element.style.touchAction = 'none'
    element.addEventListener('pointerdown', this.boundDown)
    element.addEventListener('pointermove', this.boundMove)
    // Not in every browser's typings, but widely shipped and worth the latency.
    element.addEventListener(
      'pointerrawupdate' as 'pointermove',
      this.boundRaw
    )
    element.addEventListener('pointerup', this.boundUp)
    element.addEventListener('pointercancel', this.boundCancel)
    element.addEventListener('pointerenter', this.boundEnter)
    element.addEventListener('pointerleave', this.boundLeave)
    element.addEventListener('wheel', this.boundWheel, { passive: false })
    element.addEventListener('contextmenu', this.boundContext)
  }

  detach(): void {
    const element = this.element
    if (!element) return
    element.removeEventListener('pointerdown', this.boundDown)
    element.removeEventListener('pointermove', this.boundMove)
    element.removeEventListener(
      'pointerrawupdate' as 'pointermove',
      this.boundRaw
    )
    element.removeEventListener('pointerup', this.boundUp)
    element.removeEventListener('pointercancel', this.boundCancel)
    element.removeEventListener('pointerenter', this.boundEnter)
    element.removeEventListener('pointerleave', this.boundLeave)
    element.removeEventListener('wheel', this.boundWheel)
    element.removeEventListener('contextmenu', this.boundContext)
    this.element = null
    this.handlers = null
    this.touches.clear()
    this.activePointerId = null
    this.penActive = false
    this.gestureActive = false
  }

  private frame(e: PointerEvent): PointerFrame {
    const rect = this.element!.getBoundingClientRect()
    const kind = (e.pointerType || 'mouse') as PointerKind
    return {
      pointerId: e.pointerId,
      kind,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      // A pen at rest reports 0; the pressure model treats that as "no signal".
      pressure: e.pressure,
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      twist: e.twist ?? 0,
      time: e.timeStamp,
      buttons: e.buttons,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      eraser: e.buttons === 32,
    }
  }

  private handleDown(e: PointerEvent): void {
    if (!this.handlers || !this.element) return

    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      // A second finger cancels drawing and becomes a navigation gesture.
      if (this.touches.size >= 2) {
        if (this.activePointerId !== null) {
          this.handlers.onCancel()
          this.activePointerId = null
        }
        this.beginGesture()
        return
      }
      // Ignore the palm resting on the glass while the pen is down.
      if (this.penActive) return
    }

    if (e.pointerType === 'pen') this.penActive = true
    if (this.activePointerId !== null) return

    this.activePointerId = e.pointerId
    this.element.setPointerCapture(e.pointerId)
    this.handlers.onDown(this.frame(e))
  }

  private handleRaw(e: PointerEvent): void {
    // Raw updates arrive ahead of pointermove; the coalesced list is the same
    // data, so taking it here and ignoring the later pointermove avoids
    // processing every sample twice.
    if (e.pointerId !== this.activePointerId) return
    this.emitSamples(e)
  }

  private handleMove(e: PointerEvent): void {
    if (!this.handlers) return

    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.gestureActive) {
        this.updateGesture()
        return
      }
    }

    if (e.pointerId !== this.activePointerId) {
      if (this.activePointerId === null) this.handleHover(e)
      return
    }
    // If rawupdate is unavailable this is the only sample source.
    if (!('onpointerrawupdate' in window)) this.emitSamples(e)
  }

  private emitSamples(e: PointerEvent): void {
    const handlers = this.handlers
    if (!handlers || !this.element) return
    const rect = this.element.getBoundingClientRect()
    const coalesced =
      typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const list = coalesced.length > 0 ? coalesced : [e]

    for (const sample of list) {
      handlers.onMove({
        pointerId: e.pointerId,
        kind: (e.pointerType || 'mouse') as PointerKind,
        x: sample.clientX - rect.left,
        y: sample.clientY - rect.top,
        pressure: sample.pressure,
        tiltX: sample.tiltX ?? 0,
        tiltY: sample.tiltY ?? 0,
        twist: sample.twist ?? 0,
        time: sample.timeStamp,
        buttons: e.buttons,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        eraser: e.buttons === 32,
      })
    }
  }

  private handleHover(e: PointerEvent): void {
    if (!this.handlers || !this.element) return
    this.handlers.onHover(this.frame(e))
  }

  private handleUp(e: PointerEvent): void {
    if (!this.handlers) return

    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId)
      if (this.gestureActive && this.touches.size < 2) this.endGesture()
    }
    if (e.pointerType === 'pen') this.penActive = false

    if (e.pointerId !== this.activePointerId) return
    this.activePointerId = null
    this.element?.releasePointerCapture(e.pointerId)
    this.handlers.onUp(this.frame(e))
  }

  private handleCancel(e: PointerEvent): void {
    if (!this.handlers) return
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId)
    if (e.pointerType === 'pen') this.penActive = false
    if (e.pointerId !== this.activePointerId) return
    this.activePointerId = null
    this.handlers.onCancel()
  }

  private handleWheel(e: WheelEvent): void {
    if (!this.handlers || !this.element) return
    e.preventDefault()
    const rect = this.element.getBoundingClientRect()
    // ctrlKey on a wheel event is how trackpad pinch arrives on every platform.
    this.handlers.onWheel(
      e.deltaX,
      e.deltaY,
      e.clientX - rect.left,
      e.clientY - rect.top,
      e.ctrlKey || e.metaKey
    )
  }

  private beginGesture(): void {
    this.gestureActive = true
    const state = this.gestureState()
    this.lastGestureDistance = state.distance
    this.lastGestureCenterX = state.cx
    this.lastGestureCenterY = state.cy
  }

  private updateGesture(): void {
    if (!this.handlers || !this.element) return
    const state = this.gestureState()
    if (state.distance <= 0) return
    const scale =
      this.lastGestureDistance > 0
        ? state.distance / this.lastGestureDistance
        : 1
    const rect = this.element.getBoundingClientRect()
    this.handlers.onGesture(
      state.cx - this.lastGestureCenterX,
      state.cy - this.lastGestureCenterY,
      scale,
      state.cx - rect.left,
      state.cy - rect.top
    )
    this.lastGestureDistance = state.distance
    this.lastGestureCenterX = state.cx
    this.lastGestureCenterY = state.cy
  }

  private endGesture(): void {
    this.gestureActive = false
    this.handlers?.onGestureEnd()
  }

  private gestureState(): { distance: number; cx: number; cy: number } {
    const points = [...this.touches.values()]
    if (points.length < 2) return { distance: 0, cx: 0, cy: 0 }
    const [a, b] = points
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      cx: (a.x + b.x) * 0.5,
      cy: (a.y + b.y) * 0.5,
    }
  }
}
