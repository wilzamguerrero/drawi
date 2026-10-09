/**
 * Visor 3D: el modo de dibujo espacial.
 *
 * Es autonómo a proposito. El editor 2D tiene su propio bucle, sus herramientas y
 * su gestion de puntero; meter el 3D ahi dentro habria obligado a tocar todas las
 * herramientas. En su lugar, el visor pone su propio lienzo encima y **captura el
 * puntero antes de que llegue al editor**: los manejadores del 2D escuchan en fase
 * de burbuja sobre el anfitrion, asi que un `stopPropagation` en fase de captura
 * sobre el lienzo del visor basta para que el motor 2D no vea nada mientras el
 * modo 3D esta activo. Ni una herramienta tiene que saber que el 3D existe.
 *
 * Dos reglas de interaccion, y las dos importan:
 *
 *  - **Navegar nunca dibuja.** La orbita va con el boton central, el derecho o la
 *    barra espaciadora. El boton izquierdo y la punta del lapiz son siempre para
 *    pintar.
 *  - **Dibujar nunca mueve la camara.** Un gesto de trazo no toca el estado de la
 *    camara en absoluto.
 *
 * El trazo se dibuja sobre un **plano de profundidad fija** que mira a la camara.
 * Es la decision que hace que dibujar funcione sin configurar nada: el trazo
 * aparece justo bajo el cursor. El boceto libre en el aire, sin plano, es lo que
 * academicamente se sabe que falla -el usuario pierde la profundidad y no acierta
 * donde pinta-, asi que el plano es fijo y la profundidad se ajusta aparte.
 */

import { DEFAULT_BRUSH, type BrushSettings } from "../stroke/types";
import { Stroke3DBuilder } from "../scene3d/builder";
import { StrokeScene } from "../scene3d/batch";
import { radiusAt, type Sample3D, type Stroke3D } from "../scene3d/types";
import type { V3 } from "../scene3d/vec3";
import {
  CameraController3D,
  clampZoomFactor,
  rayToDepthPlane,
  snapDepth,
} from "../scene3d/controls3d";
import {
  DEFAULT_CAMERA_3D,
  forwardOf,
  projectPoint,
  viewProjection,
  type Camera3DState,
} from "../scene3d/camera3d";
import { Scene3DBackend } from "../render3d/backend";

/** Rejilla de profundidad, en unidades de mundo. */
const DEPTH_STEP = 25;

/** Radio de captura del borrador, en pixeles de pantalla. */
const ERASE_SLOP = 10;

export interface Viewport3DHost {
  /** Color activo del editor. */
  color(): string;
  /** Ajustes del pincel activo. */
  brush(): BrushSettings;
  /** Avisa de que el estado cambio (para refrescar la interfaz). */
  changed(): void;
}

export class Viewport3D {
  readonly canvas: HTMLCanvasElement;
  readonly scene = new StrokeScene();
  readonly camera: Camera3DState = { ...DEFAULT_CAMERA_3D };

  private readonly controls = new CameraController3D(this.camera);
  private readonly backend: Scene3DBackend;
  private readonly builder = new Stroke3DBuilder({ ...DEFAULT_BRUSH });
  private readonly api: Viewport3DHost;
  private readonly hud: HTMLDivElement;

  private live = false;
  private drawing: { stroke: boolean; planeNormal: V3 } | null = null;
  private depth = 0;
  private space = false;
  private dirty = true;
  private disposers: Array<() => void> = [];

  constructor(host: HTMLElement, api: Viewport3DHost) {
    this.api = api;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "layer layer-3d";
    host.appendChild(this.canvas);

    this.backend = new Scene3DBackend(this.canvas);

    this.hud = document.createElement("div");
    this.hud.className = "hud-3d";
    host.appendChild(this.hud);

    this.attach(host);
    this.setActive(false);
    this.updateHud();
  }

  get available(): boolean {
    return this.backend.available;
  }

  get error(): string | null {
    return this.backend.error;
  }

  get active(): boolean {
    return this.live;
  }

