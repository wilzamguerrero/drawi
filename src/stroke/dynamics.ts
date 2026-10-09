/**
 * Dinamica del pincel: de la entrada al radio del trazo.
 *
 * Vive aparte del constructor de trazos porque no sabe nada de 2D: solo mira
 * presion, velocidad e inclinacion. Esa es justo la parte que un pincel 2D y su
 * version 3D pueden compartir sin adaptacion, asi que se aisla aqui una sola vez.
 */

import { clamp01, lerp, smoothstep } from "../core/math";
import type { Rng } from "../core/rng";
import type { BrushSettings } from "./types";

/**
 * Resuelve el radio (mitad del ancho) y el angulo de la punta para una muestra.
 *
 * `pressure` y `speed` llegan YA suavizados por el llamante. Resolverlos sobre
 * los valores crudos traduciria el ruido del digitalizador en parpadeo de grosor.
 */
export const resolveRadius = (
  st: BrushSettings,
  pressure: number,
  speed: number,
  tilt: number,
  azimuth: number,
  rng: Rng,
): { r: number; a: number } => {
  const base = Math.max(0.05, st.size * 0.5);
  const min = base * clamp01(st.minRatio);
  const vn = clamp01(speed / Math.max(0.05, st.velocityScale));
  const velFactor = st.velocityInvert ? vn : 1 - vn;
  let r = base;
  let a = 0;

  switch (st.dynamics) {
    case "constant":
      r = base;
      break;
    case "pressure":
      r = lerp(min, base, pressure);
      break;
    case "velocity":
      r = lerp(min, base, smoothstep(velFactor));
      break;
    case "pressure-velocity":
      // La presion manda, la velocidad modula: es el comportamiento de un pincel real.
      r = lerp(min, base, pressure * lerp(0.55, 1, smoothstep(velFactor)));
      break;
    case "tilt": {
      // Punta de cincel: tumbar el lapiz ensancha, y el trazo sigue el azimut.
      const flat = clamp01(tilt / (Math.PI / 2.2));
      r = lerp(min, base, lerp(pressure, 1, 0.35)) * lerp(0.65, 1.55, flat);
      a = azimuth;
      break;
    }
  }

  if (st.jitter > 0) r *= 1 + rng.gauss() * st.jitter * 0.35;
  return { r: Math.max(0.03, r), a };
};

/**
 * Multiplicador de afilado segun la longitud de arco recorrida.
 *
 * Se expone como factor en vez de mutar los puntos porque el trazo 2D guarda
 * `r` en objetos y el 3D en un Float32Array; el afilado es el mismo calculo pero
 * cada uno lo escribe donde le toca.
 */
export const taperFactor = (
  cum: number,
  total: number,
  taperIn: number,
  taperOut: number,
): number => {
  if (total <= 1e-6) return 1;
  if (taperIn <= 0 && taperOut <= 0) return 1;

  const inLen = taperIn * total;
  const outLen = taperOut * total;
  let k = 1;
  if (inLen > 1e-6) k = Math.min(k, smoothstep(cum / inLen));
  if (outLen > 1e-6) k = Math.min(k, smoothstep((total - cum) / outLen));
  return lerp(0.06, 1, k);
};
