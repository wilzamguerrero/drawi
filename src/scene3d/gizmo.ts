/**
 * Gizmo de transformacion: la matematica de arrastrar ejes para mover, rotar y
 * escalar un objeto en el espacio, al estilo de Blender.
 *
 * Lo que hace falta entender es que un gizmo es, en el fondo, DOS proyecciones:
 *
 *  1. Al agarrar un eje, se proyecta el rayo del cursor sobre ese eje y se guarda
 *     dónde cayó. Es el punto de partida.
 *  2. En cada movimiento, se proyecta otra vez y se mira cuánto se ha corrido a lo
 *     largo del eje. Esa diferencia es lo que se aplica.
 *
 * Hacerlo así -y no "mover el objeto hacia donde va el ratón"- es lo que hace que
 * el eje agarrado se quede pegado al cursor por mucho que la cámara esté girada:
 * el objeto se mueve exactamente lo que se mueve el cursor PROYECTADO sobre el eje.
 *
 * Todo es aritmética sin DOM ni WebGL, así que el picking y las tres operaciones
 * quedan cubiertos por pruebas. El dibujo del gizmo -las flechas y los aros- vive
 * en el backend; esto solo dice qué eje hay bajo el cursor y cuánto transformar.
 */

import {
  cross3,
  dot3,
  len3,
  normalize3,
  set3,
  sub3,
  v3,
  type V3,
} from "./vec3";
import type { Transform3D } from "./objects";

/** El modo del gizmo: las tres transformaciones de siempre. */
export type GizmoMode = "move" | "rotate" | "scale";

export const GIZMO_MODE_LABELS: Record<GizmoMode, string> = {
  move: "Mover",
  rotate: "Rotar",
  scale: "Escalar",
};

export const GIZMO_MODE_ORDER: GizmoMode[] = ["move", "rotate", "scale"];

/** Un eje del gizmo. `screen` es el aro de rotacion que mira a la camara. */
export type GizmoAxis = "x" | "y" | "z";

export const AXIS_VECTORS: Record<GizmoAxis, V3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

export const AXIS_COLORS: Record<GizmoAxis, number> = {
  // Las de Blender: X rojo, Y verde, Z azul.
  x: 0xd6454f,
  y: 0x5fae5f,
  z: 0x4f8fd0,
};

/** Rayo del mundo: origen y direccion unitaria. */
export interface Ray {
  origin: V3;
  dir: V3;
}

/**
 * Punto del rayo mas cercano a una recta (el eje), y viceversa.
 *
 * Es el nucleo del gizmo de mover y de escalar: resuelve "si el cursor lanza este
 * rayo, en que punto del eje esta mirando". Devuelve el parametro `s` a lo largo
 * del eje -que es lo que se compara entre el agarre y el ahora- y la distancia
 * entre las dos rectas, que sirve para el picking.
 *
 * La formula es la del segmento mas corto entre dos rectas; el caso degenerado
 * (rectas paralelas) se trata aparte para no dividir por cero.
 */
export const closestOnAxis = (
  ray: Ray,
  axisPoint: V3,
  axisDir: V3,
): { s: number; dist: number } => {
  const d1 = ray.dir;
  const d2 = axisDir;
  const r = sub3(ray.origin, axisPoint, v3());

  const a = dot3(d1, d1);
  const b = dot3(d1, d2);
  const c = dot3(d2, d2);
  const d = dot3(d1, r);
  const e = dot3(d2, r);

  const den = a * c - b * b;
  let s: number;
  if (Math.abs(den) < 1e-9) {
    // Rayo paralelo al eje: no hay un punto unico. Se proyecta el origen del rayo
    // sobre el eje y punto, que es el limite razonable.
    s = c > 1e-9 ? e / c : 0;
  } else {
    // s recorre el eje; el otro parametro recorreria el rayo, no hace falta.
    s = (a * e - b * d) / den;
  }

  // Punto del eje y punto del rayo mas cercanos, para medir cuanto se alejan.
  const onAxis = set3(v3(), axisPoint.x + d2.x * s, axisPoint.y + d2.y * s, axisPoint.z + d2.z * s);
  const tRay = (dot3(d1, sub3(onAxis, ray.origin, v3()))) / Math.max(1e-9, a);
  const onRay = set3(v3(), ray.origin.x + d1.x * tRay, ray.origin.y + d1.y * tRay, ray.origin.z + d1.z * tRay);
  return { s, dist: len3(sub3(onAxis, onRay, v3())) };
};

