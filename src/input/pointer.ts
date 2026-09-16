import { clamp, clamp01, TAU } from "../core/math";

export type PointerKind = "pen" | "touch" | "mouse";

/** Muestra normalizada de entrada, en pixeles CSS relativos al lienzo. */
export interface InputSample {
  x: number;
  y: number;
  /** 0..1 ya normalizada. -1 significa "el dispositivo no informa presion". */
  pressure: number;
  /** Inclinacion en radianes: 0 = perpendicular al plano. */
  tilt: number;
  /** Azimut de la inclinacion en radianes. */
  azimuth: number;
  /** Rotacion del barril (radianes). */
  twist: number;
  /** Lado mayor del area de contacto en px CSS (0 si se desconoce). */
  contact: number;
  t: number;
  kind: PointerKind;
  predicted: boolean;
  /** Boton lateral del lapiz pulsado. */
  barrel: boolean;
  /** Punta de goma del lapiz. */
  eraser: boolean;
}

export interface GestureState {
  cx: number;
  cy: number;
  /** Escala relativa al inicio del gesto. */
  scale: number;
  /** Rotacion acumulada en radianes. */
  rotation: number;
  /** Desplazamiento del centro desde el inicio del gesto. */
  dx: number;
  dy: number;
  pointers: number;
}

export interface PointerHandlers {
  onStart?(s: InputSample, ev: PointerEvent): void;
  onMove?(samples: InputSample[], predicted: InputSample[], ev: PointerEvent): void;
  onEnd?(s: InputSample, ev: PointerEvent): void;
  onCancel?(): void;
  onHover?(s: InputSample | null): void;
  onGestureStart?(g: GestureState): void;
  onGestureMove?(g: GestureState): void;
  onGestureEnd?(): void;
  onWheel?(ev: WheelEvent, x: number, y: number): void;
}

export interface PointerConfig {
  /** Usa getPredictedEvents() para adelantar la punta del trazo. */
  prediction: boolean;
  /** Ignora el tactil mientras el lapiz esta en uso. */
  palmRejection: boolean;
  /** Area de contacto (px) por encima de la cual un toque se considera palma. */
  palmContactPx: number;
  /** Permite dibujar con el dedo cuando no hay lapiz presente. */
  touchDraw: boolean;
}

interface TrackedPointer {
  id: number;
  kind: PointerKind;
  x: number;
  y: number;
}

const DEFAULT_CONFIG: PointerConfig = {
  prediction: true,
  palmRejection: true,
  palmContactPx: 42,
  touchDraw: true,
};

/**
 * Capa de entrada de alta fidelidad.
 *
 * Decisiones que importan para que el lapiz responda de verdad:
 * - touch-action:none + setPointerCapture para que el navegador no robe el gesto.
 * - getCoalescedEvents() en cada pointermove: recupera TODAS las muestras del
 *   digitalizador (120-240 Hz) en vez de una sola por frame.
 * - getPredictedEvents() opcional: dibuja hacia donde va la punta y cancela
 *   latencia percibida; el tramo predicho nunca se consolida.
 * - Rechazo de palma por tipo de puntero y por area de contacto.
 * - Gestos de 2 dedos resueltos aqui, nunca confundidos con un trazo.
 */
export class PointerInput {
  readonly config: PointerConfig;

  private el: HTMLElement;
  private handlers: PointerHandlers;
  private rect: DOMRect;
  private active: number | null = null;
  private pointers = new Map<number, TrackedPointer>();
  private lastPenTime = 0;
  private gesture: {
    startDist: number;
    startCx: number;
    startCy: number;
    lastAngle: number;
    rotation: number;
  } | null = null;
  private disposers: Array<() => void> = [];
  /** Presion cruda maxima observada: calibra lapices que no llegan a 1.0. */
  private pressureCeiling = 0.62;
  private sawRealPressure = false;

  constructor(el: HTMLElement, handlers: PointerHandlers, config?: Partial<PointerConfig>) {
    this.el = el;
    this.handlers = handlers;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rect = el.getBoundingClientRect();
    el.style.touchAction = "none";
    el.style.userSelect = "none";
    this.attach();
  }

