/**
 * Constructor de trazos 3D.
 *
 * Es el gemelo de `stroke/builder.ts` y comparte con el todo lo que se puede
 * compartir: el filtro One-Euro, el arrastre tipo lazo, la velocidad suavizada y
 * -lo importante- la resolucion del radio, que vive en `stroke/dynamics.ts` y es
 * la misma funcion para los dos espacios. Un pincel no cambia de comportamiento
 * por pasar a 3D.
 *
 * Lo que cambia es el orden de cierre, y conviene tenerlo presente:
 *
 *   1. Captura    -> puntos a resolucion completa, con radio ya resuelto.
 *   2. Decimacion -> Douglas-Peucker con error de posicion y de radio.
 *   3. Marcos     -> recorrido secuencial, una vez, para orientar la cinta.
 *   4. Afilado    -> sobre la longitud de arco de los puntos ya decimados.
 *
 * Decimar ANTES de los marcos es deliberado: asi el marco se calcula sobre la
 * forma final y no sobre el ruido que se acaba de tirar.
 */

import { clamp01, damp, lerp, shapeCurve, smoothstep } from "../core/math";
import { Rng, uid } from "../core/rng";
import { resolveRadius, taperFactor } from "../stroke/dynamics";
import { OneEuroVec3 } from "../stroke/filter";
import type { BrushSettings } from "../stroke/types";
import { computeFrames } from "./frames";
import { simplifyStroke, type SimplifyOptions } from "./simplify";
import {
  EMPTY_BOUNDS3,
  boundsOf,
  POINT_FLOATS,
  POS_OFFSET,
  PRESSURE_OFFSET,
  RADIUS_OFFSET,
  TIME_OFFSET,
  type Sample3D,
  type Stroke3D,
  type Stroke3DOptions,
} from "./types";

/** Puntos reservados de entrada, antes de crecer. */
const RESERVE = 256;

/**
 * Identidad del trazo provisional de la vista previa.
 *
 * Es un centinela a proposito: el trazo en curso no pertenece a la escena y no
 * debe entrar nunca en un lote. Solo lo consume la cinta provisional del visor,
 * que lo dibuja aparte.
 */
export const LIVE_STROKE_ID = "\u0000live";

export class Stroke3DBuilder {
  settings: BrushSettings;
  /** Ajustes de decimacion; se pueden afinar por familia de pincel. */
  simplify: Partial<SimplifyOptions> = {};

  private buf: Float32Array = new Float32Array(RESERVE * POINT_FLOATS);
  private n = 0;
  private filter = new OneEuroVec3();
  private rng = new Rng();
  private zoom = 1;
  private opts: Stroke3DOptions | null = null;
  private seed = 0;

  private penX = 0;
  private penY = 0;
  private penZ = 0;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private lastRawX = 0;
  private lastRawY = 0;
  private lastRawZ = 0;
  private lastT = 0;
  private firstT = 0;
  private speed = 0;
  private smoothPressure = 0;
  private arcLen = 0;
  private started = false;
  /** Radio del ultimo punto aceptado. Gobierna el muestreo minimo. */
  private lastR = 0;

  /** Buffer y objeto reutilizados por `preview`: cero asignaciones por muestra. */
  private liveBuf: Float32Array = new Float32Array(RESERVE * POINT_FLOATS);
  private readonly live: Stroke3D = {
    id: LIVE_STROKE_ID,
    brush: "",
    color: "#ffffff",
    layerId: "",
    data: this.liveBuf,
    count: 0,
    bounds: { ...EMPTY_BOUNDS3 },
    seed: 0,
    planeNormal: null,
  };

  constructor(settings: BrushSettings) {
    this.settings = settings;
  }

  get length(): number {
    return this.n;
  }

  setZoom(z: number): void {
    this.zoom = z > 1e-6 ? z : 1;
  }

  begin(s: Sample3D, options: Stroke3DOptions, seed = (Math.random() * 0xffffffff) >>> 0): void {
    const st = this.settings;
    this.n = 0;
    this.opts = options;
    this.seed = seed;
    this.rng.reseed(seed);
    this.filter.reset();

    // Mismos parametros que el trazo 2D: la sensacion de dibujo no debe cambiar
    // por entrar al espacio. El porque de los numeros esta en `stroke/builder.ts`.
    const sm = clamp01(st.smoothing);
    this.filter.configure(lerp(12, 1.2, sm), 0.045 + sm * 0.11);

    this.penX = s.x;
    this.penY = s.y;
    this.penZ = s.z;
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastZ = s.z;
    this.lastRawX = s.x;
    this.lastRawY = s.y;
    this.lastRawZ = s.z;
    this.lastT = s.t;
    this.firstT = s.t;
    this.speed = 0;
    this.arcLen = 0;
    this.smoothPressure = s.pressure >= 0 ? s.pressure : 0.5;
    this.started = true;
    this.pushPoint(s, true);
  }

