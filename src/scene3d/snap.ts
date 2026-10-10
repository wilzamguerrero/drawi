/**
 * Ajuste del trazo: de donde toma el punto de partida, hacia donde sale y a que
 * esta restringido.
 *
 * Es un modulo puro y sin DOM a proposito. Encadenar trazos, forzar un eje o
 * enganchar a la rejilla son operaciones geometricas que fallan en silencio -el
 * trazo sale *casi* donde deberia-, y esa es justo la clase de fallo que conviene
 * tener cubierta por pruebas en vez de descubrirla mirando la pantalla.
 *
 * Hay tres decisiones que conviene tener separadas, porque son independientes:
 *
 *  1. **De donde sale el trazo**: de un extremo de otro trazo, de un punto de la
 *     rejilla, o de un anclaje fijo.
 *  2. **A que esta restringido**: a un eje del mundo o de la vista.
 *  3. **Con que direccion arranca**: la que trae el gesto, o la tangente del trazo
 *     al que se ha encadenado, mezcladas a lo largo de los primeros milimetros.
 *
 * Mezclarlas en una sola funcion haria imposible decir cual de las tres esta mal
 * cuando el resultado no cuadra.
 */

import { clamp01 } from "../core/math";
import { DEFAULT_CAMERA_3D, forwardOf, rightOf, upOf, type Camera3DState } from "./camera3d";
import { POINT_FLOATS, POS_OFFSET, type Stroke3D } from "./types";
import { normalize3, set3, sub3, v3, type V3 } from "./vec3";

/** Plano del suelo. El mundo de drawi tiene Y hacia arriba y el suelo en cero. */
export const FLOOR_Y = 0;

/** De donde engancha el punto de partida del trazo nuevo. */
export type SnapSource = "off" | "strokes" | "grid" | "anchor";

export const SNAP_LABELS: Record<SnapSource, string> = {
  off: "Libre",
  strokes: "Trazos",
  grid: "Rejilla",
  anchor: "Anclaje",
};

/** Orden de las opciones en la interfaz: de menos a mas atadura. */
export const SNAP_SOURCE_ORDER: SnapSource[] = ["off", "strokes", "grid", "anchor"];

/** Que extremo de un trazo se toma cuando hay varios candidatos. */
export type SnapPick = "last" | "nearest";

export const SNAP_PICK_LABELS: Record<SnapPick, string> = {
  last: "El ultimo trazo",
  nearest: "El mas cercano",
};

/** Restriccion de direccion. `view-*` son los ejes de la camara, no los del mundo. */
export type SnapAxis = "none" | "world-x" | "world-y" | "world-z" | "view-x" | "view-y" | "view-z";

export const SNAP_AXIS_LABELS: Record<SnapAxis, string> = {
  none: "Sin restringir",
  "world-x": "Eje X",
  "world-y": "Eje Y (vertical)",
  "world-z": "Eje Z",
  "view-x": "Horizontal de la vista",
  "view-y": "Vertical de la vista",
  "view-z": "Profundidad de la vista",
};

export const SNAP_AXIS_ORDER: SnapAxis[] = [
  "none",
  "world-x",
  "world-y",
  "world-z",
  "view-x",
  "view-y",
  "view-z",
];

export interface SnapSettings {
  source: SnapSource;
  pick: SnapPick;
  /** Radio de captura, en unidades de mundo. */
  radius: number;
  /** Al encadenar, se mezcla la tangente del trazo enganchado. */
  tangent: boolean;
  /** Longitud sobre la que se mezcla esa tangente, en unidades de mundo. */
  tangentBlend: number;
  axis: SnapAxis;
  /** Paso de la rejilla del suelo, en unidades de mundo. */
  gridStep: number;
  /** Punto de anclaje fijo. Solo se usa con `source: "anchor"`. */
  anchor: V3 | null;
}

export const DEFAULT_SNAP: SnapSettings = {
  source: "off",
  pick: "nearest",
  radius: 30,
  tangent: true,
  tangentBlend: 60,
  axis: "none",
  gridStep: 50,
  anchor: null,
};

/** Un extremo de trazo al que se puede encadenar. */
export interface SnapCandidate {
  strokeId: string;
  /** Punto del extremo. */
  point: V3;
  /**
   * Direccion con la que el trazo LLEGA a ese extremo (hacia fuera).
   *
   * Es la que da continuidad: para que la union no haga pico, el trazo nuevo tiene
   * que salir alineado con ella. Se guarda ya normalizada, o en cero si el trazo
   * no tiene direccion (un punto suelto).
   */
  tangent: V3;
}

/** Resultado de resolver el arranque de un trazo. */
export interface SnapResult {
  point: V3;
  /** Tangente a la que hay que salir, o `null` si no hay ninguna que respetar. */
  tangent: V3 | null;
  /** Que lo provoco, para poder enseñarlo en la interfaz. */
  kind: "free" | "stroke-end" | "grid" | "anchor";
}

