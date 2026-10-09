/**
 * Cámara orbital del visor 3D.
 *
 * Es estado puro, sin three.js y sin DOM, a proposito: la matematica de orbita es
 * justo la parte que se equivoca en silencio -arrastrar gira al reves, acercar
 * aleja, el "arriba" se voltea al pasar por el cenit- y conviene tenerla cubierta
 * por pruebas en lugar de descubrirla mirando la pantalla.
 *
 * El estado son cinco numeros: el punto al que se mira, la distancia y dos
 * angulos. La posicion del ojo se deriva de ellos, asi que no hay forma de que el
 * ojo y el punto de mira se desincronicen.
 */

import { clamp } from "../core/math";
import { frustumOf, type Frustum } from "./cull";
import { v3, type V3 } from "./vec3";

/** Angulo maximo de cabeceo: un pelo menos de 90 grados para que el arriba no se voltee. */
export const MAX_PITCH = Math.PI / 2 - 0.02;

export const MIN_DISTANCE = 0.5;
export const MAX_DISTANCE = 20000;

export interface Camera3DState {
  /** Punto al que mira la camara. */
  px: number;
  py: number;
  pz: number;
  /** Distancia del ojo al punto de mira. */
  distance: number;
  /** Giro alrededor del eje vertical, en radianes. */
  yaw: number;
  /** Cabeceo, en radianes. Acotado a +/-MAX_PITCH. */
  pitch: number;
  /** Campo de vision vertical, en radianes. */
  fovY: number;
}

export const DEFAULT_CAMERA_3D: Camera3DState = {
  px: 0,
  py: 0,
  pz: 0,
  distance: 900,
  yaw: 0.6,
  pitch: 0.35,
  fovY: (50 * Math.PI) / 180,
};

export const cloneCamera3D = (c: Camera3DState): Camera3DState => ({ ...c });

/** Posicion del ojo, derivada del estado. */
export const eyeOf = (c: Camera3DState, out: V3 = v3()): V3 => {
  const cp = Math.cos(c.pitch);
  out.x = c.px + c.distance * cp * Math.sin(c.yaw);
  out.y = c.py + c.distance * Math.sin(c.pitch);
  out.z = c.pz + c.distance * cp * Math.cos(c.yaw);
  return out;
};

/** Direccion de la mirada, unitaria, del ojo al punto de mira. */
export const forwardOf = (c: Camera3DState, out: V3 = v3()): V3 => {
  const cp = Math.cos(c.pitch);
  out.x = -cp * Math.sin(c.yaw);
  out.y = -Math.sin(c.pitch);
  out.z = -cp * Math.cos(c.yaw);
  return out;
};

/** Derecha de la camara en el mundo: `forward x arriba`, normalizado. */
export const rightOf = (c: Camera3DState, out: V3 = v3()): V3 => {
  out.x = Math.cos(c.yaw);
  out.y = 0;
  out.z = -Math.sin(c.yaw);
  return out;
};

/**
 * Arriba de la camara en el mundo.
 *
 * No es el "arriba" del mundo salvo con la camara horizontal: se inclina con el
 * cabeceo. Usar (0,1,0) aqui es el error clasico que hace que el desplazamiento
 * vertical se vaya de lado al mirar desde arriba.
 */
export const upOf = (c: Camera3DState, out: V3 = v3()): V3 => {
  const sp = Math.sin(c.pitch);
  out.x = -sp * Math.sin(c.yaw);
  out.y = Math.cos(c.pitch);
  out.z = -sp * Math.cos(c.yaw);
  return out;
};

/**
 * Gira la camara alrededor del punto de mira.
 *
 * `dYaw` positivo gira a la derecha de quien mira y `dPitch` positivo sube la
 * camara. El cabeceo se acota para que el arriba nunca se voltee: pasar por el
 * cenit con un arriba fijo provoca ese giro brusco de 180 grados tan
 * caracteristico de las camaras mal hechas.
 */