/**
 * Interseccion de un rayo con un plano. `null` si son casi paralelos.
 *
 * El gizmo de rotar lo usa: cada eje de rotacion define un plano -el perpendicular
 * a el, que pasa por el centro-, y el angulo se mide sobre ese plano.
 */
export const rayPlane = (ray: Ray, planePoint: V3, planeNormal: V3): V3 | null => {
  const den = dot3(ray.dir, planeNormal);
  if (Math.abs(den) < 1e-6) return null;
  const t = dot3(sub3(planePoint, ray.origin, v3()), planeNormal) / den;
  if (t <= 0) return null;
  return set3(v3(), ray.origin.x + ray.dir.x * t, ray.origin.y + ray.dir.y * t, ray.origin.z + ray.dir.z * t);
};

/**
 * Que eje hay bajo el cursor, al agarrar.
 *
 * Para mover y escalar, el eje cuyo cuerpo pasa mas cerca del rayo, dentro de una
 * tolerancia relativa al tamano del gizmo. Para rotar, el aro cuyo plano corta el
 * rayo a un radio parecido al del aro. Devuelve `null` si no hay ninguno a tiro:
 * entonces el gesto no es del gizmo.
 */
export const pickAxis = (
  mode: GizmoMode,
  ray: Ray,
  center: V3,
  size: number,
): GizmoAxis | null => {
  const tol = size * 0.18;

  if (mode === "rotate") {
    let best: GizmoAxis | null = null;
    let bestErr = tol;
    for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
      const hit = rayPlane(ray, center, AXIS_VECTORS[axis]);
      if (!hit) continue;
      // El aro tiene radio `size`: lo que importa es cuanto se desvia el corte de
      // ese radio.
      const err = Math.abs(len3(sub3(hit, center, v3())) - size);
      if (err < bestErr) {
        bestErr = err;
        best = axis;
      }
    }
    return best;
  }

  // Mover y escalar: el eje mas cercano al rayo cuyo punto de contacto cae dentro
  // del brazo del gizmo (entre el centro y `size`, con algo de margen).
  let best: GizmoAxis | null = null;
  let bestDist = tol;
  for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
    const { s, dist } = closestOnAxis(ray, center, AXIS_VECTORS[axis]);
    if (s < -tol || s > size + tol) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = axis;
    }
  }
  return best;
};

/** Estado que se guarda al agarrar un eje, para medir el arrastre contra el. */
export interface GizmoGrab {
  mode: GizmoMode;
  axis: GizmoAxis;
  /** Transformacion del objeto al empezar: todo se aplica sobre ella, no acumulado. */
  start: Transform3D;
  /** Centro del gizmo (la posicion del objeto). */
  center: V3;
  /** Parametro inicial a lo largo del eje (mover/escalar). */
  s0: number;
  /** Angulo inicial sobre el plano del eje (rotar). */
  angle0: number;
}

/** Comienza un arrastre: fotografia el punto de partida sobre el eje. */
export const beginGizmo = (
  mode: GizmoMode,
  axis: GizmoAxis,
  transform: Transform3D,
  ray: Ray,
): GizmoGrab => {
  const center = { ...transform.position };
  const dir = AXIS_VECTORS[axis];
  const grab: GizmoGrab = {
    mode,
    axis,
    start: {
      position: { ...transform.position },
      rotation: { ...transform.rotation },
      scale: { ...transform.scale },
    },
    center,
    s0: 0,
    angle0: 0,
  };
  if (mode === "rotate") {
    grab.angle0 = angleOnPlane(ray, center, dir) ?? 0;
  } else {
    grab.s0 = closestOnAxis(ray, center, dir).s;
  }
  return grab;
};

