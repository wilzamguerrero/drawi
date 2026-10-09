/**
 * Decimación del trazo antes de guardarlo.
 *
 * Un gesto de un segundo entra a ~200-400 muestras por segundo. Guardarlas todas
 * es tirar memoria y además empeora el resultado: el ruido del digitalizador se
 * convierte en ondulación de la cinta. Se decima **al capturar**, una vez, y no
 * en cada fotograma.
 *
 * El criterio combina dos errores, y esa es la parte que importa:
 *
 *  - **Posición**, con Douglas-Peucker: conserva la forma, dejando más puntos
 *    donde el trazo dobla. Es lo que evita que una curva se convierta en una
 *    cuerda.
 *  - **Ancho**, que Douglas-Peucker sobre posiciones ignora. Un tramo recto con
 *    la presión cambiando rápido se vería como un escalón si solo se mirara la
 *    posición, así que un punto también se conserva si su ancho se aleja del
 *    interpolado.
 */

import { POINT_FLOATS, POS_OFFSET, RADIUS_OFFSET } from "./types";

export interface SimplifyOptions {
  /** Tolerancia de posición, en unidades de mundo. */
  tolerance: number;
  /**
   * Cuánto pesa un desajuste de ancho frente a uno de posición.
   *
   * A 1, un punto se conserva si su ancho se desvía tanto como su posición.
   * Un valor mayor conserva más puntos en los cambios de presión.
   */
  radiusWeight: number;
  /** Techo duro de puntos. Si se supera se relaja la tolerancia. */
  maxPoints: number;
}

export const DEFAULT_SIMPLIFY: SimplifyOptions = {
  tolerance: 0.35,
  radiusWeight: 1.5,
  maxPoints: 512,
};

/** Error combinado de un punto respecto al segmento que lo salta. */
const errorOf = (
  data: Float32Array,
  i: number,
  a: number,
  b: number,
  radiusWeight: number,
): number => {
  const oi = i * POINT_FLOATS;
  const oa = a * POINT_FLOATS;
  const ob = b * POINT_FLOATS;

  const ax = data[oa + POS_OFFSET];
  const ay = data[oa + POS_OFFSET + 1];
  const az = data[oa + POS_OFFSET + 2];
  const bx = data[ob + POS_OFFSET];
  const by = data[ob + POS_OFFSET + 1];
  const bz = data[ob + POS_OFFSET + 2];

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const den = abx * abx + aby * aby + abz * abz;

  const px = data[oi + POS_OFFSET];
  const py = data[oi + POS_OFFSET + 1];
  const pz = data[oi + POS_OFFSET + 2];
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const s = den < 1e-12 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / den));
  const dx = apx - abx * s;
  const dy = apy - aby * s;
  const dz = apz - abz * s;
  const posErr = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const wa = data[oa + RADIUS_OFFSET];
  const wb = data[ob + RADIUS_OFFSET];
  const wErr = Math.abs(data[oi + RADIUS_OFFSET] - (wa + (wb - wa) * s));

  return Math.max(posErr, wErr * radiusWeight);
};

/**
 * Douglas-Peucker con pila explícita.
 *
 * Explícita y no recursiva porque un trazo largo y recto con un único punto
 * desviado genera una profundidad de recursión proporcional al número de puntos,
 * y eso desborda la pila con dibujos grandes.
 */
const douglasPeucker = (
  data: Float32Array,
  count: number,
  tolerance: number,
  radiusWeight: number,
  keep: Uint8Array,
): number => {
  keep[0] = 1;
  keep[count - 1] = 1;
  let kept = count >= 2 ? 2 : count;

  const stack: number[] = [0, count - 1];
  while (stack.length > 0) {
    const b = stack.pop() as number;
    const a = stack.pop() as number;
    if (b - a < 2) continue;

    let far = -1;
    let farErr = tolerance;
    for (let i = a + 1; i < b; i++) {
      const e = errorOf(data, i, a, b, radiusWeight);
      if (e > farErr) {
        farErr = e;
        far = i;
      }
    }
    if (far < 0) continue;

    keep[far] = 1;
    kept++;
    stack.push(a, far, far, b);
  }
  return kept;
};

/** Copia a un buffer nuevo los puntos marcados en `keep`. */
const compact = (data: Float32Array, count: number, keep: Uint8Array): Float32Array => {
  let kept = 0;
  for (let i = 0; i < count; i++) if (keep[i]) kept++;
  const out = new Float32Array(kept * POINT_FLOATS);
  let w = 0;
  for (let i = 0; i < count; i++) {
    if (!keep[i]) continue;
    out.set(data.subarray(i * POINT_FLOATS, (i + 1) * POINT_FLOATS), w);
    w += POINT_FLOATS;
  }
  return out;
};

/**
 * Devuelve los puntos decimados del trazo.
 *
 * Para respetar `maxPoints` se relaja la tolerancia en vez de recortar por la
 * brava: así el trazo conserva su forma y solo pierde detalle fino, en lugar de
 * perder un tramo entero.
 */
export const simplifyStroke = (
  data: Float32Array,
  count: number,
  options: Partial<SimplifyOptions> = {},
): { data: Float32Array; count: number } => {
  const opts = { ...DEFAULT_SIMPLIFY, ...options };
  if (count <= 2) {
    return { data: data.slice(0, count * POINT_FLOATS), count };
  }

  const keep = new Uint8Array(count);
  let tolerance = Math.max(1e-4, opts.tolerance);
  let kept = 0;

  for (let attempt = 0; attempt < 8; attempt++) {
    keep.fill(0);
    kept = douglasPeucker(data, count, tolerance, opts.radiusWeight, keep);
    if (kept <= opts.maxPoints) break;
    tolerance *= 2;
    // Si ni relajando entra, se corta aquí: más intentos solo emborronarían.
    if (attempt === 7) return uniformByArclength(data, count, opts.maxPoints);
  }

  return { data: compact(data, count, keep), count: kept };
};

/**
 * Último recurso: reparto uniforme por longitud de arco.
 *
 * Solo se alcanza con trazos patológicos (miles de puntos con ruido de ancho
 * constante). Conserva la forma mejor que recortar por índice porque respeta el
 * espaciado real del gesto.
 */
const uniformByArclength = (
  data: Float32Array,
  count: number,
  maxPoints: number,
): { data: Float32Array; count: number } => {
  const cum = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const a = (i - 1) * POINT_FLOATS + POS_OFFSET;
    const b = i * POINT_FLOATS + POS_OFFSET;
    cum[i] =
      cum[i - 1] +
      Math.hypot(
        data[b] - data[a],
        data[b + 1] - data[a + 1],
        data[b + 2] - data[a + 2],
      );
  }
  const total = cum[count - 1];
  if (total <= 1e-9) return { data: data.slice(0, POINT_FLOATS), count: 1 };

  const out = new Float32Array(maxPoints * POINT_FLOATS);
  let w = 0;
  let j = 0;
  for (let k = 0; k < maxPoints; k++) {
    const target = (k / (maxPoints - 1)) * total;
    while (j < count - 2 && cum[j + 1] < target) j++;
    out.set(data.subarray(j * POINT_FLOATS, (j + 1) * POINT_FLOATS), w);
    w += POINT_FLOATS;
  }
  return { data: out, count: maxPoints };
};
