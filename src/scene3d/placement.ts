/**
 * Colocación del trazo: a qué profundidad cae lo que se dibuja.
 *
 * Es el "Stroke Placement" de Grease Pencil, y es un eje distinto del plano de
 * dibujo. El plano decide hacia dónde MIRA la superficie sobre la que se traza;
 * la colocación decide DÓNDE está esa superficie en profundidad:
 *
 *  - **Plano**: el plano de dibujo tal cual -su orientación y su profundidad-. Es
 *    lo de siempre y el que no obliga a pensar.
 *  - **Origen**: el plano se mueve para pasar por el origen del mundo. Dibujar
 *    siempre a la misma altura de referencia, se mire como se mire.
 *  - **Ancla**: pasa por el punto marcado (el "3D Cursor"). Dibujar a la altura de
 *    un punto que se ha fijado.
 *  - **Trazo**: la profundidad de cada punto se toma del trazo que haya debajo del
 *    cursor; donde no hay ninguno, cae al plano. Es lo que permite seguir dibujando
 *    "pegado" a lo ya hecho sin que el nuevo trazo se vaya a otra profundidad.
 *
 * `Superficie` -proyectar sobre un objeto- queda fuera a propósito: no hay objetos
 * todavía. Entra con las primitivas, y hasta entonces listarlo sería prometer algo
 * que no hace nada.
 *
 * Todo es aritmética de rayos y puntos, sin DOM ni WebGL, así que la parte que
 * falla en silencio -de qué trazo se toma la profundidad, y a cuál- queda cubierta
 * por pruebas.
 */

import { eyeOf, forwardOf, type Camera3DState } from "./camera3d";
import { endpointsOf } from "./snap";
import { POINT_FLOATS, POS_OFFSET, type Stroke3D } from "./types";
import { normalize3, set3, sub3, v3, type V3 } from "./vec3";

export type StrokePlacement = "plane" | "origin" | "cursor" | "stroke";

export const PLACEMENT_LABELS: Record<StrokePlacement, string> = {
  plane: "En el plano",
  origin: "Origen",
  cursor: "Ancla",
  stroke: "Sobre el trazo",
};

export const PLACEMENT_ORDER: StrokePlacement[] = ["plane", "origin", "cursor", "stroke"];

/** Qué puntos de los trazos existentes sirven de referencia en modo "trazo". */
export type StrokeTarget = "all" | "ends" | "first";

export const STROKE_TARGET_LABELS: Record<StrokeTarget, string> = {
  all: "Todos los puntos",
  ends: "Los extremos",
  first: "El primer punto",
};

export const STROKE_TARGET_ORDER: StrokeTarget[] = ["all", "ends", "first"];

export interface PlacementSettings {
  mode: StrokePlacement;
  /** Puntos de referencia en modo "trazo". */
  target: StrokeTarget;
  /** Radio de captura, en unidades de mundo, para el modo "trazo". */
  radius: number;
}

export const DEFAULT_PLACEMENT: PlacementSettings = {
  mode: "plane",
  target: "all",
  radius: 40,
};

/**
 * Profundidad del trazo bajo el cursor, tomada de los trazos existentes.
 *
 * Devuelve la distancia `t` a lo largo del rayo del punto de referencia más
 * cercano al rayo -el que está "debajo del cursor"- dentro del radio de captura, o
 * `null` si no hay ninguno. Esa `t` es la profundidad: el punto nuevo se pone en
 * `eye + dir * t`, a la misma distancia de la cámara que aquello a lo que se pega.
 *
 * `target` filtra qué puntos cuentan:
 *  - `all`: todos los de cada trazo.
 *  - `ends`: solo los dos extremos.
 *  - `first`: solo el primer punto.
 *
 * La cercanía se mide como distancia perpendicular del punto al rayo, no en
 * pantalla: es geometría pura y se prueba sin cámara de proyección.
 */