  refreshRect(): void {
    this.rect = this.el.getBoundingClientRect();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.pointers.clear();
  }

  private listen(
    target: HTMLElement | Window,
    type: string,
    fn: (ev: Event) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts);
    this.disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  private attach(): void {
    this.listen(this.el, "pointerdown", (e) => this.onDown(e as PointerEvent));
    this.listen(this.el, "pointermove", (e) => this.onMove(e as PointerEvent), { passive: false });
    this.listen(this.el, "pointerup", (e) => this.onUp(e as PointerEvent));
    this.listen(this.el, "pointercancel", (e) => this.onUp(e as PointerEvent, true));
    this.listen(this.el, "pointerleave", (e) => {
      if ((e as PointerEvent).pointerId !== this.active) this.handlers.onHover?.(null);
    });
    this.listen(this.el, "lostpointercapture", (e) => {
      const pe = e as PointerEvent;
      if (pe.pointerId === this.active) this.onUp(pe, true);
    });
    this.listen(
      this.el,
      "wheel",
      (e) => {
        const we = e as WheelEvent;
        we.preventDefault();
        const p = this.local(we.clientX, we.clientY);
        this.handlers.onWheel?.(we, p.x, p.y);
      },
      { passive: false },
    );
    this.listen(this.el, "contextmenu", (e) => e.preventDefault());
    this.listen(window, "resize", () => this.refreshRect());
    this.listen(window, "scroll", () => this.refreshRect(), { passive: true });
  }

  private local(clientX: number, clientY: number): { x: number; y: number } {
    return { x: clientX - this.rect.left, y: clientY - this.rect.top };
  }

  /** Convierte tiltX/tiltY (o altitude/azimuth cuando existen) a tilt+azimut. */
  private tiltOf(e: PointerEvent): { tilt: number; azimuth: number } {
    const anyE = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    if (typeof anyE.altitudeAngle === "number" && typeof anyE.azimuthAngle === "number") {
      return { tilt: Math.PI / 2 - anyE.altitudeAngle, azimuth: anyE.azimuthAngle };
    }
    const tx = ((e.tiltX || 0) * Math.PI) / 180;
    const ty = ((e.tiltY || 0) * Math.PI) / 180;
    if (tx === 0 && ty === 0) return { tilt: 0, azimuth: 0 };
    const tanX = Math.tan(tx);
    const tanY = Math.tan(ty);
    const tilt = Math.atan(Math.hypot(tanX, tanY));
    let azimuth = Math.atan2(tanY, tanX);
    if (azimuth < 0) azimuth += TAU;
    return { tilt, azimuth };
  }

  private normalizePressure(e: PointerEvent, kind: PointerKind): number {
    if (kind === "mouse") return -1;
    const raw = e.pressure;
    if (kind === "touch") {
      // Muchas pantallas devuelven 1.0 fijo: eso no es presion real.
      return raw > 0 && raw < 0.999 ? clamp01(raw) : -1;
    }
    if (raw <= 0.0001) return this.sawRealPressure ? 0 : -1;
    this.sawRealPressure = true;
    // Auto-calibracion: casi ningun lapiz llega a 1.0, el techo se adapta.
    if (raw > this.pressureCeiling) this.pressureCeiling += (raw - this.pressureCeiling) * 0.5;
    return clamp01(raw / Math.max(0.25, this.pressureCeiling));
  }

  private sample(e: PointerEvent, predicted = false): InputSample {
    const kind = (e.pointerType || "mouse") as PointerKind;
    const p = this.local(e.clientX, e.clientY);
    const { tilt, azimuth } = this.tiltOf(e);
    return {
      x: p.x,
      y: p.y,
      pressure: this.normalizePressure(e, kind),
      tilt,
      azimuth,
      twist: ((e.twist || 0) * Math.PI) / 180,
      contact: Math.max(e.width || 0, e.height || 0),
      t: e.timeStamp,
      kind,
      predicted,
      barrel: (e.buttons & 2) !== 0,
      eraser: e.button === 5 || (e.buttons & 32) !== 0,
    };
  }