const pointAt = (stroke: Stroke3D, i: number, out: V3 = v3()): V3 => {
  const o = i * POINT_FLOATS + POS_OFFSET;
  return set3(out, stroke.data[o], stroke.data[o + 1], stroke.data[o + 2]);
};

/**
 * Extremos de un trazo, con la direccion con la que llega a cada uno.
 *
 * La tangente se toma sobre los ultimos puntos y no sobre el ultimo par: en un
 * trazo decimado, los dos ultimos puntos pueden estar muy juntos y su direccion
 * salta con cualquier ruido. Se busca hacia atras el primer punto que este lo
 * bastante lejos como para dar una direccion que signifique algo.
 */
export const endpointsOf = (stroke: Stroke3D): SnapCandidate[] => {
  const n = stroke.count;
  if (n < 2) return [];

  const out: SnapCandidate[] = [];
  const ultimo = pointAt(stroke, n - 1);
  const primero = pointAt(stroke, 0);

  // La distancia minima para fiarse de la direccion: una fraccion del tramo
  // total, con un suelo para trazos muy cortos.
  let largo = 0;
  for (let i = 1; i < n; i++) {
    const a = pointAt(stroke, i - 1);
    const b = pointAt(stroke, i);
    largo += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const minimo = Math.max(1e-3, largo * 0.1);

  const direccionHacia = (extremo: number, paso: number): V3 => {
    const ancla = pointAt(stroke, extremo);
    for (let i = extremo + paso; i >= 0 && i < n; i += paso) {
      const p = pointAt(stroke, i);
      const d = sub3(ancla, p, v3());
      const l = Math.hypot(d.x, d.y, d.z);
      if (l >= minimo) return normalize3(d, d) > 0 ? d : v3();
    }
    return v3();
  };

  // En el final, la tangente "hacia fuera" es la direccion de llegada; en el
  // principio, la contraria, para que en los dos casos apunte hacia donde seguia
  // el trazo.
  out.push({ strokeId: stroke.id, point: primero, tangent: direccionHacia(0, 1) });
  out.push({ strokeId: stroke.id, point: ultimo, tangent: direccionHacia(n - 1, -1) });
  return out;
};

/** Distancia de `p` al candidato, para elegir el mas cercano. */
const distTo = (p: V3, c: V3): number => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);

/**
 * Elige a que extremo encadenar.
 *
 * `onlyStrokeId` deja fuera los extremos del trazo que se acaba de dibujar. Es lo
 * que evita el caso tonto de encadenar un trazo consigo mismo, que solo puede
 * pasar si el gesto empieza donde termino el anterior.
 */
/**
 * Elige a que extremo encadenar.
 *
 * `pick` decide que significa "el bueno" cuando hay varios a tiro:
 *
 *  - `nearest`: el extremo mas cercano al puntero, de cualquier trazo.
 *  - `last`: el del trazo mas RECIENTE que tenga un extremo a tiro. Es "sigue por
 *    donde ibas": si el ultimo no llega, se mira el anterior, porque el radio ya
 *    dice que se quiere enganchar a algo. Lo que cambia respecto a `nearest` es
 *    quien gana cuando hay varios dentro del radio: el mas nuevo, no el mas cerca.
 *
 * `onlyStrokeId` deja fuera un trazo -el que se acaba de dibujar-, que es lo que
 * evita el caso tonto de encadenar un trazo consigo mismo.
 */
export const pickCandidate = (
  strokes: readonly Stroke3D[],
  p: V3,
  opts: { pick: SnapPick; radius: number; onlyStrokeId?: string | null },
): SnapCandidate | null => {
  const elegible = (s: Stroke3D): boolean => !opts.onlyStrokeId || s.id !== opts.onlyStrokeId;

  if (opts.pick === "last") {
    // Del final hacia atras: el primer trazo elegible con un extremo a tiro es el
    // mas reciente que sirve.
    for (let i = strokes.length - 1; i >= 0; i--) {
      const stroke = strokes[i];
      if (!elegible(stroke)) continue;
      let mejor: SnapCandidate | null = null;
      let mejorD = opts.radius;
      for (const c of endpointsOf(stroke)) {
        const d = distTo(p, c.point);
        if (d <= mejorD) {
          mejorD = d;
          mejor = c;
        }
      }
      if (mejor) return mejor;
    }
    return null;
  }

  let best: SnapCandidate | null = null;
  let bestDist = opts.radius;
  for (const stroke of strokes) {
    if (!elegible(stroke)) continue;
    for (const c of endpointsOf(stroke)) {
      const d = distTo(p, c.point);
      if (d <= bestDist) {
        bestDist = d;
        best = c;
      }
    }
  }
  return best;
};

/** Un punto enganchado a la rejilla del suelo. */
export const snapToGrid = (p: V3, step: number): V3 => {
  if (step <= 0) return { ...p };
  return v3(Math.round(p.x / step) * step, FLOOR_Y, Math.round(p.z / step) * step);
};