  /** Anade muestras reales. Devuelve true si la geometria cambio. */
  push(samples: readonly Sample3D[], force = false): boolean {
    if (!this.started) return false;
    let changed = false;
    for (let i = 0; i < samples.length; i++) {
      const last = force && i === samples.length - 1;
      changed = this.pushPoint(samples[i], last) || changed;
    }
    return changed;
  }

  cancel(): void {
    this.started = false;
    this.n = 0;
    this.opts = null;
  }

  /**
   * Cierra el trazo: decima, orienta la cinta, afila y devuelve el resultado.
   *
   * Devuelve `null` si el gesto no dejo nada que guardar.
   */
  finalize(): Stroke3D | null {
    this.started = false;
    const opts = this.opts;
    this.opts = null;
    if (!opts || this.n < 1) return null;

    const raw = this.buf.slice(0, this.n * POINT_FLOATS);
    const simplified = simplifyStroke(raw, this.n, this.simplify);
    const data = simplified.data;
    const count = simplified.count;

    computeFrames(data, count, opts.planeNormal ?? null);
    applyTaper3(data, count, this.settings);

    this.n = 0;
    return {
      id: uid(),
      brush: opts.brush,
      color: opts.color,
      layerId: opts.layerId,
      data,
      count,
      bounds: boundsOf(data, count),
      seed: this.seed,
      planeNormal: opts.planeNormal ? { ...opts.planeNormal } : null,
    };
  }

  /**
   * Trazo provisional con lo dibujado hasta ahora, para poder verlo mientras se
   * dibuja.
   *
   * Dos decisiones que importan:
   *
   *  - **No decima.** La tolerancia de decimacion (0.35 unidades de mundo) es
   *    subpixel a la escala de trabajo, asi que la forma apenas cambia al soltar,
   *    y correr Douglas-Peucker entero en cada muestra seria justo el trabajo que
   *    se quiere evitar mientras se dibuja.
   *  - **Anade la punta cruda.** El muestreo minimo hace que el ultimo punto
   *    guardado vaya por detras del cursor; sin esta cola el trazo se veria
   *    retrasado respecto al lapiz, que es la sensacion que se quiere quitar.
   *
   * El objeto devuelto es **compartido y se reescribe en cada llamada**: vale
   * para consumirlo en el acto -que es lo que hace el visor al rellenar la cinta
   * provisional- y no para guardarlo.
   */
  preview(tail: Sample3D | null): Stroke3D | null {
    const opts = this.opts;
    if (!opts || !this.started) return null;
    const count = this.n + (tail ? 1 : 0);
    if (count < 2) return null;

    if (this.liveBuf.length < count * POINT_FLOATS) {
      let cap = this.liveBuf.length;
      while (cap < count * POINT_FLOATS) cap *= 2;
      this.liveBuf = new Float32Array(cap);
    }
    const dst = this.liveBuf;
    dst.set(this.buf.subarray(0, this.n * POINT_FLOATS));

    if (tail) {
      const o = this.n * POINT_FLOATS;
      dst[o + POS_OFFSET] = tail.x;
      dst[o + POS_OFFSET + 1] = tail.y;
      dst[o + POS_OFFSET + 2] = tail.z;
      // La punta hereda el radio del ultimo punto en vez de resolverlo otra vez:
      // resolverlo aqui avanzaria el generador de ruido del pincel y el trazo
      // final saldria distinto segun lo deprisa que se hubiera movido el raton.
      dst[o + RADIUS_OFFSET] = this.lastR;
      dst[o + PRESSURE_OFFSET] = this.smoothPressure;
      dst[o + TIME_OFFSET] = tail.t - this.firstT;
    }

    computeFrames(dst, count, opts.planeNormal ?? null);
    applyTaper3(dst, count, this.settings);

    const live = this.live;
    live.brush = opts.brush;
    live.color = opts.color;
    live.layerId = opts.layerId;
    live.data = dst;
    live.count = count;
    live.bounds = boundsOf(dst, count);
    live.seed = this.seed;
    live.planeNormal = opts.planeNormal ?? null;
    return live;
  }