export const orbit = (c: Camera3DState, dYaw: number, dPitch: number): void => {
  c.yaw += dYaw;
  c.pitch = clamp(c.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
};

/** Acerca o aleja. `factor` menor que 1 acerca. */
export const zoom = (c: Camera3DState, factor: number): void => {
  c.distance = clamp(c.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
};

/**
 * Desplaza el punto de mira siguiendo al puntero.
 *
 * `dx` y `dy` llegan en pixeles con el convenio de pantalla: `dx` hacia la derecha
 * y `dy` hacia abajo. Se convierten a unidades de mundo con el tamano del
 * viewport, de modo que el punto agarrado se quede bajo el cursor; sin esa
 * conversion el desplazamiento se siente mas rapido cuanto mas se acerca la
 * camara.
 */
export const pan = (
  c: Camera3DState,
  dx: number,
  dy: number,
  viewportHeight: number,
): void => {
  const h = Math.max(1, viewportHeight);
  // Altura del plano de proyeccion a la distancia de la camara.
  const scale = (2 * c.distance * Math.tan(c.fovY * 0.5)) / h;

  const r = rightOf(c);
  const u = upOf(c);

  // Se mueve el punto de mira al contrario que el puntero: es lo que hace que el
  // dibujo siga al cursor en vez de huir de el.
  c.px += (-dx * r.x + dy * u.x) * scale;
  c.py += dy * u.y * scale;
  c.pz += (-dx * r.z + dy * u.z) * scale;
};

/** Encaja la camara para que quepa una esfera. */
export const frameSphere = (
  cam: Camera3DState,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): void => {
  cam.px = cx;
  cam.py = cy;
  cam.pz = cz;
  const radius = Math.max(1e-3, r);
  cam.distance = clamp(
    radius / Math.max(1e-4, Math.sin(cam.fovY * 0.5)),
    MIN_DISTANCE,
    MAX_DISTANCE,
  );
};

/** Frustum del culling, a partir del estado de la camara. */
export const cameraFrustum = (
  c: Camera3DState,
  aspect: number,
  near = 1,
  far = 100000,
): Frustum => {
  const eye = eyeOf(c);
  const fwd = forwardOf(c);
  return frustumOf(eye.x, eye.y, eye.z, fwd, { x: 0, y: 1, z: 0 }, c.fovY, Math.max(1e-3, aspect), near, far);
};

/**
 * Matriz de vista-proyeccion en columnas, que es el orden que espera WebGL.
 *
 * El backend con three.js no la necesita -three lleva sus propias matrices- pero
 * el respaldo por CPU si, y tenerla aqui permite comprobar en las pruebas que la
 * proyeccion coloca los puntos donde dice la geometria.
 *
 * Es el producto P * V desarrollado a mano:
 *
 *   perspectiva:  f = 1/tan(fovY/2),  c = (far+near)/(near-far),  d = 2*far*near/(near-far)
 *   vista:        base (derecha, arriba, -adelante) y traslacion por el ojo
 *
 * Desarrollarlo evita depender de una libreria de matrices solo para esto, y el
 * resultado se comprueba en `smoke-3d.ts` proyectando puntos conocidos.
 */
export const viewProjection = (
  c: Camera3DState,
  aspect: number,
  near = 1,
  far = 100000,
  out: Float32Array = new Float32Array(16),
): Float32Array => {
  const eye = eyeOf(c);
  const f = forwardOf(c);
  const r = rightOf(c);
  const u = upOf(c);

  const aspectSafe = Math.max(1e-3, aspect);
  const fov = 1 / Math.tan(c.fovY * 0.5);
  const fa = fov / aspectSafe;
  const cn = (far + near) / (near - far);
  const dn = (2 * far * near) / (near - far);

  const de = r.x * eye.x + r.y * eye.y + r.z * eye.z;
  const ue = u.x * eye.x + u.y * eye.y + u.z * eye.z;
  const fe = f.x * eye.x + f.y * eye.y + f.z * eye.z;

  out[0] = fa * r.x;
  out[1] = fov * u.x;
  out[2] = -cn * f.x;
  out[3] = f.x;

  out[4] = fa * r.y;
  out[5] = fov * u.y;
  out[6] = -cn * f.y;
  out[7] = f.y;

  out[8] = fa * r.z;
  out[9] = fov * u.z;
  out[10] = -cn * f.z;
  out[11] = f.z;

  out[12] = -fa * de;
  out[13] = -fov * ue;
  out[14] = cn * fe + dn;
  out[15] = -fe;

  return out;
};

/** Proyecta un punto de mundo a coordenadas normalizadas de dispositivo. */
export const projectPoint = (
  m: Float32Array,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number; w: number } => {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = Math.abs(cw) < 1e-9 ? 0 : 1 / cw;
  return { x: cx * iw, y: cy * iw, z: cz * iw, w: cw };
};