  /** Profundidad actual del plano de dibujo, en unidades de mundo. */
  get planeDepth(): number {
    return this.depth;
  }

  /**
   * Fondo del visor.
   *
   * Se toma del documento y no se fija en negro: la tinta por defecto del
   * editor es negra, y sobre un fondo oscuro el trazo seria invisible. Ademas,
   * entrar al espacio y encontrarse otro color hace que se sienta como haber
   * abierto otra aplicacion, que es justo lo que hay que evitar.
   */
  setBackground(css: string): void {
    this.canvas.style.background = css;
  }

  setActive(on: boolean): void {
    this.live = on && this.backend.available;
    this.canvas.style.display = this.live ? "" : "none";
    this.hud.style.display = this.live ? "" : "none";
    if (this.live) {
      this.controls.viewportHeight = this.canvas.clientHeight || 800;
      this.resetDepth();
      this.dirty = true;
      this.updateHud();
    } else {
      this.cancelStroke();
    }
  }

  resize(width: number, height: number, dpr: number): void {
    this.controls.viewportHeight = height;
    this.backend.resize(width, height, dpr);
    this.dirty = true;
  }

  /** Encaja la vista en todo lo dibujado. */
  frameAll(): void {
    this.backend.sync(this.scene.all, () => 1);
    const b = this.backend.bounds();
    if (!b) {
      this.camera.px = 0;
      this.camera.py = 0;
      this.camera.pz = 0;
      this.camera.distance = 900;
    } else {
      this.camera.px = b.cx;
      this.camera.py = b.cy;
      this.camera.pz = b.cz;
      this.camera.distance = Math.max(50, b.radius / Math.tan(this.camera.fovY * 0.5));
    }
    this.resetDepth();
    this.dirty = true;
    this.updateHud();
  }

  /** Devuelve el estado de dibujado al plano por defecto, delante del punto de mira. */
  resetDepth(): void {
    this.depth = 0;
  }

  adjustDepth(steps: number): void {
    this.depth = snapDepth(this.depth + steps * DEPTH_STEP, DEPTH_STEP);
    this.updateHud();
  }

  /** Un fotograma. Solo dibuja si algo cambio o si se esta trazando. */
  frame(): void {
    if (!this.live || !this.backend.available) return;
    this.backend.sync(this.scene.all, () => 1);
    if (!this.dirty && !this.drawing) return;
    this.backend.render(this.camera);
    this.dirty = false;
  }

  stats(): { drawCalls: number; instances: number; bytes: number; strokes: number } {
    const s = this.backend.stats();
    // Solo los rangos vivos: borrar marca el rango como inactivo y deja su hueco
    // en el buffer, asi que contar `ranges.length` daria por buenos trazos que ya
    // no se dibujan.
    let strokes = 0;
    for (const b of this.scene.all) {
      for (const r of b.ranges) if (r.active) strokes++;
    }
    return { ...s, strokes };
  }

  /** Borra todo lo dibujado en el espacio. */
  clear(): void {
    for (const batch of this.scene.all) {
      for (const r of [...batch.ranges]) this.scene.forget(r.strokeId);
    }
    this.scene.prune();
    this.dirty = true;
    this.updateHud();
    this.api.changed();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.backend.dispose();
    this.canvas.remove();
    this.hud.remove();
  }

  // ------------------------------------------------------------- entrada

