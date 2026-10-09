import { clamp01, damp, lerp, shapeCurve, smoothstep } from "../core/math";
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
    //
    // Dos parametros gobiernan el One-Euro:
    //  - minCutoff: cuanto se filtra EN REPOSO (temblor de la mano). Un piso alto
    //    mantiene la punta pegada al lapiz cuando casi no te mueves.
    //  - beta: cuanto SUBE el corte con la velocidad. Un beta alto hace que a
    //    velocidad de dibujo real el filtro practicamente se apague, asi el trazo
    //    no se queda atras (la sensacion "pro", sin retardo). Antes era demasiado
    //    bajo: por eso se sentia lento.
    const sm = clamp01(st.smoothing);
    this.filter.configure(lerp(12, 1.2, sm), 0.045 + sm * 0.11);
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

    // 1. Filtro One-Euro de la posicion cruda.
    const f = this.filter.filter(s.x, s.y, dt);

    // 2. Velocidad SUAVIZADA, medida sobre el salto crudo del digitalizador.
    //    Se calcula ANTES de aplicar el arrastre y se usa tanto para la dinamica
    //    como para modular el arrastre. Usar la velocidad cruda por-muestra hacia
    //    que el arrastre parpadeara entre muestras -> el trazo salia ondulado en
    //    las curvas rapidas. Suavizada, el arrastre varia de forma continua.
    const rawStep = Math.hypot(s.x - this.lastRawX, s.y - this.lastRawY) * this.zoom;
    const instant = rawStep / dtMs;
    this.speed = damp(this.speed, instant, 22, dt);
    this.lastRawX = s.x;
    this.lastRawY = s.y;

    // 3. Arrastre tipo lazo ("estabilizador"), modulado por la velocidad suave y
    //    con RAMPA DE ARRANQUE. Al empezar un trazo rapido, un arrastre pleno
    //    retiene la punta y luego la suelta de golpe -> el "apendice"/gancho del
    //    inicio. La rampa (sobre los primeros ~14 px de recorrido) deja la punta
    //    pegada al inicio y mete el arrastre poco a poco.
    const release = clamp01(this.speed / 1.1); // 0 quieto -> 1 rapido
    const startup = smoothstep(clamp01((this.arcLen * this.zoom) / 14));
    const drag = clamp01(st.streamline) * 0.8 * (1 - 0.6 * release) * startup;
    this.penX = lerp(f.x, this.penX, drag);
    this.penY = lerp(f.y, this.penY, drag);
    const x = this.penX;
    const y = this.penY;

    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const dWorld = Math.hypot(dx, dy);
    this.lastT = s.t;

    // Muestreo minimo, con dos umbrales y gana el mas exigente.
    //
    // El primero es el de siempre, en pixeles de pantalla: por debajo de medio
    // pixel la muestra no aporta nada. El segundo es relativo al radio: dos puntos
    // mas juntos que medio radio dejan segmentos mucho mas cortos que el ancho del
    // trazo, y como en 3D las juntas se prolongan hasta un radio, todos los
    // segmentos acabarian conteniendose unos a otros.
    //
    // Tiene que ser IDENTICO en los dos constructores: la dinamica del pincel es
    // la misma en el lienzo y en el espacio, y hay una prueba que lo comprueba
    // punto por punto.
    const minStep = Math.max(0.55 / this.zoom, 0.5 * this.lastR);
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
