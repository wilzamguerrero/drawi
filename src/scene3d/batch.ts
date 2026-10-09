/**
 * Lotes de trazos 3D: como meter miles de trazos en unas pocas draw calls.
 *
 * El problema: una malla por trazo son 20.000 draw calls y eso no hay GPU que lo
 * mueva. La solucion es la que usa Open Brush en produccion: un **lote** por
 * pareja (capa, pincel, color) con todos sus trazos en un unico `Float32Array`
 * contiguo, y un **rango** por trazo dentro de el. Una sola malla, una sola
 * llamada de dibujado.
 *
 * Lo que guarda el buffer son **segmentos, no puntos**. Cada entrada lleva los dos
 * extremos del segmento ya resueltos:
 *
 *     [ posA(3) normalA(3) radioA(1) | posB(3) normalB(3) radioB(1) ]
 *
 * Cuesta mas memoria que guardar los puntos -56 bytes por segmento frente a 36
 * por punto, porque cada punto aparece en dos segmentos- pero se gana algo que
 * vale mucho mas: **el indice de instancia y el de datos coinciden**.
 *
 * Esa igualdad no es un detalle, es la correccion entera del sistema. La version
 * anterior guardaba puntos y dejaba que el shader leyera `puntos[i]` y
 * `puntos[i+1]`, con un punto centinela al final de cada trazo para cortar la
 * cinta en la frontera. El centinela desplazaba los indices, asi que a partir del
 * segundo trazo cada instancia leia puntos equivocados: el ultimo trazo dibujado
 * no aparecia y los anteriores salian ligeramente corridos. Con los extremos
 * explicativos el problema no existe y ademas desaparece el centinela.
 *
 * La otra decision que parece rara y es la mas importante: **borrar no compacta**.
 * Se ponen a cero los radios del rango, sus segmentos quedan degenerados, y el
 * hueco se conserva. Compactar en cada borrado obligaria a reescribir el buffer
 * entero y a recolocar todos los rangos posteriores; con deshacer y rehacer
 * encima, ese es exactamente el trabajo que hace que una aplicacion se sienta
 * lenta. Solo se compacta cuando el desperdicio pasa de un umbral.
 *
 * Nada de esto se guarda en el documento: los lotes son datos derivados de los
 * trazos y se reconstruyen al abrir.
 */

import {
  NRM_OFFSET,
  POINT_FLOATS,
  POS_OFFSET,
  RADIUS_OFFSET,
  boundsCenter,
  boundsRadius,
  type Stroke3D,
} from "./types";

/** Puntos reservados por lote antes de crecer, medidos en segmentos. */
const RESERVE_SEGMENTS = 4096;

/** Floats por segmento en el buffer del lote. */
export const INSTANCE_FLOATS = 14;

/** Desplazamientos dentro del segmento, en floats. */
export const IA_POS = 0;
export const IA_NRM = 3;
export const IA_RAD = 6;
export const IB_POS = 7;
export const IB_NRM = 10;
export const IB_RAD = 13;

/** Bytes por segmento. Es el numero que hay que vigilar al crecer el dibujo. */
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

/** Desperdicio a partir del cual compensa compactar. */
export const COMPACT_THRESHOLD = 0.35;

/** Segmentos que aporta un trazo: uno por par de puntos consecutivos. */
export const segmentsOf = (points: number): number => (points > 1 ? points - 1 : 0);

export interface StrokeRange {
  strokeId: string;
  /** Primer segmento del trazo dentro del buffer del lote. */
  start: number;
  /** Segmentos del trazo. */
  count: number;
  /** Centro y radio de la esfera envolvente, para el culling. */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  /** false = rango borrado: sus segmentos estan degenerados pero ocupan su hueco. */
  active: boolean;
  /** El trazo de origen, para poder restaurarlo sin volver a construirlo. */
  stroke: Stroke3D;
}

export class StrokeBatch {
  readonly layerId: string;
  readonly brush: string;
  readonly color: string;

  /** Segmentos de todos los trazos del lote, empaquetados. */
  data: Float32Array;
  /** Segmentos ocupados, incluidos los de rangos borrados. */
  segments = 0;
  ranges: StrokeRange[] = [];
  /** Sube con cada cambio de datos: la GPU la usa para saber si debe resubir. */
  revision = 0;

  private byId = new Map<string, StrokeRange>();

  constructor(layerId: string, brush: string, color = "#ffffff", reserve = RESERVE_SEGMENTS) {
    this.layerId = layerId;
    this.brush = brush;
    this.color = color;
    this.data = new Float32Array(Math.max(1, reserve) * INSTANCE_FLOATS);
  }

  /** Segmentos a dibujar: solo los rangos activos. */
  get instances(): number {
    let n = 0;
    for (const r of this.ranges) if (r.active) n += r.count;
    return n;
  }

