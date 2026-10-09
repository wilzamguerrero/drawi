/**
 * Vector 3D. Mismo criterio que `vec2.ts`: todo pasa por `out` para no asignar
 * en rutas calientes, y las funciones son puras.
 *
 * Se sufijan los nombres con `3` porque estos módulos conviven con `vec2.ts` en
 * los mismos archivos y `add`/`dot`/`cross` a secas serían ambiguos al leer.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

export const set3 = (out: V3, x: number, y: number, z: number): V3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const copy3 = (out: V3, a: V3): V3 => set3(out, a.x, a.y, a.z);

/** Lee un punto del buffer empaquetado a partir de su índice. */
export const fromBuffer = (out: V3, data: Float32Array, i: number): V3 =>
  set3(out, data[i], data[i + 1], data[i + 2]);

export const add3 = (a: V3, b: V3, out: V3 = v3()): V3 => set3(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub3 = (a: V3, b: V3, out: V3 = v3()): V3 => set3(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const mul3 = (a: V3, s: number, out: V3 = v3()): V3 => set3(out, a.x * s, a.y * s, a.z * s);

export const addScaled3 = (a: V3, b: V3, s: number, out: V3 = v3()): V3 =>
  set3(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

export const dot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross3 = (a: V3, b: V3, out: V3 = v3()): V3 => {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return set3(out, x, y, z);
};

export const lenSq3 = (a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const len3 = (a: V3): number => Math.sqrt(lenSq3(a));

export const dist3 = (a: V3, b: V3): number =>
  Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

export const distSq3 = (a: V3, b: V3): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/** Normaliza. Si el vector es degenerado deja `out` en cero y devuelve 0. */
export const normalize3 = (a: V3, out: V3 = v3()): number => {
  const l = len3(a);
  if (l > 1e-12) {
    set3(out, a.x / l, a.y / l, a.z / l);
    return l;
  }
  set3(out, 0, 0, 0);
  return 0;
};

export const lerp3 = (a: V3, b: V3, t: number, out: V3 = v3()): V3 =>
  set3(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/** Distancia de `p` al segmento `a`-`b`. Devuelve además el parámetro de proyección. */
export const distToSegment = (p: V3, a: V3, b: V3): { d: number; s: number } => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const apz = p.z - a.z;
  const den = abx * abx + aby * aby + abz * abz;
  const s = den < 1e-12 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / den));
  const dx = apx - abx * s;
  const dy = apy - aby * s;
  const dz = apz - abz * s;
  return { d: Math.sqrt(dx * dx + dy * dy + dz * dz), s };
};

/**
 * Proyecta `v` sobre el plano perpendicular a `axis` (unitario) y normaliza.
 *
 * Es el paso de Gram-Schmidt que necesita el primer marco de un trazo: convierte
 * la normal del plano de dibujo en una referencia perpendicular a la tangente.
 */
export const orthogonalize3 = (v: V3, axis: V3, out: V3 = v3()): V3 => {
  const d = dot3(v, axis);
  const px = v.x - axis.x * d;
  const py = v.y - axis.y * d;
  const pz = v.z - axis.z * d;
  const l = Math.sqrt(px * px + py * py + pz * pz);
  if (l > 1e-9) return set3(out, px / l, py / l, pz / l);
  return anyPerpendicular3(axis, out);
};

/**
 * Cualquier perpendicular unitario a `axis`. Se apoya en el eje de menor
 * componente para que el producto cruzado nunca sea degenerado.
 */
export const anyPerpendicular3 = (axis: V3, out: V3 = v3()): V3 => {
  const ax = Math.abs(axis.x);
  const ay = Math.abs(axis.y);
  const az = Math.abs(axis.z);
  let bx = 0;
  let by = 0;
  let bz = 0;
  if (ax <= ay && ax <= az) bx = 1;
  else if (ay <= az) by = 1;
  else bz = 1;
  const x = axis.y * bz - axis.z * by;
  const y = axis.z * bx - axis.x * bz;
  const z = axis.x * by - axis.y * bx;
  const l = Math.sqrt(x * x + y * y + z * z);
  return l > 1e-12 ? set3(out, x / l, y / l, z / l) : set3(out, 1, 0, 0);
};
