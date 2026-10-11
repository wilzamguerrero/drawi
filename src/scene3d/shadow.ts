/**
 * Sombras de contacto sobre el suelo.
 *
 * Hubo un primer intento por proyeccion: aplastar la geometria del objeto contra
 * el suelo con una matriz. Es correcto como fisica, pero se ve mal -una caja
 * aplastada vista en 3/4 es un cuadrilatero inclinado de bordes duros, no una
 * sombra-, y los solapes de sus caras manchan de doble tinta. Para una escena de
 * ilustracion lo que se lee de inmediato es una **sombra de contacto**: un disco
 * oscuro, suave en el borde, bajo el objeto.
 *
 * El disco se coloca en el suelo bajo el objeto, se agranda con su tamano, y se
 * corre y se estira en la direccion de la luz, para que no parezca una pegatina
 * sino algo proyectado. Un objeto mas alto da una sombra mas grande y mas tenue,
 * como en la realidad. Nada de esto necesita el z-buffer que el visor no tiene, y
 * es todo aritmetica, asi que se prueba en Node sin abrir un navegador.
 */

import type { Light3D } from "./lights";
import { lightDirection } from "./lights";
import { v3, type V3 } from "./vec3";

/** Como cae la sombra de un objeto: donde, de que tamano, girada y cuanto se ve. */
export interface ShadowDisc {
  /** Centro del disco en el suelo. */
  cx: number;
  cz: number;
  /** Semiejes del disco: `rx` a lo largo de la luz, `rz` cruzado. */
  rx: number;
  rz: number;
  /** Angulo del disco en el plano del suelo, en radianes (hacia donde se estira). */
  angle: number;
  /** Opacidad en el centro, 0..1. */
  opacity: number;
}

/**
 * Calcula la sombra de contacto de un objeto bajo una luz.
 *
 * `center` es el centro del objeto, `radius` su tamano (media diagonal), `floorY`
 * la altura del suelo. Devuelve `null` cuando no hay sombra que pintar: objeto por
 * debajo del suelo, o luz que no baja hacia el.
 *
 * Dos efectos que lo hacen creible:
 *  - Cuanto mas alto esta el objeto sobre el suelo, mas grande y mas tenue es la
 *    sombra -se difumina con la distancia-.
 *  - La sombra se corre en la direccion horizontal de la luz y se estira en ese
 *    eje, que es lo que hace una luz oblicua.
 */
export const contactShadow = (
  light: Light3D | null,
  center: V3,
  radius: number,
  floorY: number,
  baseOpacity: number,
): ShadowDisc | null => {
  if (!light || !light.enabled) return null;

  const height = center.y - floorY;
  if (height <= 0) return null; // el objeto esta en el suelo o por debajo

  // Direccion en la que VIAJA la luz. Para una puntual, desde la luz al objeto.
  const dir = lightDirection(light, center, v3());
  // La luz tiene que bajar hacia el suelo para proyectar sombra hacia abajo.
  if (dir.y >= -0.05) return null;

  // Donde cae la sombra: se avanza desde el centro del objeto en la direccion de
  // la luz hasta tocar el suelo. t = altura / (-dir.y).
  const t = height / -dir.y;
  const cx = center.x + dir.x * t;
  const cz = center.z + dir.z * t;

  // Tamano: el radio del objeto, agrandado con la altura -una sombra lejana es
  // mas grande y mas difusa-. El estiramiento a lo largo de la luz sale de lo
  // rasante que sea: una luz baja alarga la sombra.
  const spread = 1 + (height / Math.max(radius, 1)) * 0.35;
  const grow = radius * spread;
  // Cuanto mas horizontal la luz, mas se estira la sombra en su direccion.
  const horiz = Math.hypot(dir.x, dir.z);
  const stretch = 1 + horiz / Math.max(1e-3, -dir.y);
  const rx = grow * Math.min(3, stretch);
  const rz = grow;
  const angle = Math.atan2(dir.z, dir.x);

  // Mas alto = mas tenue. Nunca del todo transparente mientras haya algo de altura.
  const fade = 1 / (1 + (height / Math.max(radius, 1)) * 0.6);
  const opacity = baseOpacity * fade;

  return { cx, cz, rx, rz, angle, opacity };
};
