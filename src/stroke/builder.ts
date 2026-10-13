import { clamp01, damp, lerp, shapeCurve } from "../core/math";
import { Rng } from "../core/rng";
import { resolveRadius, taperFactor } from "./dynamics";
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
  // Ultima posicion CRUDA (sin filtrar): base de la velocidad, para que no
  // dependa del propio arrastre (si no, se realimenta y oscila).
  private lastRawX = 0;
  private lastRawY = 0;
  private speed = 0;
  private smoothPressure = 0;
  private arcLen = 0;
  private started = false;
  /** Radio del ultimo punto aceptado. Gobierna el muestreo minimo. */
  private lastR = 0;
  // Rumbo (direccion unitaria) suavizado del trazo. La prediccion se sintetiza
  // a partir de aqui, nunca de los puntos crudos del navegador: por eso la punta
  // no puede temblar ni "saltar" cuando cambia la presion o el boton del lapiz.
  private headX = 0;
  private headY = 0;
  private hasHeading = false;

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

  /** Slack de la cuerda en mundo (para guía). */
  getStringSlack(): number { return this.stringLen * 90 / this.zoom; }
  /** Tensión de la cuerda 0..1 (solo pulled-string). */
  getStringTension(): number {
    if (this.mode !== "pulled-string" || !this.started) return 0;
    const slack = this.getStringSlack();
    const dx = this.lastRawX - this.psX, dy = this.lastRawY - this.psY;
    return Math.min(1, Math.hypot(dx, dy) / Math.max(0.5 / this.zoom, slack));
  }
  /** Cuerda del estabilizador: como LZ July 19, cuerda de LARGO fijo colgando. */
  getStabilizeString(): { anchor: import("../core/vec2").Vec2; tip: import("../core/vec2").Vec2; cursor: import("../core/vec2").Vec2; slack: number; tension: number } | null {
    if (!this.started) return null;
    const slack = this.getStringSlack();
    if (this.mode === "pulled-string" && slack < 1 / this.zoom) return null;
    if (this.mode !== "pulled-string" && slack < 1 / this.zoom && this.amt < 0.08) return null;
    const anchor = { x: this.lastRawX, y: this.lastRawY };
    // En pulled-string la punta es psX/psY (donde está la brocha), no el último punto consolidado
    const tip = this.mode === "pulled-string"
      ? { x: this.psX, y: this.psY }
      : (this.pts[this.pts.length - 1] ? { x: this.pts[this.pts.length - 1].x, y: this.pts[this.pts.length - 1].y } : { x: this.penX, y: this.penY });
    const d = Math.hypot(tip.x - anchor.x, tip.y - anchor.y);
    // En pulled-string la cuerda siempre se ve colgando aunque d sea 0 (largo fijo)
    if (this.mode !== "pulled-string" && d < 1.2 / this.zoom) return null;
    const tension = this.mode === "pulled-string" ? Math.min(1, d / Math.max(0.5 / this.zoom, slack)) : Math.min(1, d / Math.max(12 / this.zoom, slack * 0.6));
    return { anchor, tip, cursor: anchor, slack, tension };
  }

  setZoom(z: number): void {
    this.zoom = z > 1e-6 ? z : 1;
  }

  // Lazy Nezumi-style smoothing state
  private mode: import("./types").SmoothMode = "pulled-string";
  private amt = 0.35;
  private catchUp = false;
  private stringLen = 0.35;
  private psX = 0; private psY = 0; // pulled string anchor
  private maQ: { x: number; y: number }[] = [];
  private emaX = 0; private emaY = 0;
  private velX = 0; private velY = 0;

  begin(s: WorldSample, seed = (Math.random() * 0xffffffff) >>> 0): void {
    const st = this.settings;
    this.pts = [];
    this.tail = [];
    this.rng.reseed(seed);
    this.filter.reset();
    this.mode = (st.smoothMode ?? "pulled-string") as import("./types").SmoothMode;
    this.amt = clamp01(st.smoothAmount ?? st.smoothing ?? 0.35);
    this.catchUp = !!st.smoothCatchUp;
    this.stringLen = clamp01((st as unknown as { stringLength?: number }).stringLength ?? st.smoothAmount ?? 0.35);
    // One-Euro now only lightly removes sensor jitter (fixed low smoothing).
    // The artistic smoothing is handled by the mode/amount above (LZ-style).
    const hasPen = s.pressure >= 0 || s.tilt !== 0;
    const jSm = hasPen ? 0.18 : 0.12;
    this.filter.configure(lerp(20, 6, jSm), 0.06 + jSm * 0.08);
    // Init mode state at s
    this.psX = s.x; this.psY = s.y;
    this.maQ = [{ x: s.x, y: s.y }];
    this.emaX = s.x; this.emaY = s.y;
    this.velX = 0; this.velY = 0;
    this.penX = s.x;
    this.penY = s.y;
    this.lastX = s.x;
    this.lastY = s.y;
    this.lastRawX = s.x;
    this.lastRawY = s.y;
    this.lastT = s.t;
    this.speed = 0;
    this.arcLen = 0;
    this.headX = 0;
    this.headY = 0;
    this.hasHeading = false;
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
   * Tramo predicho (la "punta que alcanza al lapiz"). NO se consolida.
   *
   * Clave de la fluidez sin temblor: no se pintan los puntos crudos de
   * `getPredictedEvents()` (que saltan y se reemiten cuando cambia la presion o
   * el boton del lapiz -> esa era la punta que "se movia"). En su lugar se
   * SINTETIZA un arco corto y suave desde el ultimo punto consolidado usando el
   * rumbo ya suavizado del trazo, inclinandolo apenas hacia donde esta de verdad
   * el cursor. Al derivarse de valores estables, es imposible que tiemble.
   */
  setPredicted(samples: readonly WorldSample[]): void {
    this.tail = [];
    if (!this.started || samples.length === 0 || this.pts.length === 0) return;
    if (!this.hasHeading) return;

    // A mano casi quieta la prediccion es ruido puro.
    if (this.speed < 0.07) return;

    const last = this.pts[this.pts.length - 1];
    const target = samples[samples.length - 1]; // posicion real actual del lapiz
    const tx = target.x - last.x;
    const ty = target.y - last.y;
    const toTarget = Math.hypot(tx, ty);

    // Longitud a proyectar (px de mundo): limitada por la velocidad real y por
    // lo lejos que esta el cursor, con un techo duro para no adelantarse de mas.
    const capScreen = Math.min(30, this.speed * 36);
    const cap = capScreen / this.zoom;
    const reach = Math.min(cap, Math.max(toTarget, cap * 0.4));
    if (reach < 0.5 / this.zoom) return;
    // Rechaza predicción si el rumbo y el vector a target forman >90°:
    // en un cruce la predicción mira al otro lado y sale una "punta" opuesta.
    if (toTarget > 2 / this.zoom) {
      const dot = this.headX * (tx / toTarget) + this.headY * (ty / toTarget);
      if (dot < 0.1) return;
    }

    // Punto de destino sobre el rumbo, llevado un poco hacia el cursor real para
    // matar latencia sin copiar su ruido (90% rumbo / 10% cursor).
    const aimX = last.x + this.headX * reach;
    const aimY = last.y + this.headY * reach;
    const tnx = toTarget > 1e-4 ? tx / toTarget : this.headX;
    const tny = toTarget > 1e-4 ? ty / toTarget : this.headY;
    const endX = lerp(aimX, last.x + tnx * reach, 0.1);
    const endY = lerp(aimY, last.y + tny * reach, 0.1);
    // Control de la curva: sobre el rumbo, para que el arco salga tangente al
    // trazo (sin esquina en la union) y gire suave.
    const ctrlX = last.x + this.headX * reach * 0.5;
    const ctrlY = last.y + this.headY * reach * 0.5;

    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const iu = 1 - u;
      // Bezier cuadratica last -> ctrl -> end.
      const bx = iu * iu * last.x + 2 * iu * u * ctrlX + u * u * endX;
      const by = iu * iu * last.y + 2 * iu * u * ctrlY + u * u * endY;
      // Afilado hacia la punta: radio pleno en la base, ~50% al final.
      const r = last.r * lerp(1, 0.5, u);
      this.tail.push({ x: bx, y: by, r, p: last.p, v: last.v, a: last.a, t: target.t });
    }
  }

  cancel(): void {
    this.started = false;
    this.pts = [];
    this.tail = [];
  }

  /** Cierra el trazo, aplica el afilado final y devuelve los puntos definitivos. */
  finalize(): StrokePoint[] {
    // Catch Up: interpola los puntos medios hacia el cursor real solo en el tramo final
    if (this.catchUp && (this.mode === "moving-average" || this.mode === "ema") && this.pts.length >= 2) {
      const raw = { x: this.lastRawX, y: this.lastRawY };
      const last = this.pts[this.pts.length - 1];
      const need = Math.hypot(raw.x - last.x, raw.y - last.y) * this.zoom;
      if (need > 2) {
        const extra = Math.min(6, Math.ceil(need / 4));
        for (let i = 1; i <= extra; i++) {
          const t = i / extra;
          const x = lerp(last.x, raw.x, t * 0.85);
          const y = lerp(last.y, raw.y, t * 0.85);
          this.pts.push({ x, y, r: last.r * lerp(1, 0.7, t), p: last.p, v: last.v, a: last.a, t: last.t });
        }
      }
    }
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

    // 1. Filtro One-Euro ligero de la posicion cruda (solo jitter del sensor).
    const f = this.filter.filter(s.x, s.y, dt);

    // 2. Velocidad SUAVIZADA, medida sobre el salto crudo del digitalizador.
    const hasPenV = s.pressure >= 0 || s.tilt !== 0;
    const rawStep = Math.hypot(s.x - this.lastRawX, s.y - this.lastRawY) * this.zoom;
    const instant = rawStep / dtMs;
    this.speed = damp(this.speed, instant, hasPenV ? 26 : 32, dt);
    this.lastRawX = s.x;
    this.lastRawY = s.y;

    // 3. Lazy Nezumi-style smoothing: 4 modos con cantidad y guía.
    // One-Euro ya quitó el jitter; aquí se aplica el estilo elegido.
    const amt = this.amt;
    switch (this.mode) {
      case "pulled-string": {
        // Cuerda: longitud controlable por el slider "Cuerda" (stringLen), no por Cantidad.
        const slack = this.stringLen * 90 / this.zoom;
        const dx = f.x - this.psX, dy = f.y - this.psY;
        const d = Math.hypot(dx, dy);
        if (d > slack) {
          const pull = d - slack;
          this.psX += (dx / d) * pull;
          this.psY += (dy / d) * pull;
        }
        // Pulled-string usa lerp con release para no "enganchar" al parar
        this.penX = this.psX; this.penY = this.psY;
        break;
      }
      case "moving-average": {
        const win = Math.max(1, Math.round(1 + amt * 18));
        this.maQ.push({ x: f.x, y: f.y });
        while (this.maQ.length > win) this.maQ.shift();
        let ax = 0, ay = 0; for (const q of this.maQ) { ax += q.x; ay += q.y; }
        this.penX = ax / this.maQ.length; this.penY = ay / this.maQ.length;
        break;
      }
      case "ema": {
        const alpha = 1 / (1 + amt * 35);
        this.emaX = this.emaX + (f.x - this.emaX) * alpha;
        this.emaY = this.emaY + (f.y - this.emaY) * alpha;
        this.penX = this.emaX; this.penY = this.emaY;
        break;
      }
      case "inertia": {
        // Masa: velocidad elástica que persigue al cursor (física simple).
        const stiffness = lerp(28, 3.5, amt);
        const damping = lerp(14, 6, amt);
        const ax = (f.x - this.penX) * stiffness - this.velX * damping;
        const ay = (f.y - this.penY) * stiffness - this.velY * damping;
        this.velX += ax * dt; this.velY += ay * dt;
        this.penX += this.velX * dt;
        this.penY += this.velY * dt;
        break;
      }
    }
    const x = this.penX;
    const y = this.penY;

    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const dWorld = Math.hypot(dx, dy);
    this.lastT = s.t;

    // Muestreo mínimo (en px pantalla + relativo al radio).
    //
    // El primero es el de siempre, en pixeles de pantalla: por debajo de medio
    // pixel la muestra no aporta nada. El segundo es relativo al radio: dos puntos
    // mas juntos que medio radio dejan segmentos mucho mas cortos que el ancho del
    // trazo, y como en 3D las juntas se prolongan hasta un radio, todos los
    // segmentos acabarian conteniendose unos a otros.
    //
    const minStep = Math.max(0.44 / this.zoom, 0.28 * this.lastR);
    if (!force && dWorld < minStep) return false;

    this.lastX = x;
    this.lastY = y;
    this.arcLen += dWorld;

    // Rumbo suavizado (unitario). Se mezcla con damp para que gire sin saltos:
    // es la base de la prediccion sintetica y del afilado estable de la punta.
    const invd = 1 / dWorld;
    const nx = dx * invd;
    const ny = dy * invd;
    if (!this.hasHeading) {
      this.headX = nx;
      this.headY = ny;
      this.hasHeading = true;
    } else {
      const k = 1 - Math.exp(-30 * dt);
      this.headX += (nx - this.headX) * k;
      this.headY += (ny - this.headY) * k;
      const hl = Math.hypot(this.headX, this.headY) || 1;
      this.headX /= hl;
      this.headY /= hl;
    }

    // 3. Presion efectiva (con sustituto por velocidad si no hay tableta).
    const hasPressure = s.pressure >= 0;
    const rawPressure = hasPressure
      ? s.pressure
      : clamp01(1 - this.speed / Math.max(0.2, st.velocityScale * 1.5));
    const target = shapeCurve(rawPressure, st.pressureCurve);
    this.smoothPressure = damp(this.smoothPressure, target, hasPressure ? 45 : 16, dt);

    const { r, a } = resolveRadius(
      st,
      this.smoothPressure,
      this.speed,
      s.tilt,
      s.azimuth,
      this.rng,
    );

    this.pts.push({
      x,
      y,
      r,
      p: this.smoothPressure,
      v: this.speed,
      a,
      t: s.t,
    });
    this.lastR = r;
    return true;
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

  for (let i = 0; i < n; i++) {
    points[i].r *= taperFactor(cum[i], total, st.taperIn, st.taperOut);
  }
}
