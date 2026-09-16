import { clamp01, damp, lerp, shapeCurve, smoothstep } from "../core/math";
import { Rng } from "../core/rng";
import { OneEuroVec2 } from "./filter";
import type { BrushSettings, StrokePoint } from "./types";

/** Muestra ya convertida a coordenadas de mundo por el editor. */
export interface WorldSample {
  x: number;
  y: number;
  pressure: number;
  tilt: number;
  azimuth: number;
  t: number;
  predicted: boolean;
}

/**
 * Convierte el flujo crudo del puntero en puntos de trazo con radio resuelto.
 *
 * El orden importa: primero se filtra la posicion (One-Euro), luego se mide la
 * velocidad sobre la posicion YA filtrada (si se midiera sobre la cruda, el ruido
 * del digitalizador se traduciria en parpadeo de grosor), y por ultimo se resuelve
 * el radio segun la dinamica activa.
 */
export class StrokeBuilder {
  settings: BrushSettings;

  private pts: StrokePoint[] = [];
  private tail: StrokePoint[] = [];
  private filter = new OneEuroVec2();
  private rng = new Rng();
  private zoom = 1;

  private penX = 0;
  private penY = 0;
  private lastT = 0;
  private lastX = 0;
  private lastY = 0;
  private speed = 0;
  private smoothPressure = 0;
  private arcLen = 0;
  private started = false;

  constructor(settings: BrushSettings) {
    this.settings = settings;
  }

  /** Puntos consolidados (sin el tramo predicho). */
  get points(): readonly StrokePoint[] {
    return this.pts;
  }

  /** Puntos consolidados + prediccion: solo para pintar el trazo humedo. */
  get preview(): StrokePoint[] {
    return this.tail.length ? this.pts.concat(this.tail) : this.pts;
  }

  get length(): number {
    return this.pts.length;
  }

  setZoom(z: number): void {
    this.zoom = z > 1e-6 ? z : 1;
  }

  begin(s: WorldSample, seed = (Math.random() * 0xffffffff) >>> 0): void {
    const st = this.settings;
    this.pts = [];
    this.tail = [];
    this.rng.reseed(seed);
    this.filter.reset();
    // smoothing 0..1 -> corte bajo (suave) o alto (directo).
    this.filter.configure(lerp(9, 0.7, clamp01(st.smoothing)), 0.02 + clamp01(st.smoothing) * 0.06);
    this.penX = s.x;
    this.penY = s.y;
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastT = s.t;
    this.speed = 0;
    this.arcLen = 0;
    this.smoothPressure = s.pressure >= 0 ? s.pressure : 0.5;
    this.started = true;
    this.pushPoint(s, true);
  }

  /**
   * Anade muestras reales al trazo. Devuelve true si la geometria cambio.
   *
   * `force` salta el filtro de distancia minima: se usa en la ultima muestra,
   * para que el trazo termine exactamente donde se levanto el lapiz.
   */
  push(samples: readonly WorldSample[], force = false): boolean {
    if (!this.started) return false;
    let changed = false;
    for (let i = 0; i < samples.length; i++) {
      const last = force && i === samples.length - 1;
      changed = this.pushPoint(samples[i], last) || changed;
    }
    if (changed) this.tail = [];
    return changed;
  }

  /**
   * Tramo predicho: se dibuja pero no se consolida. Es lo que hace que la punta
   * "alcance" al lapiz en pantalla sin ensuciar el trazo final.
   */
  setPredicted(samples: readonly WorldSample[]): void {
    this.tail = [];
    if (!this.started || samples.length === 0 || this.pts.length === 0) return;
    const last = this.pts[this.pts.length - 1];
    let px = last.x;
    let py = last.y;
    for (const s of samples) {
      const d = Math.hypot(s.x - px, s.y - py);
      if (d * this.zoom < 0.4) continue;
      px = s.x;
      py = s.y;
      this.tail.push({ x: s.x, y: s.y, r: last.r, p: last.p, v: last.v, a: last.a, t: s.t });
    }
  }

  cancel(): void {
    this.started = false;
    this.pts = [];
    this.tail = [];
  }

