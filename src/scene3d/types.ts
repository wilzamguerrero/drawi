/**
 * Modelo de datos del trazo 3D.
 *
 * Decisión central: los puntos viven en un `Float32Array` empaquetado con paso
 * fijo, no en objetos. En 2D un `StrokePoint` es un objeto con siete campos y da
 * igual; en 3D, a 36 bytes por punto frente a los ~120 de un objeto JS, la
 * diferencia es entre 40 MB y 150 MB para un dibujo denso. Es lo primero que
 * decide si el modo 3D escala o no.
 *
 * No se guarda cuaternión por punto, a diferencia de Open Brush: allí existe
 * porque un mando de VR entrega orientación completa de 6 DOF. Con lápiz solo hay
 * presión e inclinación, así que el giro de la cinta se deriva del camino (ver
 * `frames.ts`). Eso ahorra 4 floats por punto y quita una fuente de ruido.
 */

import type { V3 } from "./vec3";

/** Caja envolvente alineada a los ejes. */
export interface Bounds3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Floats por punto en el buffer empaquetado. */
export const POINT_FLOATS = 9;

/** Desplazamientos dentro del paso, en floats. */
export const POS_OFFSET = 0; // x, y, z
export const NRM_OFFSET = 3; // nx, ny, nz  (a qué mira la cinta)
export const RADIUS_OFFSET = 6; // radio (mitad del ancho)
export const PRESSURE_OFFSET = 7; // presión efectiva 0..1
export const TIME_OFFSET = 8; // ms desde el inicio del trazo

/** Bytes por punto. Es el número que hay que vigilar al crecer el dibujo. */
export const POINT_BYTES = POINT_FLOATS * 4;

/**
 * Un trazo 3D completo.
 *
 * Es inmutable por contrato: editar produce un trazo nuevo. De eso depende que el
 * historial pueda seguir compartiendo instantáneas por referencia, como ya hace
 * con la tinta 2D, y que las mallas de la GPU sean siempre datos derivados que se
 * pueden tirar y reconstruir.
 */
export interface Stroke3D {
  id: string;
  /** Familia de pincel. Es la clave de agrupación: una malla por familia y capa. */
  brush: string;
  color: string;
  layerId: string;
  /** Puntos empaquetados: `count * POINT_FLOATS` floats. Nunca se comparte. */
  data: Float32Array;
  count: number;
  bounds: Bounds3;
  /** Semilla determinista, para que un pincel con ruido se reconstruya idéntico. */
  seed: number;
  /**
   * Normal del plano sobre el que se dibujo, o `null` si fue en el aire.
   *
   * Se guarda y no se deduce porque editar el trazo -suavizarlo, arrastrarlo-
   * obliga a rehacer los marcos de la cinta, y sin esta normal los marcos
   * saldrian orientados de otra forma y la cinta se retorceria al editarla.
   */
  planeNormal: V3 | null;
}

/**
 * Muestra de entrada, ya en coordenadas de mundo.
 *
 * Calcada de `WorldSample` salvo que la posición es 3D. La presión negativa
 * significa "el dispositivo no la reporta" y se sustituye por la velocidad, igual
 * que en 2D.
 */
export interface Sample3D {
  x: number;
  y: number;
  z: number;
  pressure: number;
  tilt: number;
  azimuth: number;
  t: number;
  predicted: boolean;
}

/** Opciones de creación de un trazo 3D. */
export interface Stroke3DOptions {
  /** Familia de pincel; agrupa el batching. */
  brush: string;
  color: string;
  layerId: string;
  /**
   * Normal del plano sobre el que se dibuja, si lo hay.
   *
   * No es un detalle: es lo que hace que un trazo dibujado sobre un plano quede
   * plano sobre él en vez de retorcerse. Sin ella la cinta se orienta de forma
   * estable pero arbitraria.
   */
  planeNormal?: V3 | null;
}

export const EMPTY_BOUNDS3: Bounds3 = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 0,
  maxY: 0,
  maxZ: 0,
};

/** Radio del punto `i` del buffer empaquetado. */
export const radiusAt = (data: Float32Array, i: number): number =>
  data[i * POINT_FLOATS + RADIUS_OFFSET];

/** Caja envolvente de los puntos de un trazo, con margen para el ancho. */
export const boundsOf = (data: Float32Array, count: number): Bounds3 => {
  if (count <= 0) return { ...EMPTY_BOUNDS3 };
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const o = i * POINT_FLOATS;
    const r = data[o + RADIUS_OFFSET];
    const x = data[o + POS_OFFSET];
    const y = data[o + POS_OFFSET + 1];
    const z = data[o + POS_OFFSET + 2];
    if (x - r < minX) minX = x - r;
    if (y - r < minY) minY = y - r;
    if (z - r < minZ) minZ = z - r;
    if (x + r > maxX) maxX = x + r;
    if (y + r > maxY) maxY = y + r;
    if (z + r > maxZ) maxZ = z + r;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
};

/** Diagonales de la caja, para culling y para estimar el tamaño en pantalla. */
export const boundsCenter = (b: Bounds3): { x: number; y: number; z: number } => ({
  x: (b.minX + b.maxX) * 0.5,
  y: (b.minY + b.maxY) * 0.5,
  z: (b.minZ + b.maxZ) * 0.5,
});

export const boundsRadius = (b: Bounds3): number => {
  const dx = (b.maxX - b.minX) * 0.5;
  const dy = (b.maxY - b.minY) * 0.5;
  const dz = (b.maxZ - b.minZ) * 0.5;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};
