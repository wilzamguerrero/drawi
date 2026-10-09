/**
 * Edicion de trazos ya dibujados.
 *
 * Un trazo es inmutable, asi que editar no es tocar nada: es producir un trazo
 * NUEVO con el mismo id. Que el id se conserve es lo que permite que la escena
 * reescriba su hueco en el lote en vez de rehacerlo, y que el historial siga
 * compartiendo instantaneas por referencia.
 *
 * Lo que comparten el suavizado y el arrastre es esto: mover puntos y rehacer los
 * marcos. Los marcos hay que rehacerlos porque una cinta solo sabe mirar hacia
 * donde le dice la normal de cada punto, y esa normal se calculo para la forma
 * vieja; sin recalcularla, la cinta se retuerce al editarla. Por eso el trazo
 * guarda la normal del plano sobre el que se dibujo: sin ella, el recalculo
 * daria una orientacion distinta y el trazo cambiaria de aspecto al retocarlo.
 */

import { clamp01 } from "../core/math";
import { computeFrames } from "./frames";
import { boundsOf, POINT_FLOATS, POS_OFFSET, RADIUS_OFFSET, type Stroke3D } from "./types";
import { v3, type V3 } from "./vec3";

export interface RelaxOptions {
  /** 0..1: cuanto se acerca cada punto a la media de sus dos vecinos. */
  strength: number;
  /** Pasadas. Mas de dos apenas se notan y redondean de mas. */
  iterations: number;
  /** Suaviza tambien el ancho del trazo, no solo su camino. */
  radius: boolean;
  /** Mueve tambien los extremos. Por defecto no: al suavizar, el trazo no debe
   *  encogerse por los cabos. */
  ends: boolean;
}

export const DEFAULT_RELAX: RelaxOptions = {
  strength: 0.5,
  iterations: 1,
  radius: false,
  ends: false,
};

/**
 * Cierra una edicion: rehace los marcos y la caja envolvente del trazo nuevo.
 *
 * La caja es derivada y dejarla vieja daria un trazo que se descarta mal al hacer
 * culling; los marcos hay que rehacerlos porque la cinta se orienta con ellos y
 * estan calculados para la forma anterior.
 */
const rebuild = (stroke: Stroke3D, data: Float32Array): Stroke3D => {
  const count = stroke.count;
  computeFrames(data, count, stroke.planeNormal);
  return {
    id: stroke.id,
    brush: stroke.brush,
    color: stroke.color,
    layerId: stroke.layerId,
    data,
    count,
    bounds: boundsOf(data, count),
    seed: stroke.seed,
    planeNormal: stroke.planeNormal ? { ...stroke.planeNormal } : null,
  };
};

/**
 * Relaja el trazo acercando cada punto a la media de sus vecinos.
 *
 * Es un suavizado laplaciano de una pasada por iteracion. Se hace sobre una copia
 * y se lee siempre de la copia ORIGINAL de esa pasada -no de la que se va
 * escribiendo-, porque encadenar las lecturas sobre el resultado haria que el
 * trazo se arrastrase hacia donde va escribiendo el bucle y la curva se desviaria.
 */
export const relaxStroke = (stroke: Stroke3D, opts: RelaxOptions = DEFAULT_RELAX): Stroke3D | null => {
  const count = stroke.count;
  if (count < 3) return null;

  const strength = clamp01(opts.strength);
  if (strength <= 0) return null;
  const iterations = Math.max(1, Math.round(opts.iterations));

  const data = stroke.data.slice(0, count * POINT_FLOATS);
  let prev = data.slice();

  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < count; i++) {
      // Los cabos se quedan donde estan: relajar un extremo lo mete hacia dentro y
      // el trazo encoge por los dos lados en cada pasada.
      if ((i === 0 || i === count - 1) && !opts.ends) continue;

      const a = (i > 0 ? i - 1 : i) * POINT_FLOATS;
      const b = (i < count - 1 ? i + 1 : i) * POINT_FLOATS;
      const o = i * POINT_FLOATS;

      for (let k = 0; k < 3; k++) {
        const media = (prev[a + POS_OFFSET + k] + prev[b + POS_OFFSET + k]) * 0.5;
        data[o + POS_OFFSET + k] = prev[o + POS_OFFSET + k] + (media - prev[o + POS_OFFSET + k]) * strength;
      }
      if (opts.radius) {
        const media = (prev[a + RADIUS_OFFSET] + prev[b + RADIUS_OFFSET]) * 0.5;
        data[o + RADIUS_OFFSET] =
          prev[o + RADIUS_OFFSET] + (media - prev[o + RADIUS_OFFSET]) * strength;
      }
    }
    prev = data.slice();
  }

  return rebuild(stroke, data);
};

/** ¿Tiene algun punto dentro del radio? Sirve para descartar trazos enteros sin
 *  copiar ni un float. */
export const touches = (stroke: Stroke3D, center: V3, radius: number): boolean => {
  if (radius <= 0) return false;
  const r2 = radius * radius;
  for (let i = 0; i < stroke.count; i++) {
    const o = i * POINT_FLOATS + POS_OFFSET;
    const dx = stroke.data[o] - center.x;
    const dy = stroke.data[o + 1] - center.y;
    const dz = stroke.data[o + 2] - center.z;
    if (dx * dx + dy * dy + dz * dz <= r2) return true;
  }
  return false;
};

/** Centro de un trazo, para pruebas y para encuadres. */
export const centerOf = (stroke: Stroke3D, out: V3 = v3()): V3 => {
  const b = stroke.bounds;
  out.x = (b.minX + b.maxX) * 0.5;
  out.y = (b.minY + b.maxY) * 0.5;
  out.z = (b.minZ + b.maxZ) * 0.5;
  return out;
};