  /** Palma o dedo espurio mientras se usa el lapiz. */
  private isRejected(e: PointerEvent): boolean {
    if (e.pointerType !== "touch") return false;
    if (!this.config.touchDraw) return true;
    if (!this.config.palmRejection) return false;
    if (performance.now() - this.lastPenTime < 1200) return true;
    const contact = Math.max(e.width || 0, e.height || 0);
    return contact > this.config.palmContactPx;
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === "pen") this.lastPenTime = performance.now();
    this.refreshRect();

    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      kind: (e.pointerType || "mouse") as PointerKind,
      x: e.clientX,
      y: e.clientY,
    });

    // Dos o mas dedos: gesto de navegacion, se cancela el trazo en curso.
    const touches = [...this.pointers.values()].filter((p) => p.kind === "touch");
    if (touches.length >= 2) {
      if (this.active !== null) {
        this.handlers.onCancel?.();
        this.releaseActive();
      }
      this.beginGesture(touches);
      return;
    }

    if (this.active !== null || this.isRejected(e)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    this.active = e.pointerId;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* el puntero ya se solto */
    }
    e.preventDefault();
    this.handlers.onStart?.(this.sample(e), e);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === "pen") this.lastPenTime = performance.now();
    const tracked = this.pointers.get(e.pointerId);
    if (tracked) {
      tracked.x = e.clientX;
      tracked.y = e.clientY;
    }

    if (this.gesture) {
      this.updateGesture();
      return;
    }

    if (this.active === null) {
      if (!this.isRejected(e)) this.handlers.onHover?.(this.sample(e));
      return;
    }
    if (e.pointerId !== this.active) return;
    e.preventDefault();

    const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const samples: InputSample[] =
      coalesced.length > 0 ? coalesced.map((c) => this.sample(c)) : [this.sample(e)];

    let predicted: InputSample[] = [];
    if (this.config.prediction && typeof e.getPredictedEvents === "function") {
      predicted = e.getPredictedEvents().map((c) => this.sample(c, true));
    }

    this.handlers.onMove?.(samples, predicted, e);
  }

  private onUp(e: PointerEvent, cancel = false): void {
    this.pointers.delete(e.pointerId);

    if (this.gesture) {
      const touches = [...this.pointers.values()].filter((p) => p.kind === "touch");
      if (touches.length < 2) {
        this.gesture = null;
        this.handlers.onGestureEnd?.();
      } else {
        this.beginGesture(touches);
      }
      return;
    }

    if (e.pointerId !== this.active) return;
    this.releaseActive();
    if (cancel) this.handlers.onCancel?.();
    else this.handlers.onEnd?.(this.sample(e), e);
  }

  private releaseActive(): void {
    if (this.active === null) return;
    try {
      this.el.releasePointerCapture(this.active);
    } catch {
      /* ya liberado */
    }
    this.active = null;
  }

  private beginGesture(touches: TrackedPointer[]): void {
    const [a, b] = touches;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const angle = Math.atan2(dy, dx);
    this.gesture = {
      startDist: Math.max(1, Math.hypot(dx, dy)),
      startCx: (a.x + b.x) / 2,
      startCy: (a.y + b.y) / 2,
      lastAngle: angle,
      rotation: 0,
    };
    const c = this.local(this.gesture.startCx, this.gesture.startCy);
    this.handlers.onGestureStart?.({
      cx: c.x,
      cy: c.y,
      scale: 1,
      rotation: 0,
      dx: 0,
      dy: 0,
      pointers: touches.length,
    });
  }

  private updateGesture(): void {
    const g = this.gesture;
    if (!g) return;
    const touches = [...this.pointers.values()].filter((p) => p.kind === "touch");
    if (touches.length < 2) return;
    const [a, b] = touches;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const angle = Math.atan2(dy, dx);
    let delta = angle - g.lastAngle;
    if (delta > Math.PI) delta -= TAU;
    if (delta < -Math.PI) delta += TAU;
    g.rotation += delta;
    g.lastAngle = angle;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const c = this.local(cx, cy);
    this.handlers.onGestureMove?.({
      cx: c.x,
      cy: c.y,
      scale: clamp(dist / g.startDist, 0.05, 40),
      rotation: g.rotation,
      dx: cx - g.startCx,
      dy: cy - g.startCy,
      pointers: touches.length,
    });
  }
}
