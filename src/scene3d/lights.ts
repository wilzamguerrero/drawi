/**
 * Luces de la escena.
 *
 * El sombreado de las cintas y de las manchas ya tenia una luz, pero fija: la
 * misma para todo y para siempre. Aqui pasa a ser una lista del documento, que es
 * lo que permite encender, apagar y colocar luces como en cualquier programa de
 * 3D.
 *
 * El limite de cuatro no es capricho: cada luz es un uniforme que se recorre por
 * fragmento, y las cintas cubren mucha pantalla. Con mas luces el coste se paga
 * en cada pixel de cada trazo, y en una escena de ilustracion cuatro luces -una
 * clave, un relleno, una de contra y un ambiente- es lo que se usa de verdad.
 *
 * Decision importante: **las luces no dan sombras todavia.** Estan el sombreado
 * directo, que es lo que hace que un trazo se lea como materia. Las sombras
 * proyectadas van aparte, y por eso el modulo no las menciona.
 */

import { DEFAULT_CAMERA_3D, forwardOf, type Camera3DState } from "./camera3d";
import { normalize3, set3, v3, type V3 } from "./vec3";

export type LightKind = "directional" | "point" | "ambient";

export const LIGHT_LABELS: Record<LightKind, string> = {
  directional: "Direccional",
  point: "Puntual",
  ambient: "Ambiental",
};

export const LIGHT_ORDER: LightKind[] = ["directional", "point", "ambient"];

/** Luces direccionales y puntuales que entran en el sombreado. */
export const MAX_LIGHTS = 4;

export interface Light3D {
  id: string;
  kind: LightKind;
  enabled: boolean;
  color: string;
  /** 0..2. A 1 la luz es la de referencia. */
  intensity: number;
  /**
   * Hacia donde ESTA la luz (direccional) o donde esta colocada (puntual).
   *
   * El mismo campo para las dos porque ocupan el mismo uniforme: lo que las
   * distingue es la cuarta componente, que dice si el vector es una direccion o
   * un punto. Guardar dos campos y dejar uno muerto en cada caso llenaria el
   * archivo de ceros que no significan nada.
   *
   * Y es "hacia donde esta" y no "hacia donde alumbra" a proposito: en la interfaz
   * se piensa en donde se pone la luz, no en hacia donde viaja.
   */
  x: number;
  y: number;
  z: number;
}

export const makeLight = (
  kind: LightKind,
  id: string,
  over: Partial<Light3D> = {},
): Light3D => ({
  id,
  kind,
  enabled: true,
  color: kind === "ambient" ? "#5a6070" : "#ffffff",
  intensity: kind === "ambient" ? 0.55 : 1,
  // Por defecto, luz de estudio: desde arriba, a la izquierda y por delante.
  x: -0.4,
  y: 0.85,
  z: 0.35,
  ...over,
});

/** La escena arranca con la misma luz que tenia antes de que esto se configurara. */
export const DEFAULT_LIGHTS: Light3D[] = [
  makeLight("directional", "sol", { x: -0.4, y: 0.85, z: 0.35, intensity: 1 }),
  makeLight("ambient", "ambiente", { intensity: 0.55 }),
];

/** Color de la luz por debajo del cual no aporta nada visible. */
const AMBIENT_FLOOR = 0.16;

export interface LightUniforms {
  /** 4 vec4: hacia donde esta la luz y, en w, 0 si es direccion y 1 si es punto. */
  positions: Float32Array;
  /** 4 vec3, ya multiplicados por la intensidad. */
  colors: Float32Array;
  /** Color base que se suma siempre, para que nada quede negro del todo. */
  ambient: [number, number, number];
  /** Cuantas direccionales o puntuales entraron. */
  count: number;
}

const srgbToLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** Color CSS (#rgb o #rrggbb) a componentes lineales 0..1. */
export const parseHex = (hex: string): [number, number, number] => {
  let s = hex.trim().replace("#", "");
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length !== 6) return [1, 1, 1];
  const n = Number.parseInt(s, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
  ];
};