  /** Cierra el trazo, aplica el afilado final y devuelve los puntos definitivos. */
  finalize(): StrokePoint[] {
    this.started = false;
    this.tail = [];
    const out = this.pts;
    this.pts = [];
    applyTaper(out, this.settings);
    return out;
  }

  private pushPoint(s: WorldSample, force: boolean): boolean {
    const st = this.settings;
    const dtMs = Math.max(0.5, s.t - this.lastT);
    const dt = dtMs / 1000;

    // 1. Posicion filtrada + arrastre opcional.
    const f = this.filter.filter(s.x, s.y, dt);
    const drag = clamp01(st.streamline) * 0.85;
    this.penX = lerp(f.x, this.penX, drag);
    this.penY = lerp(f.y, this.penY, drag);
    const x = this.penX;
    const y = this.penY;

    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const dWorld = Math.hypot(dx, dy);
    const dScreen = dWorld * this.zoom;

    // 2. Velocidad en px de pantalla / ms, suavizada: independiente del zoom.
    const instant = dScreen / dtMs;
    this.speed = damp(this.speed, instant, 22, dt);
    this.lastT = s.t;

    if (!force && dScreen < 0.55) return false;

    this.lastX = x;
    this.lastY = y;
    this.arcLen += dWorld;

    // 3. Presion efectiva (con sustituto por velocidad si no hay tableta).
    const hasPressure = s.pressure >= 0;
    const rawPressure = hasPressure
      ? s.pressure
      : clamp01(1 - this.speed / Math.max(0.2, st.velocityScale * 1.5));
    const target = shapeCurve(rawPressure, st.pressureCurve);
    this.smoothPressure = damp(this.smoothPressure, target, hasPressure ? 45 : 16, dt);

    const { r, a } = this.resolveRadius(s, this.smoothPressure);

    this.pts.push({
      x,
      y,
      r,
      p: this.smoothPressure,
      v: this.speed,
      a,
      t: s.t,
    });
    return true;
  }

  private resolveRadius(s: WorldSample, pressure: number): { r: number; a: number } {
    const st = this.settings;
    const base = Math.max(0.05, st.size * 0.5);
    const min = base * clamp01(st.minRatio);
    const vn = clamp01(this.speed / Math.max(0.05, st.velocityScale));
    const velFactor = st.velocityInvert ? vn : 1 - vn;
    let r = base;
    let a = 0;

    switch (st.dynamics) {
      case "constant":
        r = base;
        break;
      case "pressure":
        r = lerp(min, base, pressure);
        break;
      case "velocity":
        r = lerp(min, base, smoothstep(velFactor));
        break;
      case "pressure-velocity":
        // La presion manda, la velocidad modula: es el comportamiento de un pincel real.
        r = lerp(min, base, pressure * lerp(0.55, 1, smoothstep(velFactor)));
        break;
      case "tilt": {
        // Punta de cincel: tumbar el lapiz ensancha, y el trazo sigue el azimut.
        const flat = clamp01(s.tilt / (Math.PI / 2.2));
        r = lerp(min, base, lerp(pressure, 1, 0.35)) * lerp(0.65, 1.55, flat);
        a = s.azimuth;
        break;
      }
    }

    if (st.jitter > 0) r *= 1 + this.rng.gauss() * st.jitter * 0.35;
    return { r: Math.max(0.03, r), a };
  }
}

/** Afilado de entrada/salida en funcion de la longitud de arco real del trazo. */
export function applyTaper(points: StrokePoint[], st: BrushSettings): void {
  const n = points.length;
  if (n < 2) return;
  if (st.taperIn <= 0 && st.taperOut <= 0) return;

  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = cum[n - 1];
  if (total <= 1e-6) return;

  const inLen = st.taperIn * total;
  const outLen = st.taperOut * total;
  for (let i = 0; i < n; i++) {
    let k = 1;
    if (inLen > 1e-6) k = Math.min(k, smoothstep(cum[i] / inLen));
    if (outLen > 1e-6) k = Math.min(k, smoothstep((total - cum[i]) / outLen));
    points[i].r *= lerp(0.06, 1, k);
  }
}