/** Direccion unitaria de un eje, o `null` si no hay restriccion. */
export const axisDirection = (
  axis: SnapAxis,
  cam: Camera3DState = DEFAULT_CAMERA_3D,
  out: V3 = v3(),
): V3 | null => {
  switch (axis) {
    case "none":
      return null;
    case "world-x":
      return set3(out, 1, 0, 0);
    case "world-y":
      return set3(out, 0, 1, 0);
    case "world-z":
      return set3(out, 0, 0, 1);
    // Los de la vista son los de la camara AHORA. Por eso son utiles para
    // dibujar: "horizontal en pantalla" no coincide con ningun eje del mundo en
    // cuanto se orbita un poco.
    case "view-x":
      return rightOf(cam, out);
    case "view-y":
      return upOf(cam, out);
    case "view-z":
      return forwardOf(cam, out);
  }
};

/**
 * Lleva `to` a la recta que pasa por `from` con la direccion `dir`.
 *
 * Es una proyeccion, no un redondeo: el punto se queda en la recta pero conserva
 * el avance que traia. Redondear a multiplos daria un trazo a saltos.
 */
export const constrainToAxis = (from: V3, to: V3, dir: V3 | null): V3 => {
  if (!dir) return { ...to };
  const d = sub3(to, from, v3());
  const t = d.x * dir.x + d.y * dir.y + d.z * dir.z;
  return v3(from.x + dir.x * t, from.y + dir.y * t, from.z + dir.z * t);
};

/**
 * Mezcla la direccion de salida con la tangente del trazo enganchado.
 *
 * Se usa para que la union quede tangente en vez de en pico. `travelled` es lo que
 * lleva recorrido el trazo nuevo: el peso de la tangente cae de `strength` a cero
 * a lo largo de `blend` unidades, de modo que el trazo nace alineado y luego hace
 * lo que pida la mano.
 *
 * Devuelve el punto corregido, no solo la direccion: rotar la direccion sin mover
 * el punto dejaria el trazo arrancando en el sitio equivocado.
 */
export const blendTangent = (
  anchor: V3,
  point: V3,
  tangent: V3 | null,
  travelled: number,
  blend: number,
  strength = 1,
): V3 => {
  if (!tangent || blend <= 0 || strength <= 0) return { ...point };

  const d = sub3(point, anchor, v3());
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-6) return { ...point };
  normalize3(d, d);

  const w = clamp01(1 - travelled / blend) * clamp01(strength);
  if (w <= 0) return { ...point };

  // Mezcla de direcciones y renormalizacion: interpolar los componentes y
  // normalizar da el arco mas corto entre las dos, que es lo que se quiere.
  const mx = d.x * (1 - w) + tangent.x * w;
  const my = d.y * (1 - w) + tangent.y * w;
  const mz = d.z * (1 - w) + tangent.z * w;
  const ml = Math.hypot(mx, my, mz);
  if (ml < 1e-6) return { ...point };

  return v3(
    anchor.x + (mx / ml) * len,
    anchor.y + (my / ml) * len,
    anchor.z + (mz / ml) * len,
  );
};

/**
 * Resuelve donde empieza el trazo y con que direccion sale.
 *
 * Ojo con lo que **no** hace: no aplica la restriccion de eje al punto de
 * arranque. El eje manda sobre los puntos SIGUIENTES, no sobre el primero; si
 * moviera el arranque, encadenar a un extremo y forzar un eje a la vez perderia
 * el encadenaje -el punto se iria a la recta del eje y dejaria de tocar el trazo
 * anterior-. Quien dibuja es quien aplica el eje, tomando este punto como origen.
 */
export const resolveStart = (
  p: V3,
  settings: SnapSettings,
  strokes: readonly Stroke3D[],
  cam: Camera3DState = DEFAULT_CAMERA_3D,
  onlyStrokeId: string | null = null,
): SnapResult => {
  void cam;
  let point: V3 = { ...p };
  let tangent: V3 | null = null;
  let kind: SnapResult["kind"] = "free";

  if (settings.source === "strokes") {
    const c = pickCandidate(strokes, p, {
      pick: settings.pick,
      radius: settings.radius,
      onlyStrokeId,
    });
    if (c) {
      point = { ...c.point };
      // La tangente solo vale si la hay: un trazo con los extremos casi pegados no
      // da direccion, y salir "alineado" con un vector cero torceria el trazo.
      const hay = Math.hypot(c.tangent.x, c.tangent.y, c.tangent.z) > 0.5;
      tangent = settings.tangent && hay ? { ...c.tangent } : null;
      kind = "stroke-end";
    }
  } else if (settings.source === "grid") {
    point = snapToGrid(p, settings.gridStep);
    kind = "grid";
  } else if (settings.source === "anchor" && settings.anchor) {
    point = { ...settings.anchor };
    kind = "anchor";
  }

  return { point, tangent, kind };
};