/**
 * Empaqueta la lista de luces en lo que espera el shader.
 *
 * Lo que hace falta entender de esta funcion es que **las luces que no entran no
 * se notan**: los huecos se rellenan con color cero y el shader recorre siempre
 * las cuatro. Asi no hay ni una rama por fragmento, que es lo que permite que el
 * bucle sea el mismo para todas las escenas.
 *
 * Las ambientales se suman al color base en vez de ocupar un hueco: una ambiental
 * no tiene direccion ni posicion, asi que no necesita entrar en el bucle.
 */
export const packLights = (lights: readonly Light3D[]): LightUniforms => {
  const positions = new Float32Array(MAX_LIGHTS * 4);
  const colors = new Float32Array(MAX_LIGHTS * 3);

  let ambiente: [number, number, number] = [AMBIENT_FLOOR, AMBIENT_FLOOR, AMBIENT_FLOOR];
  let slot = 0;

  for (const l of lights) {
    if (!l.enabled) continue;
    const c = parseHex(l.color);
    const k = Math.max(0, l.intensity);

    if (l.kind === "ambient") {
      ambiente = [
        Math.min(4, ambiente[0] + c[0] * k),
        Math.min(4, ambiente[1] + c[1] * k),
        Math.min(4, ambiente[2] + c[2] * k),
      ];
      continue;
    }
    if (slot >= MAX_LIGHTS) continue;

    const o = slot * 4;
    // Una direccional sin direccion no ilumina por ningun lado; se le da la del
    // estudio en vez de dejarla en cero, que daria un resultado plano y raro.
    const d = v3(l.x, l.y, l.z);
    if (normalize3(d, d) === 0) {
      // Reserva normalizada, no solo asignada: el shader la usa como direccion y
      // una que no sea unitaria desplaza el sombreado entero.
      set3(d, -0.4, 0.85, 0.35);
      normalize3(d, d);
    }
    positions[o] = d.x;
    positions[o + 1] = d.y;
    positions[o + 2] = d.z;
    positions[o + 3] = l.kind === "point" ? 1 : 0;

    const co = slot * 3;
    colors[co] = c[0] * k;
    colors[co + 1] = c[1] * k;
    colors[co + 2] = c[2] * k;
    slot++;
  }

  return { positions, colors, ambient: ambiente, count: slot };
};

/**
 * Direccion en la que VIAJA la luz, que es lo que necesitan las sombras.
 *
 * Proyectar un punto sobre el suelo es avanzar desde el en direccion CONTRARIA a
 * la de la luz hasta tocar el plano, asi que lo que hace falta aqui es el sentido
 * del viaje, no hacia donde esta la lampara.
 *
 * En una puntual la direccion depende de donde se mire: `from` es el punto desde
 * el que se calcula. Una direccional la tiene la misma en toda la escena.
 */
export const lightDirection = (light: Light3D, from: V3 = v3(), out: V3 = v3()): V3 => {
  const v =
    light.kind === "point"
      ? v3(from.x - light.x, from.y - light.y, from.z - light.z)
      : v3(-light.x, -light.y, -light.z);
  normalize3(v, out);
  return out;
};

/** La primera luz direccional o puntual encendida, que es la que da la direccion
 *  de las sombras. `null` si no hay ninguna. */
export const shadowLight = (lights: readonly Light3D[]): Light3D | null =>
  lights.find((l) => l.enabled && l.kind !== "ambient") ?? null;

/** Una luz colocada sobre el hombro de la camara: la clave de estudio de siempre. */
export const studioLight = (cam: Camera3DState = DEFAULT_CAMERA_3D, id = "clave"): Light3D => {
  const f = forwardOf(cam, v3());
  // Detras de la camara y por encima, con un poco de lado: una luz justo de frente
  // no da volumen, y una justo encima aplana.
  const d = v3(-f.x + 0.45, -f.y + 0.8, -f.z);
  normalize3(d, d);
  return makeLight("directional", id, { x: d.x, y: d.y, z: d.z, intensity: 1 });
};
