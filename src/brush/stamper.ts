import { clamp01 } from "../core/math";
import { Rng } from "../core/rng";

/**
 * Estampado ráster incremental, en vivo.
 *
 * Un trazo de pincel ráster se construye estampa a estampa MIENTRAS el lápiz se
 * mueve, no al soltar: por eso el estado (acumulador de separación, última
 * huella, RNG de las dinámicas) vive en un objeto `RasterStroke` que el editor
 * alimenta con cada tramo nuevo.
 *
 * Modelo de Photoshop para que el solape no "queme": el FLUJO se acumula estampa
 * a estampa en este buffer propio (una sola capa, `source-over`), y es el editor
 * quien lo vuelca sobre la capa a la OPACIDAD del trazo. Así, por mucho que las
 * huellas se pisen dentro de un mismo trazo, nunca superan esa opacidad.
 *
 * Dinámicas (como las pestañas de Photoshop): ángulo y redondez de la punta,
 * ángulo que sigue a la dirección del trazo, dispersión (varias huellas
 * desplazadas por paso) y "jitter" de tamaño/ángulo/redondez/flujo. Todas
 * deterministas a partir de `seed`.
 */

export interface RasterDab {
  /** Centro en px del lienzo de la capa. */
  x: number;
  y: number;
  /** Radio en px del lienzo de la capa. */
  r: number;
  /** Presión 0..1 de esta estampa (para modular flow/opacity si hay pressure control). */
  p?: number;
}

export interface RasterStrokeOptions {
  /** Punta ya teñida al color del pincel (su alfa es la cobertura). */
  tintedTip: HTMLCanvasElement;
  /** Flujo por estampa (0..1). */
  flow: number;
  /** Separación entre estampas, fracción del diámetro (>0; 0.1 = 10%). */
  spacing: number;
  /** Ángulo base de la punta (radianes). */
  angle: number;
  /** Redondez de la punta (0..1; 1 = redonda, <1 = achatada → caligráfica). */
  roundness: number;
  /** El ángulo sigue a la dirección del trazo (se suma al ángulo base). */
  angleFollow: boolean;
  /** Jitter de tamaño (0..1): reduce el radio al azar hasta ese tanto. */
  sizeJitter: number;
  /** Jitter de ángulo (0..1): ±ese tanto de media vuelta al azar por huella. */
  angleJitter: number;
  /** Jitter de redondez (0..1). */
  roundnessJitter: number;
  /** Jitter de flujo (0..1). */
  flowJitter: number;
  /** Jitter de opacidad por estampa (0..1). */
  opacityJitter: number;
  /** Cuánto la presión modula la opacidad por estampa (0..1). */
  pressureOpacity: number;
  /** Cuánto la presión modula el flujo por estampa (0..1). */
  pressureFlow: number;
  /** Dispersión: radio de desplazamiento al azar, en diámetros. */
  scatter: number;
  /** Huellas por punto de muestreo (1..). */
  scatterCount: number;
  /** Semilla del RNG de las dinámicas. */
  seed: number;
}

export class RasterStroke {
  /** Buffer propio del trazo: el editor lo compone sobre la capa a `opacity`. */
  readonly buffer: HTMLCanvasElement;
  private bg: CanvasRenderingContext2D;
  private o: RasterStrokeOptions;
  private rng: Rng;
  private spacing: number;
  private acc = 0;
  private last: RasterDab | null = null;

  // Caja (en px del buffer) de todo lo estampado: el editor recompone solo esta
  // región cada fotograma en vez del lienzo entero.
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  constructor(width: number, height: number, opts: RasterStrokeOptions) {
    const buf = document.createElement("canvas");
    buf.width = Math.max(1, width);
    buf.height = Math.max(1, height);
    const bg = buf.getContext("2d");
    if (!bg) throw new Error("Canvas 2D no disponible");
    this.buffer = buf;
    this.bg = bg;
    this.o = opts;
    this.rng = new Rng(opts.seed);
    this.spacing = Math.max(0.01, opts.spacing);
  }

  /** ¿Se ha estampado algo? (La caja tiene área.) */
  get dirty(): boolean {
    return this.maxX > this.minX && this.maxY > this.minY;
  }

  /** Estampa UNA huella base en (x,y) con radio r, orientada según `dir` (rumbo). */
  private stamp(x: number, y: number, r: number, dir: number, pressure = 1): void {
    if (r <= 0) return;
    const o = this.o;
    const count = Math.max(1, Math.round(o.scatterCount));
    for (let i = 0; i < count; i++) {
      // Dispersión: desplazamiento radial al azar hasta `scatter` diámetros.
      let px = x;
      let py = y;
      if (o.scatter > 0) {
        const a = this.rng.next() * Math.PI * 2;
        const d = this.rng.next() * o.scatter * r * 2;
        px += Math.cos(a) * d;
        py += Math.sin(a) * d;
      }
      const rr = o.sizeJitter > 0 ? r * (1 - this.rng.next() * o.sizeJitter) : r;
      if (rr <= 0.2) continue;
      let ang = o.angle + (o.angleFollow ? dir : 0);
      if (o.angleJitter > 0) ang += (this.rng.next() * 2 - 1) * o.angleJitter * Math.PI;
      const round =
        o.roundnessJitter > 0
          ? Math.max(0.05, o.roundness * (1 - this.rng.next() * o.roundnessJitter))
          : o.roundness;
      // Transfer dinámico: flujo y opacidad modulados por presión + jitter, como Photoshop.
      const press = clamp01(pressure);
      let flow = o.flow;
      if (o.pressureFlow > 0) flow *= 1 - o.pressureFlow * (1 - press);
      if (o.flowJitter > 0) flow *= 1 - this.rng.next() * o.flowJitter;
      let dabAlpha = flow;
      if (o.pressureOpacity > 0) dabAlpha *= 1 - o.pressureOpacity * (1 - press);
      if (o.opacityJitter > 0) dabAlpha *= 1 - this.rng.next() * o.opacityJitter;

      this.bg.save();
      this.bg.globalAlpha = clamp01(dabAlpha);
      this.bg.translate(px, py);
      if (ang !== 0) this.bg.rotate(ang);
      if (round < 1) this.bg.scale(1, Math.max(0.05, round));
      this.bg.drawImage(o.tintedTip, -rr, -rr, rr * 2, rr * 2);
      this.bg.restore();

      // Caja: con dispersión y rotación, un disco de radio rr centrado en (px,py)
      // acota el estampado (la rotación y el achatado no lo agrandan).
      if (px - rr < this.minX) this.minX = px - rr;
      if (py - rr < this.minY) this.minY = py - rr;
      if (px + rr > this.maxX) this.maxX = px + rr;
      if (py + rr > this.maxY) this.maxY = py + rr;
    }
  }