  /**
   * Los manejadores van en fase de captura y cortan la propagacion.
   *
   * Es lo que hace que el editor 2D no vea ni un evento mientras el visor esta
   * activo, sin que haya que desactivar sus propias escuchas ni que el 2D sepa
   * que existe un modo 3D.
   */
  private attach(host: HTMLElement): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts: AddEventListenerOptions = { capture: true },
    ): void => {
      const handler = (e: Event): void => {
        if (!this.live) return;
        e.stopPropagation();
        fn(e as HTMLElementEventMap[K]);
      };
      this.canvas.addEventListener(type, handler, opts);
      this.disposers.push(() => this.canvas.removeEventListener(type, handler, opts));
    };

    on("pointerdown", (e) => this.onDown(e));
    on("pointermove", (e) => this.onMove(e), { capture: true, passive: false });
    on("pointerup", (e) => this.onUp(e));
    on("pointercancel", () => this.cancelStroke());
    on("wheel", (e) => this.onWheel(e), { capture: true, passive: false });
    on("contextmenu", (e) => e.preventDefault());

    // El espacio se escucha en la ventana pero solo se atiende en modo 3D; el
    // editor 2D tambien lo mira, asi que se corta la propagacion solo mientras
    // el visor esta activo.
    const keyDown = (e: KeyboardEvent): void => {
      if (!this.live) return;
      if (e.code === "Space") {
        this.space = true;
        e.stopPropagation();
        e.preventDefault();
        this.updateHud();
      } else if (e.code === "BracketLeft") {
        this.adjustDepth(1);
      } else if (e.code === "BracketRight") {
        this.adjustDepth(-1);
      } else if (e.code === "KeyF") {
        this.frameAll();
      }
    };
    const keyUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") {
        this.space = false;
        if (this.live) {
          e.stopPropagation();
          this.updateHud();
        }
      }
    };
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp, true);
    this.disposers.push(() => window.removeEventListener("keydown", keyDown, true));
    this.disposers.push(() => window.removeEventListener("keyup", keyUp, true));

    void host;
  }

  private mods(e: {
    shiftKey: boolean;
    altKey: boolean;
    pointerType?: string;
  }): { shift: boolean; alt: boolean; space: boolean; pen: boolean } {
    return {
      shift: e.shiftKey,
      alt: e.altKey,
      space: this.space,
      pen: e.pointerType === "pen",
    };
  }

  private onDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    const r = this.rect();

    if (this.controls.begin(e.button, this.mods(e), e.clientX - r.left, e.clientY - r.top)) {
      e.preventDefault();
      this.updateHud();
      return;
    }

    // El borrador del lapiz llega como boton 5; Alt hace lo mismo con cualquier
    // puntero. Se mira ANTES de descartar los botones que no son el izquierdo.
    if (e.button === 5 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      this.eraseAt(e);
      return;
    }

    if (e.button !== 0) return;
    e.preventDefault();
    this.beginStroke(e);
  }

  private onMove(e: PointerEvent): void {
    if (this.controls.navigating) {
      const r = this.rect();
      this.controls.move(e.clientX - r.left, e.clientY - r.top, this.mods(e));
      this.dirty = true;
      return;
    }
    if (!this.drawing) return;
    e.preventDefault();
    this.pushStroke(e);
  }

  private onUp(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.controls.navigating) {
      this.controls.end();
      this.updateHud();
      return;
    }
    this.endStroke();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.rect();
    const ndcX = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
    const factor = clampZoomFactor(Math.exp(-e.deltaY * 0.0018));
    this.controls.zoomAt(factor, ndcX, ndcY, r.width / Math.max(1, r.height));
    this.dirty = true;
    this.updateHud();
  }

  // ---------------------------------------------------------------- trazo

  private beginStroke(e: PointerEvent): void {
    const p = this.worldPoint(e);
    if (!p) return;

    const brush = this.api.brush();
    this.builder.settings = brush;
    this.builder.setZoom(1);
    const planeNormal = forwardOf(this.camera, { x: 0, y: 0, z: 0 });
    this.drawing = { stroke: true, planeNormal };

    const sample = this.sampleOf(e, p);
    this.builder.begin(
      sample,
      {
        brush: brush.mode === "erase" ? "ribbon" : brush.mode,
        color: this.api.color(),
        layerId: "scene3d",
        planeNormal,
      },
    );
    this.dirty = true;
  }

  private pushStroke(e: PointerEvent): void {
    const p = this.worldPoint(e);
    if (!p) return;
    const samples: Sample3D[] = [];
    // El navegador puede entregar varios eventos coalescidos: usarlos todos es lo
    // que hace que un trazo rapido no salga a saltos.
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of events.length > 0 ? events : [e]) {
      const q = this.worldPoint(ev as PointerEvent);
      if (!q) continue;
      samples.push(this.sampleOf(ev as PointerEvent, q));
    }
    if (samples.length === 0) return;
    this.builder.push(samples);
    this.dirty = true;
  }

  private endStroke(): void {
    if (!this.drawing) return;
    this.drawing = null;
    const stroke = this.builder.finalize();
    this.builder.cancel();
    if (stroke) {
      this.scene.add(stroke);
      this.dirty = true;
      this.updateHud();
      this.api.changed();
    }
  }

  private cancelStroke(): void {
    this.drawing = null;
    this.builder.cancel();
    this.controls.end();
  }

  /**
   * Quita el trazo mas cercano bajo el cursor.
   *
   * Se prueba el rayo contra las esferas envolventes, no contra la geometria: es
   * lo que hace que borrar cueste lo mismo con mil trazos que con uno, y el
   * margen de `ERASE_SLOP` compensa que la esfera sea mas generosa que la cinta.
   */
  private eraseAt(e: PointerEvent): void {
    const r = this.rect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const ndcX = ((e.clientX - r.left) / w) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / h) * 2 - 1);
    // El margen tambien en NDC: asi el area de captura es la misma en pixeles
    // este donde este la camara.
    const slopNdc = (ERASE_SLOP / h) * 2;

    const vp = viewProjection(this.camera, w / h);
    let bestId: string | null = null;
    let bestDist = Infinity;

    for (const batch of this.scene.all) {
      for (const range of batch.ranges) {
        if (!range.active) continue;
        const p = projectPoint(vp, range.cx, range.cy, range.cz);
        if (p.w <= 0) continue;
        // Radio de la esfera en NDC: a profundidad w, el semialto visible es
        // w * tan(fovY/2), y NDC va de -1 a 1.
        const rNdc = range.radius / p.w / Math.tan(this.camera.fovY * 0.5);
        const d = Math.hypot(p.x - ndcX, p.y - ndcY);
        if (d <= rNdc + slopNdc && d < bestDist) {
          bestDist = d;
          bestId = range.strokeId;
        }
      }
    }

    if (bestId) {
      this.scene.remove(bestId);
      this.dirty = true;
      this.updateHud();
      this.api.changed();
    }
  }

  /** Punto de mundo del plano de dibujo bajo el puntero. */
  private worldPoint(e: PointerEvent): V3 | null {
    const r = this.rect();
    if (r.width <= 0 || r.height <= 0) return null;
    const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / r.height) * 2 - 1);
    return rayToDepthPlane(
      this.camera,
      ndcX,
      ndcY,
      r.width / r.height,
      this.depth,
      { x: 0, y: 0, z: 0 },
    );
  }

  private sampleOf(e: PointerEvent, p: V3): Sample3D {
    const tiltX = ((e.tiltX ?? 0) * Math.PI) / 180;
    const tiltY = ((e.tiltY ?? 0) * Math.PI) / 180;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      // El raton reporta 0.5 constante; -1 marca "no hay presion real" y el
      // constructor la sustituye por la velocidad, igual que en el lienzo 2D.
      pressure: e.pointerType === "mouse" ? -1 : e.pressure,
      tilt: Math.hypot(tiltX, tiltY),
      azimuth: Math.atan2(tiltY, tiltX),
      t: e.timeStamp,
      predicted: false,
    };
  }

  private rect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  private updateHud(): void {
    const s = this.stats();
    const depth = this.depth === 0 ? "auto" : `${this.depth}`;
    this.hud.textContent =
      `3D · ${s.strokes} trazos · ${s.drawCalls} lotes · ${s.instances} instancias · ` +
      `plano ${depth}` +
      (this.depth === 0 ? " (centro de la vista)" : "") +
      (this.controls.navigating ? " · moviendo la vista" : "");
  }
}

/** Radio del trazo en su punto medio, para pruebas y depuracion. */
export const midRadius = (stroke: Stroke3D): number =>
  radiusAt(stroke.data, Math.floor(stroke.count / 2));
