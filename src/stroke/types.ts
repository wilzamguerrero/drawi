import type { Vec2 } from "../core/vec2";

/** Como se deriva el ancho del trazo a partir de la entrada. */
export type StrokeDynamics =
  | "constant"
  | "pressure"
  | "velocity"
  | "pressure-velocity"
  | "tilt";

/** Modo heredado de Alchemy/Webchemy. */
export type BrushMode = "stroke" | "fill" | "pull";

export const DYNAMICS_INFO: Record<StrokeDynamics, { label: string; hint: string }> = {
  constant: {
    label: "Constante",
    hint: "Ancho fijo. El trazo clasico de Alchemy.",
  },
  pressure: {
    label: "Presion",
    hint: "El ancho sigue la presion del lapiz. Con raton usa la velocidad como sustituto.",
  },
  velocity: {
    label: "Velocidad",
    hint: "Trazo de tinta: rapido adelgaza, lento engorda. Invertible.",
  },
  "pressure-velocity": {
    label: "Presion + velocidad",
    hint: "Mezcla ambas. Es la que mejor imita un pincel real.",
  },
  tilt: {
    label: "Inclinacion",
    hint: "Punta de cincel: el ancho y el angulo dependen de como inclines el lapiz.",
  },
};

export interface BrushSettings {
  mode: BrushMode;
  dynamics: StrokeDynamics;
  /** Diametro base en unidades de mundo. */
  size: number;
  /** Fraccion minima del diametro (0..1) que puede alcanzar la dinamica. */
  minRatio: number;
  opacity: number;
  /** 0..1 Suavizado One-Euro (mas alto = mas estable, algo mas lento). */
  smoothing: number;
  /** 0..1 Arrastre tipo lazo: la punta persigue al cursor. */
  streamline: number;
  /** Velocidad de referencia en px/ms para normalizar la dinamica. */
  velocityScale: number;
  /** true: rapido = grueso (pincel seco). false: rapido = fino (tinta). */
  velocityInvert: boolean;
  /** -1..1 curva de respuesta de la presion. */
  pressureCurve: number;
  /** Longitud (0..1 del trazo) que se afila al entrar/salir. */
  taperIn: number;
  taperOut: number;
  /** Ruido de ancho, 0..1. */
  jitter: number;
  /** Modificador Alchemy: contorno anguloso en vez de suave. */
  splat: boolean;
  /** Modificador Alchemy: degradado vertical sobre el trazo. */
  gradient: boolean;
}

export const DEFAULT_BRUSH: BrushSettings = {
  mode: "stroke",
  dynamics: "pressure-velocity",
  size: 10,
  minRatio: 0.12,
  opacity: 1,
  smoothing: 0.45,
  streamline: 0.35,
  velocityScale: 1.6,
  velocityInvert: false,
  pressureCurve: 0,
  taperIn: 0.05,
  taperOut: 0.18,
  jitter: 0,
  splat: false,
  gradient: false,
};

/** Punto ya procesado: posicion en mundo + radio resuelto. */
export interface StrokePoint {
  x: number;
  y: number;
  /** Radio (mitad del ancho) en unidades de mundo. */
  r: number;
  /** Presion efectiva usada (0..1). */
  p: number;
  /** Velocidad suavizada en px/ms de mundo. */
  v: number;
  /** Angulo de la punta (solo dinamica de inclinacion). */
  a: number;
  t: number;
}

export interface OutlineOptions {
  /** Contorno anguloso (modificador splat). */
  splat: boolean;
  /** Puntos por cuarto de vuelta en arcos. */
  arcQuality: number;
  /** Cierra los extremos con semicirculo. */
  caps: boolean;
}

export type Polygon = Vec2[];