  /** Segmentos que habria si nada estuviera borrado. */
  get instancesLaid(): number {
    let n = 0;
    for (const r of this.ranges) n += r.count;
    return n;
  }

  /** Proporcion de segmentos desperdiciados por rangos borrados. */
  get waste(): number {
    if (this.segments === 0) return 0;
    let dead = 0;
    for (const r of this.ranges) if (!r.active) dead += r.count;
    return dead / this.segments;
  }

  /** Bytes que ocupa el lote. Es lo que hay que vigilar, no el numero de trazos. */
  get bytes(): number {
    return this.data.byteLength;
  }

  range(strokeId: string): StrokeRange | undefined {
    return this.byId.get(strokeId);
  }

  /** Añade un trazo al final y devuelve su rango. */
  add(stroke: Stroke3D): StrokeRange {
    const count = segmentsOf(stroke.count);
    this.grow(this.segments + count);
    const start = this.segments;
    this.writeSegments(stroke, start);
    this.segments += count;

    const c = boundsCenter(stroke.bounds);
    const range: StrokeRange = {
      strokeId: stroke.id,
      start,
      count,
      cx: c.x,
      cy: c.y,
      cz: c.z,
      radius: Math.max(1e-3, boundsRadius(stroke.bounds)),
      active: true,
      stroke,
    };
    this.ranges.push(range);
    this.byId.set(stroke.id, range);
    this.revision++;
    return range;
  }

  /**
   * Escribe en `dest` los segmentos de un trazo.
   *
   * Cada segmento copia los dos puntos que une. Es la unica copia que se hace, y
   * ocurre una vez por trazo, al cerrarlo, no en cada fotograma.
   */
  private writeSegments(stroke: Stroke3D, dest: number): void {
    const n = segmentsOf(stroke.count);
    const src = stroke.data;
    for (let i = 0; i < n; i++) {
      const a = i * POINT_FLOATS;
      const b = (i + 1) * POINT_FLOATS;
      const o = (dest + i) * INSTANCE_FLOATS;
      this.data[o + IA_POS] = src[a + POS_OFFSET];
      this.data[o + IA_POS + 1] = src[a + POS_OFFSET + 1];
      this.data[o + IA_POS + 2] = src[a + POS_OFFSET + 2];
      this.data[o + IA_NRM] = src[a + NRM_OFFSET];
      this.data[o + IA_NRM + 1] = src[a + NRM_OFFSET + 1];
      this.data[o + IA_NRM + 2] = src[a + NRM_OFFSET + 2];
      this.data[o + IA_RAD] = src[a + RADIUS_OFFSET];

      this.data[o + IB_POS] = src[b + POS_OFFSET];
      this.data[o + IB_POS + 1] = src[b + POS_OFFSET + 1];
      this.data[o + IB_POS + 2] = src[b + POS_OFFSET + 2];
      this.data[o + IB_NRM] = src[b + NRM_OFFSET];
      this.data[o + IB_NRM + 1] = src[b + NRM_OFFSET + 1];
      this.data[o + IB_NRM + 2] = src[b + NRM_OFFSET + 2];
      this.data[o + IB_RAD] = src[b + RADIUS_OFFSET];
    }
  }

  /**
   * Borra un trazo sin mover nada: pone sus radios a cero.
   *
   * Un radio cero deja el quad sin area, asi que la GPU lo descarta. El hueco se
   * queda donde estaba y los rangos posteriores no se enteran.
   */
  remove(strokeId: string): boolean {
    const r = this.byId.get(strokeId);
    if (!r || !r.active) return false;
    this.zeroRadius(r);
    r.active = false;
    this.revision++;
    return true;
  }

  /** Deshace un borrado reescribiendo los segmentos desde el trazo de origen. */
  restore(strokeId: string): boolean {
    const r = this.byId.get(strokeId);
    if (!r || r.active) return false;
    this.writeSegments(r.stroke, r.start);
    r.active = true;
    this.revision++;
    return true;
  }

  /** Quita el rango del indice. El hueco lo recupera `compact`. */
  forget(strokeId: string): boolean {
    const r = this.byId.get(strokeId);
    if (!r) return false;
    this.zeroRadius(r);
    r.active = false;
    this.byId.delete(strokeId);
    this.revision++;
    return true;
  }

  /**
   * Reconstruye el buffer solo con los rangos vivos.
   *
   * Se llama cuando el desperdicio pasa del umbral, no en cada borrado. Devuelve
   * los segmentos recuperados.
   */
  compact(): number {
    const before = this.segments;
    let write = 0;
    const kept: StrokeRange[] = [];
    for (const r of this.ranges) {
      if (!r.active) continue;
      if (r.start !== write) {
        this.data.copyWithin(
          write * INSTANCE_FLOATS,
          r.start * INSTANCE_FLOATS,
          (r.start + r.count) * INSTANCE_FLOATS,
        );
      }
      r.start = write;
      write += r.count;
      kept.push(r);
    }
    this.ranges = kept;
    this.segments = write;
    this.revision++;
    return before - write;
  }

