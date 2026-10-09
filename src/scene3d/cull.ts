/**
 * Descarte por frustum y nivel de detalle.
 *
 * Es la pieza que decide si una escena densa va fluida, y la que mas rendimiento
 * da por linea escrita:
 *
 *  - **Descarte**: un trazo cuya esfera envolvente no toca el frustum no se
 *    dibuja. Barato y sin discusion.
 *  - **LOD**: un trazo que en pantalla ocupa menos de unos pocos pixeles no
 *    necesita su cinta orientada completa; basta un quad mirando a camara. En una
 *    escena densa la mayoria de trazos caen en ese caso, asi que es donde esta el
 *    ahorro de verdad.
 *
 * El resultado no es una lista de que dibujar, sino el **orden de instancias**:
 * los indices de instancia que sobreviven, con los de nivel 0 primero y los de
 * nivel 1 despues. Asi se dibuja con dos llamadas sobre la misma geometria
 * -una por nivel- sin reordenar ni reescribir ningun buffer. WebGL2 no tiene
 * draw indirect, asi que esta compactacion es en CPU: por eso se reutiliza el
 * buffer de orden entre fotogramas en vez de asignar uno nuevo.
 *
 * No se descarta ningun trazo del modelo: esto solo decide que se dibuja hoy. El
 * documento y el historial no se enteran.
 */

import type { StrokeBatch } from "./batch";

/** Cámara en perspectiva, como la describe el visor. */
export interface Frustum {
  /** Posición de la cámara. */
  ox: number;
  oy: number;
  oz: number;
  /** Adelante, unitario. */
  fx: number;
  fy: number;
  fz: number;
  /** Derecha, unitaria. */
  rx: number;
  ry: number;
  rz: number;
  /** Arriba, unitaria. */
  ux: number;
  uy: number;
  uz: number;
  /** Tangente del semiángulo horizontal y vertical. */
  tanH: number;
  tanV: number;
  near: number;
  far: number;
}

export interface LodOptions {
  /** Alto del viewport en píxeles de dispositivo. */
  heightPx: number;
  /**
   * Radio en pantalla, en píxeles, por debajo del cual el trazo baja a nivel 1.
   *
   * Es el parámetro que hay que tocar mirando, no calculando: demasiado bajo y no
   * se gana nada, demasiado alto y se ven los trazos cambiar de forma al acercar
   * la cámara.
   */
  impostorPx: number;
}

export interface CullResult {
  /** Instancias visibles, nivel 0 primero y nivel 1 después. */
  order: Uint32Array;
  /** Cuántas de las anteriores son de nivel 0. */
  tier0: number;
  /** Cuántas son de nivel 1. */
  tier1: number;
  /** Instancias descartadas por quedar fuera del frustum. */
  culled: number;
  /** Instancias totales del lote. */
  total: number;
}

/**
 * ¿Toca la esfera al frustum?
 *
 * Conservador a propósito: cuando la esfera cruza el plano cercano devuelve
 * `true` sin mirar los lados. Un falso positivo cuesta unos triángulos; un falso
 * negativo hace desaparecer un trazo que debería verse.
 */
export const sphereVisible = (
  f: Frustum,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): boolean => {
  const dx = cx - f.ox;
  const dy = cy - f.oy;
  const dz = cz - f.oz;
  const z = dx * f.fx + dy * f.fy + dz * f.fz;

  if (z + radius < f.near) return false;
  if (z - radius > f.far) return false;
  if (z <= f.near) return true;

  const x = dx * f.rx + dy * f.ry + dz * f.rz;
  if (Math.abs(x) - radius > z * f.tanH) return false;

  const y = dx * f.ux + dy * f.uy + dz * f.uz;
  if (Math.abs(y) - radius > z * f.tanV) return false;

  return true;
};

/** Radio de la esfera en píxeles de pantalla, a la distancia dada. */
export const screenRadiusPx = (
  radius: number,
  distance: number,
  heightPx: number,
  tanV: number,
): number => {
  const z = Math.max(1e-4, distance);
  return (radius * (heightPx * 0.5)) / (z * tanV);
};

/** Distancia de un punto a la cámara. */
const distanceTo = (f: Frustum, cx: number, cy: number, cz: number): number =>
  Math.hypot(cx - f.ox, cy - f.oy, cz - f.oz);

/**
 * Decide qué instancias de un lote se dibujan y en qué nivel.
 *
 * `out` permite reutilizar el buffer de orden entre fotogramas; si no se pasa, se
 * asigna uno del tamaño justo.
 */
export const cullBatch = (
  batch: StrokeBatch,
  f: Frustum,
  opts: LodOptions,
  out?: Uint32Array,
): CullResult => {
  const total = batch.instancesLaid;
  const order = out && out.length >= total ? out : new Uint32Array(total);

  const tier0: number[] = [];
  const tier1: number[] = [];
  let instance = 0;
  let culled = 0;

  for (const range of batch.ranges) {
    // Cada punto del trazo aporta una instancia: la ultima lee el centinela y sale
    // degenerada, asi que contarla es correcto y ademas mantiene las cuentas
    // alineadas con el buffer.
    const count = range.count;
    if (count === 0) continue;

    if (!range.active) {
      // Rango borrado: sus instancias existen en el buffer pero no se dibujan.
      instance += count;
      continue;
    }

    if (!sphereVisible(f, range.cx, range.cy, range.cz, range.radius)) {
      culled += count;
      instance += count;
      continue;
    }

    const px = screenRadiusPx(
      range.radius,
      distanceTo(f, range.cx, range.cy, range.cz),
      opts.heightPx,
      f.tanV,
    );
    const bucket = px < opts.impostorPx ? tier1 : tier0;
    for (let i = 0; i < count; i++) bucket.push(instance + i);
    instance += count;
  }

  let w = 0;
  for (const i of tier0) order[w++] = i;
  const t0 = w;
  for (const i of tier1) order[w++] = i;

  return { order, tier0: t0, tier1: w - t0, culled, total };
};

/**
 * Construye el frustum a partir de la cámara.
 *
 * `fovY` en radianes y `aspecto` = ancho/alto. La base se ortogonaliza aquí para
 * que el llamante pueda pasar el "arriba" aproximado sin preocuparse de que sea
 * exactamente perpendicular.
 */
export const frustumOf = (
  ox: number,
  oy: number,
  oz: number,
  forward: { x: number; y: number; z: number },
  up: { x: number; y: number; z: number },
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Frustum => {
  const fl = Math.hypot(forward.x, forward.y, forward.z) || 1;
  const fx = forward.x / fl;
  const fy = forward.y / fl;
  const fz = forward.z / fl;

  // Derecha = adelante x arriba, normalizado.
  let rx = fy * up.z - fz * up.y;
  let ry = fz * up.x - fx * up.z;
  let rz = fx * up.y - fy * up.x;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;

  // Arriba recomputado: perpendicular exacta a adelante y derecha.
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const tanV = Math.tan(fovY * 0.5);
  return {
    ox,
    oy,
    oz,
    fx,
    fy,
    fz,
    rx,
    ry,
    rz,
    ux,
    uy,
    uz,
    tanH: tanV * aspect,
    tanV,
    near,
    far,
  };
};
