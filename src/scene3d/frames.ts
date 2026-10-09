/**
 * Marcos que minimizan la rotación a lo largo del trazo.
 *
 * El problema: una cinta 3D necesita saber, en cada punto, hacia dónde "mira".
 * Si eso se recalcula de forma independiente en cada punto aparecen saltos y la
 * cinta se retuerce sobre sí misma; es el defecto que más delata a un render 3D
 * de trazos hecho a mano.
 *
 * La solución es propagar un marco desde el principio del trazo girándolo lo
 * mínimo posible en cada paso. Se usa el método de **reflexión doble**
 * (Wang, Jüttler, Zheng, Liu, 2008), que es el estándar: es O(n), no acumula
 * error como proyectar el marco anterior sobre el plano normal, y es estable
 * cuando la curvatura crece.
 *
 * Esto es lo que la GPU no puede hacer: cada marco depende del anterior, así que
 * el recorrido es secuencial. Se paga una vez, al cerrar el trazo, y el
 * resultado se guarda en el punto para que el shader solo tenga que leerlo.
 */

import {
  anyPerpendicular3,
  fromBuffer,
  normalize3,
  orthogonalize3,
  set3,
  v3,
  type V3,
} from "./vec3";
import { NRM_OFFSET, POINT_FLOATS, POS_OFFSET } from "./types";

/**
 * Tangentes por diferencias centrales.
 *
 * Central y no hacia delante porque suaviza: sobre puntos ya decimados la
 * diferencia hacia delante hereda el ruido de la posición y el marco lo amplifica.
 */
const computeTangents = (data: Float32Array, count: number, out: Float32Array): void => {
  const p = v3();
  const a = v3();
  const b = v3();
  for (let i = 0; i < count; i++) {
    const o = i * POINT_FLOATS + POS_OFFSET;
    if (i === 0) {
      fromBuffer(a, data, o);
      fromBuffer(b, data, o + POINT_FLOATS);
    } else if (i === count - 1) {
      fromBuffer(a, data, o - POINT_FLOATS);
      fromBuffer(b, data, o);
    } else {
      fromBuffer(a, data, o - POINT_FLOATS);
      fromBuffer(b, data, o + POINT_FLOATS);
    }
    set3(p, b.x - a.x, b.y - a.y, b.z - a.z);
    const t = i * 3;
    if (normalize3(p, p) === 0) {
      // Puntos coincidentes: se hereda la tangente anterior para no romper el marco.
      if (i > 0) {
        out[t] = out[t - 3];
        out[t + 1] = out[t - 2];
        out[t + 2] = out[t - 1];
      } else {
        set3(p, 1, 0, 0);
        out[t] = 1;
        out[t + 1] = 0;
        out[t + 2] = 0;
      }
      continue;
    }
    out[t] = p.x;
    out[t + 1] = p.y;
    out[t + 2] = p.z;
  }
};

/**
 * Escribe la normal de la cinta de cada punto en el propio buffer empaquetado.
 *
 * `planeNormal` es la normal del plano de dibujo cuando el trazo se hace sobre
 * uno. Es lo que hace que la cinta quede tendida sobre el plano en vez de
 * orientada de forma arbitraria.
 */
export const computeFrames = (
  data: Float32Array,
  count: number,
  planeNormal: V3 | null = null,
): void => {
  if (count <= 0) return;

  if (count === 1) {
    const r = v3();
    if (planeNormal) normalize3(planeNormal, r);
    else set3(r, 0, 1, 0);
    data[NRM_OFFSET] = r.x;
    data[NRM_OFFSET + 1] = r.y;
    data[NRM_OFFSET + 2] = r.z;
    return;
  }

  const tan = new Float32Array(count * 3);
  computeTangents(data, count, tan);

  const ti = v3();
  const tn = v3();
  const v1 = v3();
  const v2 = v3();
  const rL = v3();
  const tL = v3();
  const r = v3();

  // Marco inicial: perpendicular a la tangente lo más parecido posible a la
  // normal del plano. Si no hay plano, una perpendicular estable cualquiera.
  fromBuffer(ti, tan, 0);
  if (planeNormal) orthogonalize3(planeNormal, ti, r);
  else anyPerpendicular3(ti, r);

  const write = (i: number): void => {
    const o = i * POINT_FLOATS + NRM_OFFSET;
    data[o] = r.x;
    data[o + 1] = r.y;
    data[o + 2] = r.z;
  };
  write(0);

  for (let i = 0; i < count - 1; i++) {
    const oa = i * POINT_FLOATS + POS_OFFSET;
    const ob = (i + 1) * POINT_FLOATS + POS_OFFSET;
    set3(v1, data[ob] - data[oa], data[ob + 1] - data[oa + 1], data[ob + 2] - data[oa + 2]);
    const c1 = v1.x * v1.x + v1.y * v1.y + v1.z * v1.z;

    fromBuffer(ti, tan, i * 3);
    fromBuffer(tn, tan, (i + 1) * 3);

    if (c1 > 1e-12) {
      // Primera reflexión: el plano que lleva x_i en x_{i+1}.
      const k = 2 / c1;
      const dr = k * (v1.x * r.x + v1.y * r.y + v1.z * r.z);
      set3(rL, r.x - v1.x * dr, r.y - v1.y * dr, r.z - v1.z * dr);

      const dt = k * (v1.x * ti.x + v1.y * ti.y + v1.z * ti.z);
      set3(tL, ti.x - v1.x * dt, ti.y - v1.y * dt, ti.z - v1.z * dt);
    } else {
      // Segmento nulo: no hay nada que reflejar.
      set3(rL, r.x, r.y, r.z);
      set3(tL, ti.x, ti.y, ti.z);
    }

    // Segunda reflexión: el plano que lleva tL en t_{i+1}.
    set3(v2, tn.x - tL.x, tn.y - tL.y, tn.z - tL.z);
    const c2 = v2.x * v2.x + v2.y * v2.y + v2.z * v2.z;
    if (c2 > 1e-12) {
      const k = 2 / c2;
      const dl = k * (v2.x * rL.x + v2.y * rL.y + v2.z * rL.z);
      set3(r, rL.x - v2.x * dl, rL.y - v2.y * dl, rL.z - v2.z * dl);
    } else {
      // Tangente sin cambios: el marco tampoco gira.
      set3(r, rL.x, rL.y, rL.z);
    }

    // La reflexión doble conserva la norma en aritmética exacta; en coma flotante
    // deriva. Renormalizar cada punto cuesta una raíz y evita que se note.
    normalize3(r, r);
    write(i + 1);
  }
};

/** Lee la normal de la cinta del punto `i`. */
export const normalAt = (data: Float32Array, i: number, out: V3 = v3()): V3 => {
  const o = i * POINT_FLOATS + NRM_OFFSET;
  return set3(out, data[o], data[o + 1], data[o + 2]);
};