export const strokeDepthAt = (
  strokes: readonly Stroke3D[],
  eye: V3,
  dir: V3,
  radius: number,
  target: StrokeTarget,
): number | null => {
  let bestT: number | null = null;
  let bestPerp = radius;

  const probar = (px: number, py: number, pz: number): void => {
    // Proyección del punto sobre el rayo: `t` es cuánto hay que avanzar desde el
    // ojo, y el punto más cercano del rayo es `eye + dir * t`.
    const vx = px - eye.x;
    const vy = py - eye.y;
    const vz = pz - eye.z;
    const t = vx * dir.x + vy * dir.y + vz * dir.z;
    if (t <= 0) return; // detrás de la cámara: no cuenta
    const cx = eye.x + dir.x * t;
    const cy = eye.y + dir.y * t;
    const cz = eye.z + dir.z * t;
    const perp = Math.hypot(px - cx, py - cy, pz - cz);
    if (perp <= bestPerp) {
      bestPerp = perp;
      bestT = t;
    }
  };

  for (const stroke of strokes) {
    if (target === "first") {
      probar(stroke.data[POS_OFFSET], stroke.data[POS_OFFSET + 1], stroke.data[POS_OFFSET + 2]);
      continue;
    }
    if (target === "ends") {
      for (const c of endpointsOf(stroke)) probar(c.point.x, c.point.y, c.point.z);
      continue;
    }
    // all
    for (let i = 0; i < stroke.count; i++) {
      const o = i * POINT_FLOATS + POS_OFFSET;
      probar(stroke.data[o], stroke.data[o + 1], stroke.data[o + 2]);
    }
  }

  return bestT;
};

/**
 * Punto donde cae el trazo, resolviendo la colocación sobre un plano ya orientado.
 *
 * `planePoint`/`planeNormal` describen el plano de dibujo -su orientación la fija
 * el otro eje-, y esta función solo lo DESPLAZA en profundidad según el modo:
 *
 *  - `origin`: lo mueve para que pase por el origen.
 *  - `cursor`: para que pase por el ancla.
 *  - `plane` y `stroke`: no lo tocan (en `stroke`, la profundidad por trazo se
 *    resuelve aparte, y este plano es solo el respaldo donde no hay trazo).
 *
 * Devuelve el punto por el que debe pasar el plano, con la misma normal.
 */
export const placedPlanePoint = (
  mode: StrokePlacement,
  basePoint: V3,
  anchor: V3 | null,
  out: V3 = v3(),
): V3 => {
  if (mode === "origin") return set3(out, 0, 0, 0);
  if (mode === "cursor" && anchor) return set3(out, anchor.x, anchor.y, anchor.z);
  return set3(out, basePoint.x, basePoint.y, basePoint.z);
};

/**
 * Rayo que sale del ojo por un punto de pantalla.
 *
 * Se reexpone aquí -calcado del de `drawplane.ts`- para que el visor pueda pedir
 * la profundidad del modo "trazo" sin montar el plano, y para poder probar
 * `strokeDepthAt` con un rayo construido a mano.
 */
export const cameraRay = (
  cam: Camera3DState,
  dir: V3,
  origin: V3 = v3(),
): { origin: V3; dir: V3 } => {
  eyeOf(cam, origin);
  normalize3(dir, dir);
  return { origin, dir };
};

/** Direccion normalizada del ojo al punto de mira: el rayo del centro. */
export const forwardRay = (cam: Camera3DState, out: V3 = v3()): V3 => forwardOf(cam, out);

/** Punto a profundidad `t` por un rayo. */
export const alongRay = (eye: V3, dir: V3, t: number, out: V3 = v3()): V3 =>
  set3(out, eye.x + dir.x * t, eye.y + dir.y * t, eye.z + dir.z * t);

/** Distancia de un punto a la cámara, a lo largo de la mirada. Para pruebas. */
export const depthOf = (cam: Camera3DState, p: V3): number => {
  const eye = eyeOf(cam, v3());
  const f = forwardOf(cam, v3());
  const d = sub3(p, eye, v3());
  return d.x * f.x + d.y * f.y + d.z * f.z;
};