  private pushPoint(s: Sample3D, force: boolean): boolean {
    const st = this.settings;
    const dtMs = Math.max(0.5, s.t - this.lastT);
    const dt = dtMs / 1000;

    const f = this.filter.filter(s.x, s.y, s.z, dt);

    // Velocidad sobre el salto crudo del digitalizador, no sobre la posicion ya
    // arrastrada: si se midiera sobre ella se realimentaria y oscilaria.
    const rawStep =
      Math.hypot(s.x - this.lastRawX, s.y - this.lastRawY, s.z - this.lastRawZ) * this.zoom;
    const instant = rawStep / dtMs;
    this.speed = damp(this.speed, instant, 22, dt);
    this.lastRawX = s.x;
    this.lastRawY = s.y;
    this.lastRawZ = s.z;

    const release = clamp01(this.speed / 1.1);
    const startup = smoothstep(clamp01((this.arcLen * this.zoom) / 14));
    const drag = clamp01(st.streamline) * 0.8 * (1 - 0.6 * release) * startup;
    this.penX = lerp(f.x, this.penX, drag);
    this.penY = lerp(f.y, this.penY, drag);
    this.penZ = lerp(f.z, this.penZ, drag);

    const dx = this.penX - this.lastX;
    const dy = this.penY - this.lastY;
    const dz = this.penZ - this.lastZ;
    const dWorld = Math.hypot(dx, dy, dz);
    this.lastT = s.t;

    // Muestreo minimo, con dos umbrales y gana el mas exigente.
    //
    // El primero es el de siempre, en pixeles de pantalla: por debajo de medio
    // pixel la muestra no aporta nada. El segundo es nuevo y es relativo al
    // radio: dos puntos mas juntos que medio radio dejan segmentos mucho mas
    // cortos que el ancho del trazo, y como las juntas se prolongan hasta un
    // radio, todos los segmentos acabarian conteniendose unos a otros. Ademas de
    // desperdicio, eso emborrona los codos.
    const minStep = Math.max(0.55 / this.zoom, 0.5 * this.lastR);
    if (!force && dWorld < minStep) return false;

    this.lastX = this.penX;
    this.lastY = this.penY;
    this.lastZ = this.penZ;
    this.arcLen += dWorld;

    // Presion efectiva, con sustituto por velocidad cuando no hay tableta.
    const hasPressure = s.pressure >= 0;
    const rawPressure = hasPressure
      ? s.pressure
      : clamp01(1 - this.speed / Math.max(0.2, st.velocityScale * 1.5));
    const target = shapeCurve(rawPressure, st.pressureCurve);
    this.smoothPressure = damp(this.smoothPressure, target, hasPressure ? 45 : 16, dt);

    const { r } = resolveRadius(st, this.smoothPressure, this.speed, s.tilt, s.azimuth, this.rng);

    this.grow(this.n + 1);
    const o = this.n * POINT_FLOATS;
    this.buf[o + POS_OFFSET] = this.penX;
    this.buf[o + POS_OFFSET + 1] = this.penY;
    this.buf[o + POS_OFFSET + 2] = this.penZ;
    // La normal la escribe `computeFrames` al cerrar: hasta entonces no se puede
    // saber, porque depende de los puntos que vengan despues.
    this.buf[o + RADIUS_OFFSET] = r;
    this.buf[o + PRESSURE_OFFSET] = this.smoothPressure;
    this.buf[o + TIME_OFFSET] = s.t - this.firstT;
    this.lastR = r;
    this.n++;
    return true;
  }

  private grow(points: number): void {
    if (points * POINT_FLOATS <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < points * POINT_FLOATS) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf.subarray(0, this.n * POINT_FLOATS));
    this.buf = next;
  }
}

/**
 * Afilado de entrada y salida sobre la longitud de arco real.
 *
 * Se recalcula aqui la longitud de arco en vez de reutilizar la del constructor
 * porque la decimacion cambio los puntos: la que importa es la de la forma que
 * se guarda, no la del gesto crudo.
 */
export const applyTaper3 = (data: Float32Array, count: number, st: BrushSettings): void => {
  if (count < 2) return;
  if (st.taperIn <= 0 && st.taperOut <= 0) return;

  const cum = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const a = (i - 1) * POINT_FLOATS + POS_OFFSET;
    const b = i * POINT_FLOATS + POS_OFFSET;
    cum[i] =
      cum[i - 1] +
      Math.hypot(data[b] - data[a], data[b + 1] - data[a + 1], data[b + 2] - data[a + 2]);
  }
  const total = cum[count - 1];
  if (total <= 1e-6) return;

  for (let i = 0; i < count; i++) {
    const o = i * POINT_FLOATS + RADIUS_OFFSET;
    data[o] *= taperFactor(cum[i], total, st.taperIn, st.taperOut);
  }
};