/** Angulo del cursor sobre el plano perpendicular a un eje, medido desde una
 *  referencia fija. `null` si el rayo no corta el plano. */
const angleOnPlane = (ray: Ray, center: V3, axis: V3): number | null => {
  const hit = rayPlane(ray, center, axis);
  if (!hit) return null;
  const radial = sub3(hit, center, v3());
  // Dos vectores del plano para medir el angulo: una perpendicular cualquiera al
  // eje, y su producto cruzado con el eje. El angulo sale consistente mientras no
  // cambie la referencia, que es lo unico que importa -se mide un DELTA-.
  const u = perpOf(axis);
  const w = cross3(axis, u, v3());
  return Math.atan2(dot3(radial, w), dot3(radial, u));
};

/** Una perpendicular estable a un eje unitario. */
const perpOf = (axis: V3): V3 => {
  // Se cruza con el eje del mundo menos alineado, para que nunca salga degenerado.
  const ref = Math.abs(axis.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const out = cross3(axis, ref, v3());
  normalize3(out, out);
  return out;
};

/**
 * La transformacion resultante de arrastrar el cursor hasta `ray`.
 *
 * Se aplica SIEMPRE sobre `grab.start`, no sobre la transformacion actual: asi el
 * arrastre es absoluto -volver al punto de partida devuelve el objeto a su sitio-
 * y no se acumula el error de muchos fotogramas.
 */
export const dragGizmo = (grab: GizmoGrab, ray: Ray): Transform3D => {
  const out: Transform3D = {
    position: { ...grab.start.position },
    rotation: { ...grab.start.rotation },
    scale: { ...grab.start.scale },
  };
  const dir = AXIS_VECTORS[grab.axis];

  if (grab.mode === "move") {
    const s = closestOnAxis(ray, grab.center, dir).s;
    const delta = s - grab.s0;
    out.position = {
      x: grab.start.position.x + dir.x * delta,
      y: grab.start.position.y + dir.y * delta,
      z: grab.start.position.z + dir.z * delta,
    };
    return out;
  }

  if (grab.mode === "scale") {
    const s = closestOnAxis(ray, grab.center, dir).s;
    // El factor es cuanto ha crecido la distancia al centro a lo largo del eje.
    // Con un suelo para que no se pueda invertir ni colapsar a cero.
    const base = Math.max(1e-3, Math.abs(grab.s0));
    const factor = Math.max(0.02, (base + (s - grab.s0)) / base);
    const k = grab.axis;
    out.scale = { ...grab.start.scale };
    out.scale[k] = grab.start.scale[k] * factor;
    return out;
  }

  // rotate
  const angle = angleOnPlane(ray, grab.center, dir);
  if (angle !== null) {
    // El delta se lleva a [-PI, PI]: sin esto, cruzar la frontera de atan2 daria
    // un salto de casi una vuelta entera -el objeto giraria 270 grados en vez de
    // -90-. Rotar siempre toma el camino corto.
    let delta = angle - grab.angle0;
    delta = ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    out.rotation = { ...grab.start.rotation };
    out.rotation[grab.axis] += delta;
  }
  return out;
};

/**
 * Tamano del gizmo en unidades de mundo para que mida parecido en pantalla.
 *
 * Un gizmo de tamano fijo en el mundo se ve enorme de cerca y diminuto de lejos.
 * Se escala con la distancia a la camara para que ocupe mas o menos lo mismo
 * siempre, que es lo que hace que se pueda agarrar igual de bien a cualquier zoom.
 */
export const gizmoWorldSize = (distance: number, fraction = 0.14): number =>
  Math.max(1, distance * fraction);
