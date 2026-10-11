/**
 * Planos de dibujo: sobre que superficie cae el trazo en el espacio.
 *
 * Es la pieza que Grease Pencil llama "Drawing Plane" y Feather resuelve con su
 * plano orientable. El problema que resuelve: en el aire, un trazo plano puede ir
 * tendido de infinitas formas, y sin decidir cual, dibujar "funciona" pero no se
 * controla. Fijar el plano es lo que convierte el boceto espacial en algo
 * dirigible.
 *
 * Cinco modos, calcados de los que de verdad se usan:
 *
 *  - **Vista**: el plano mira a la camara, a la profundidad del punto de mira. Es
 *    el de por defecto -lo que ya habia- y el que no obliga a pensar: el trazo
 *    aparece bajo el cursor.
 *  - **Frente / Lado / Planta**: los tres planos del mundo. Dibujar un alzado, un
 *    perfil o una planta sin tener que orientar la camara a mano.
 *  - **Cursor**: un plano que pasa por el punto de anclaje y mira a la camara. Es
 *    el "3D Cursor" de Blender: se marca un punto y se dibuja a su altura.
 *
 * Todo es aritmetica de vectores, sin DOM ni WebGL, asi que la interseccion
 * rayo-plano -que es donde se cuela un signo cambiado y el trazo aparece detras
 * de la camara- queda cubierta por pruebas.
 */

import {
  DEFAULT_CAMERA_3D,
  eyeOf,
  forwardOf,
  rightOf,
  upOf,
  type Camera3DState,
} from "./camera3d";
import { FLOOR_Y } from "./snap";
import { normalize3, set3, v3, type V3 } from "./vec3";

export type DrawPlaneKind = "view" | "front" | "side" | "top" | "cursor";

export const DRAW_PLANE_LABELS: Record<DrawPlaneKind, string> = {
  view: "Hacia la cámara",
  front: "Frente (X-Y)",
  side: "Lado (Z-Y)",
  top: "Planta (X-Z)",
  cursor: "Ancla",
};

export const DRAW_PLANE_ORDER: DrawPlaneKind[] = ["view", "front", "side", "top", "cursor"];

/** Un plano: un punto por el que pasa y su normal unitaria. */
export interface Plane {
  point: V3;
  normal: V3;
}

/**
 * El plano de dibujo activo, a partir del modo y del estado.
 *
 * `depth` desplaza el plano de la vista hacia delante o atras; en los planos del
 * mundo no se usa, porque alli el plano ya esta fijado por un eje. `anchor` es el
 * punto del modo "cursor".
 *
 * El convenio del mundo de drawi es Y hacia arriba, asi que:
 *  - Frente es el plano X-Y, mirando a +Z.
 *  - Lado es el plano Z-Y, mirando a +X.
 *  - Planta es el plano X-Z (el suelo), mirando a +Y.
 */
export const drawPlane = (
  kind: DrawPlaneKind,
  cam: Camera3DState = DEFAULT_CAMERA_3D,
  opts: { depth?: number; anchor?: V3 | null } = {},
): Plane => {
  const depth = opts.depth ?? 0;

  switch (kind) {
    case "front":
      return { point: v3(0, 0, 0), normal: v3(0, 0, 1) };
    case "side":
      return { point: v3(0, 0, 0), normal: v3(1, 0, 0) };
    case "top":
      return { point: v3(0, FLOOR_Y, 0), normal: v3(0, 1, 0) };
    case "cursor": {
      // Pasa por el ancla y mira a la camara: dibujar a la altura del punto que se
      // ha marcado, con la orientacion comoda de la vista.
      const a = opts.anchor ?? v3(cam.px, cam.py, cam.pz);
      const n = forwardOf(cam, v3());
      return { point: { ...a }, normal: v3(-n.x, -n.y, -n.z) };
    }
    case "view":
    default: {
      // El de siempre: por el punto de mira, adelantado `depth`, mirando a la
      // camara. El trazo cae bajo el cursor a la profundidad a la que se mira.
      const f = forwardOf(cam, v3());
      const point = v3(cam.px + f.x * depth, cam.py + f.y * depth, cam.pz + f.z * depth);
      return { point, normal: v3(-f.x, -f.y, -f.z) };
    }
  }
};

/**
 * Rayo que sale del ojo por un punto de pantalla.
 *
 * `ndc` va de -1 a 1 con Y hacia arriba, el convenio de WebGL del que ya viene el
 * resto del proyecto. Se devuelve origen y direccion por separado para no asignar
 * en la ruta caliente del dibujado.
 */
export const screenRay = (
  cam: Camera3DState,
  ndcX: number,
  ndcY: number,
  aspect: number,
  origin: V3 = v3(),
  dir: V3 = v3(),
): { origin: V3; dir: V3 } => {
  eyeOf(cam, origin);
  const f = forwardOf(cam, v3());
  const r = rightOf(cam, v3());
  const u = upOf(cam, v3());
  const tanV = Math.tan(cam.fovY * 0.5);
  const tanH = tanV * Math.max(1e-4, aspect);

  set3(
    dir,
    f.x + r.x * (ndcX * tanH) + u.x * (ndcY * tanV),
    f.y + r.y * (ndcX * tanH) + u.y * (ndcY * tanV),
    f.z + r.z * (ndcX * tanH) + u.z * (ndcY * tanV),
  );
  normalize3(dir, dir);
  return { origin, dir };
};

/**
 * Interseccion de un punto de pantalla con el plano de dibujo.
 *
 * Devuelve `null` cuando el rayo es casi paralelo al plano -mirarlo de canto- o
 * cuando el plano queda detras de la camara: en los dos casos no hay un punto
 * razonable donde poner el trazo, y devolver uno cualquiera lo mandaria lejisimos.
 */
export const planePoint = (
  plane: Plane,
  cam: Camera3DState,
  ndcX: number,
  ndcY: number,
  aspect: number,
  out: V3 = v3(),
): V3 | null => {
  const o = v3();
  const d = v3();
  screenRay(cam, ndcX, ndcY, aspect, o, d);

  const n = plane.normal;
  const den = d.x * n.x + d.y * n.y + d.z * n.z;
  // Casi paralelo: el plano se ve de canto y no hay punto util.
  if (Math.abs(den) < 1e-6) return null;

  const px = plane.point.x - o.x;
  const py = plane.point.y - o.y;
  const pz = plane.point.z - o.z;
  const t = (px * n.x + py * n.y + pz * n.z) / den;
  if (t <= 0) return null;

  return set3(out, o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
};

/**
 * Normal del plano que un trazo debe guardar.
 *
 * Es la del plano sobre el que se dibujo, que es lo que `frames.ts` necesita para
 * tender la cinta plana en vez de retorcerla. Se extrae aqui para que el visor no
 * tenga que repetir el `switch`.
 */
export const planeNormalFor = (
  kind: DrawPlaneKind,
  cam: Camera3DState,
  anchor: V3 | null = null,
): V3 => drawPlane(kind, cam, { anchor }).normal;