  /** Compacta solo si merece la pena. */
  compactIfWasteful(): boolean {
    if (this.waste < COMPACT_THRESHOLD) return false;
    this.compact();
    return true;
  }

  /** Centro del segmento `i`, para pruebas y depuracion. */
  segmentCenter(i: number): [number, number, number] {
    const o = i * INSTANCE_FLOATS;
    return [
      (this.data[o + IA_POS] + this.data[o + IB_POS]) * 0.5,
      (this.data[o + IA_POS + 1] + this.data[o + IB_POS + 1]) * 0.5,
      (this.data[o + IA_POS + 2] + this.data[o + IB_POS + 2]) * 0.5,
    ];
  }

  private zeroRadius(r: StrokeRange): void {
    for (let i = 0; i < r.count; i++) {
      const o = (r.start + i) * INSTANCE_FLOATS;
      this.data[o + IA_RAD] = 0;
      this.data[o + IB_RAD] = 0;
    }
  }

  private grow(segments: number): void {
    if (segments * INSTANCE_FLOATS <= this.data.length) return;
    let cap = this.data.length;
    while (cap < segments * INSTANCE_FLOATS) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.segments * INSTANCE_FLOATS));
    this.data = next;
  }
}

/**
 * Conjunto de lotes de una escena 3D.
 *
 * Reparte los trazos por (capa, pincel, color). El color entra en la clave porque
 * es una constante del material y un lote comparte un unico material; la
 * alternativa -guardar el color por punto- costaria memoria siempre para ahorrar
 * unas pocas llamadas de dibujado casi nunca.
 */
export class StrokeScene {
  private batches = new Map<string, StrokeBatch>();
  private home = new Map<string, string>();
  /** Orden de creacion, para que el dibujado sea estable entre fotogramas. */
  private order: string[] = [];

  private static key(layerId: string, brush: string, color: string): string {
    return `${layerId}|${brush}|${color}`;
  }

  get all(): readonly StrokeBatch[] {
    return this.order.map((k) => this.batches.get(k) as StrokeBatch);
  }

  get batchCount(): number {
    return this.batches.size;
  }

  batchFor(layerId: string, brush: string, color = "#ffffff"): StrokeBatch | undefined {
    return this.batches.get(StrokeScene.key(layerId, brush, color));
  }

  add(stroke: Stroke3D): StrokeRange {
    const key = StrokeScene.key(stroke.layerId, stroke.brush, stroke.color);
    let batch = this.batches.get(key);
    if (!batch) {
      batch = new StrokeBatch(stroke.layerId, stroke.brush, stroke.color);
      this.batches.set(key, batch);
      this.order.push(key);
    }
    this.home.set(stroke.id, key);
    return batch.add(stroke);
  }

  remove(strokeId: string): boolean {
    const key = this.home.get(strokeId);
    if (!key) return false;
    return this.batches.get(key)?.remove(strokeId) ?? false;
  }

  restore(strokeId: string): boolean {
    const key = this.home.get(strokeId);
    if (!key) return false;
    return this.batches.get(key)?.restore(strokeId) ?? false;
  }

  /** Borra definitivamente: el trazo sale del indice y su hueco queda libre. */
  forget(strokeId: string): boolean {
    const key = this.home.get(strokeId);
    if (!key) return false;
    const done = this.batches.get(key)?.forget(strokeId) ?? false;
    if (done) this.home.delete(strokeId);
    return done;
  }

  range(strokeId: string): StrokeRange | undefined {
    const key = this.home.get(strokeId);
    return key ? this.batches.get(key)?.range(strokeId) : undefined;
  }

  /** Segmentos a dibujar en total: es el numero que debe caber en el presupuesto. */
  get instances(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.instances;
    return n;
  }

  get bytes(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.bytes;
    return n;
  }

  /** Compacta los lotes que lo necesiten. Devuelve cuantos segmentos se recuperaron. */
  compact(): number {
    let freed = 0;
    for (const b of this.batches.values()) {
      const before = b.segments;
      if (b.compactIfWasteful()) freed += before - b.segments;
    }
    return freed;
  }

  /** Suelta los lotes que se quedaron sin ningun trazo vivo. */
  prune(): number {
    let dropped = 0;
    for (const key of [...this.order]) {
      const b = this.batches.get(key);
      if (!b) continue;
      b.compact();
      if (b.ranges.length > 0) continue;
      this.batches.delete(key);
      this.order.splice(this.order.indexOf(key), 1);
      dropped++;
    }
    return dropped;
  }
}