  private prev: RasterDab | null = null;

  /**
   * Prolonga el trazo hasta `p`, estampando a lo largo del tramo desde la última
   * huella. Usa Catmull-Rom con 3 anclas (prev→a→p→pNext) para que círculos
   * rápidos no se vean como rectas: el digitalizador entrega puntos muy separados
   * y unirlos en recta deja el "escalón" de tu captura. Mantiene el acumulador de
   * spacing y el blending de presión/radio.
   */
  add(p: RasterDab): void {
    const a = this.last;
    if (!a) {
      this.stamp(p.x, p.y, p.r, 0, p.p ?? 1);
      this.last = p;
      this.prev = null;
      this.acc = 0;
      return;
    }
    const p0 = this.prev ?? a;
    const p1 = a;
    const p2 = p;
    // p3 se aproxima como extrapolación de p1→p2 (sin lookahead)
    const p3: RasterDab = { x: p2.x + (p2.x - p1.x), y: p2.y + (p1.y - p2.y) * -1 + (p2.y - p1.y), r: p2.r, p: p2.p };
    // Re-estima p3 correctamente
    p3.x = p2.x + (p2.x - p1.x);
    p3.y = p2.y + (p2.y - p1.y);
    const segLenLinear = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    // Si el salto es muy corto, recta es suficiente (evita oscilación).
    if (segLenLinear < 1.5) {
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const dir = Math.atan2(dy, dx);
      let traveled = 0;
      for (;;) {
        const t0 = traveled / Math.max(segLenLinear, 1e-6);
        const r0 = p1.r + (p2.r - p1.r) * t0;
        const step = Math.max(0.5, this.spacing * r0 * 2);
        const need = step - this.acc;
        if (traveled + need > segLenLinear) { this.acc += segLenLinear - traveled; break; }
        traveled += need; this.acc = 0;
        const t = traveled / Math.max(segLenLinear, 1e-6);
        const press = (p1.p ?? 1) + ((p2.p ?? 1) - (p1.p ?? 1)) * t;
        this.stamp(p1.x + dx * t, p1.y + dy * t, p1.r + (p2.r - p1.r) * t, dir, press);
      }
      this.prev = p1; this.last = p2;
      return;
    }
    // Spline: muestrea la curva con resolución ligada al radio para no facetear
    const approxLen = Math.hypot(p2.x - p0.x, p2.y - p0.y) + Math.hypot(p3.x - p1.x, p3.y - p1.y);
    const avgR = (p0.r + p1.r + p2.r + p3.r) * 0.25;
    const idealStep = Math.max(0.5, this.spacing * avgR * 2);
    const steps = Math.max(6, Math.min(64, Math.ceil(approxLen / Math.max(idealStep, 1.5))));
    let totalLen = 0;
    const pts: { x: number; y: number }[] = [];
    let px = p1.x, py = p1.y;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const t2 = t * t, t3 = t2 * t;
      const h = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const x = h(p0.x, p1.x, p2.x, p3.x);
      const y = h(p0.y, p1.y, p2.y, p3.y);
      totalLen += Math.hypot(x - px, y - py);
      pts.push({ x, y });
      px = x; py = y;
    }
    // Estampa a pasos regulares sobre la longitud de arco de la spline
    let dist = 0;
    let idx = 0;
    let curLen = 0;
    px = p1.x; py = p1.y;
    let segStart = 0;
    for (let k = 0; k < pts.length; k++) {
      const q = pts[k];
      const seg = Math.hypot(q.x - px, q.y - py);
      curLen += seg;
      while (true) {
        const rAtT = p1.r + (p2.r - p1.r) * (curLen / Math.max(totalLen, 1e-6));
        const step = Math.max(0.5, this.spacing * rAtT * 2);
        const need = step - this.acc;
        if (dist + need > curLen) break;
        dist += need; this.acc = 0;
        const f = Math.max(0, Math.min(1, (dist - segStart) / Math.max(seg, 1e-6)));
        const sx = px + (q.x - px) * f;
        const sy = py + (q.y - py) * f;
        const tAlong = dist / Math.max(totalLen, 1e-6);
        const pr = (p1.p ?? 1) + ((p2.p ?? 1) - (p1.p ?? 1)) * tAlong;
        const rr = p1.r + (p2.r - p1.r) * tAlong;
        const dir = Math.atan2(q.y - py, q.x - px) || Math.atan2(p2.y - p1.y, p2.x - p1.x);
        this.stamp(sx, sy, rr, dir, pr);
        idx++;
        if (idx > 500) break;
      }
      segStart = curLen;
      px = q.x; py = q.y;
    }
    this.acc += totalLen - dist;
    this.prev = p1;
    this.last = p2;
  }
}
