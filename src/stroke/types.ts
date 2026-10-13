import type { Vec2 } from "../core/vec2";

/** Como se deriva el ancho del trazo a partir de la entrada. */
export type StrokeDynamics =
  | "constant"
  | "pressure"
  | "velocity"
  | "pressure-velocity"
  | "tilt";

/** Modo heredado de Alchemy/Webchemy + el borrador vectorial propio. */
export type BrushMode = "stroke" | "fill" | "pull" | "erase";

/**
 * Cómo actúa el borrador (modo `erase`).
 * - `brush`: trazo de borrado de ancho constante (destination-out).
 * - `object`: tocar un trazo lo elimina entero.
 * - `color`: elimina solo los trazos del color del primero que se toca.
 * - `shape`: usa la forma activa como huella y borra el área.
 */
export type EraseMode = "brush" | "object" | "color" | "shape";

export const ERASE_MODE_LABELS: Record<EraseMode, string> = {
  brush: "Pincel",
  object: "Objeto",
  color: "Color",
  shape: "Forma",
};

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

/** Modos de suavizado de posición al estilo Lazy Nezumi Pro. */
export type SmoothMode = "pulled-string" | "moving-average" | "ema" | "inertia";

export const SMOOTH_MODE_LABELS: Record<SmoothMode, string> = {
  "pulled-string": "Cuerda tensada",
  "moving-average": "Media movil",
  ema: "Media exponencial",
  inertia: "Inercia",
};

export const SMOOTH_MODE_INFO: Record<SmoothMode, string> = {
  "pulled-string": "Ideal para detalle lento con esquinas marcadas: el cursor tira de una cuerda.",
  "moving-average": "Suavizado equilibrado para curvas dinámicas y esquinas suaves.",
  ema: "Suavizado masivo para curvas largas y envolventes.",
  inertia: "Física con masa: trazos rápidos y fluidos, con inercia.",
};

export interface BrushSettings {
  mode: BrushMode;
  dynamics: StrokeDynamics;
  /** Diametro base en unidades de mundo. */
  size: number;
  /** Fraccion minima del diametro (0..1) que puede alcanzar la dinamica. */
  minRatio: number;
  opacity: number;
  /** Modo de suavizado al estilo Lazy Nezumi. */
  smoothMode: SmoothMode;
  /** 0..1 Cantidad de suavizado (significado depende de smoothMode). */
  smoothAmount: number;
  /** Catch Up: en media/EMA, la línea alcanza al cursor al levantar. */
  smoothCatchUp: boolean;
  /** 0..1 Longitud de la cuerda del estabilizador (0=corta, 1=larga) — vale para cualquier modo. */
  stringLength: number;
  /** 0..1 Curva de la U cuando la cuerda está floja (panza). */
  stringCurve: number;
  /** 0..1 Caída extra por gravedad en Y cuando cuelga. */
  stringDrop: number;
  /** Guias de suavizado (compatibilidad): la “cantidad” legacy. */
  smoothing: number;
  /** 0..1 Arrastre tipo lazo legacy (migrado a smoothMode). */
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
  /** Sub-modo del borrador (solo aplica con `mode === "erase"`). */
  eraseMode: EraseMode;
  /** Borrador suave: usa la opacidad como fuerza en vez de borrar del todo. */
  eraseFade: boolean;
  /** El gesto de borrado elimina también cuerpos de materia que toque. */
  eraseMatter: boolean;
  /**
   * Convierte el trazo/relleno/arrastre a materia sin cambiar de modo del pincel.
   * Es un toggle parecido a "Usar como borrador" pero el resultado son cuerpos.
   */
  asMatter: boolean;
  /**
   * Convierte el pincel en acuarela (pintura humeda por fluidos): el mismo gesto
   * inyecta pigmento/agua en el plano de acuarela en vez de tinta vectorial.
   * Como "Hacer materia", pero el resultado fluye y se difumina.
   */
  asAqua: boolean;
  /**
   * Convierte el pincel en pincel RÁSTER (tipo Photoshop): el mismo gesto estampa
   * una punta con textura a lo largo del trazo sobre una capa de píxeles, en vez
   * de producir tinta vectorial. Como "Hacer materia"/"Acuarela", es un toggle.
   */
  asRaster: boolean;
  /** Ráster: dureza de la punta redonda procedural (0..1). */
  rasterHardness: number;
  /** Ráster: separación entre estampas, fracción del diámetro (>0). */
  rasterSpacing: number;
  /** Ráster: flujo por estampa (0..1). La opacidad del trazo la fija `opacity`. */
  rasterFlow: number;
  /** Ráster: ángulo base de la punta, en grados (0..360). */
  rasterAngle: number;
  /** Ráster: redondez de la punta (0..1; 1 = redonda, <1 = achatada). */
  rasterRoundness: number;
  /** Ráster: el ángulo de la punta sigue a la dirección del trazo. */
  rasterAngleFollow: boolean;
  /** Ráster: dispersión al azar, en diámetros (0 = sin dispersión). */
  rasterScatter: number;
  /** Ráster: huellas por punto de muestreo (1..). */
  rasterScatterCount: number;
  /** Ráster: jitter de tamaño (0..1). */
  rasterSizeJitter: number;
  /** Ráster: jitter de ángulo (0..1). */
  rasterAngleJitter: number;
  /** Ráster: jitter de redondez (0..1). */
  rasterRoundnessJitter: number;
  /** Ráster: jitter de flujo (0..1). */
  rasterFlowJitter: number;
  /** Ráster: jitter de opacidad por estampa (0..1). */
  rasterOpacityJitter: number;
  /** Ráster: cuánto la presión modula la opacidad por estampa (0..1, 0 = sin presión). */
  rasterPressureOpacity: number;
  /** Ráster: cuánto la presión modula el flujo por estampa (0..1). */
  rasterPressureFlow: number;
  /**
   * Invierte los modos de pintura (Trazo/Relleno/Arrastre) a borrado: el mismo
   * gesto recorta la tinta en vez de pintarla. La tecla Alt lo alterna.
   */
  invertErase: boolean;
}

export const DEFAULT_BRUSH: BrushSettings = {
  mode: "stroke",
  dynamics: "pressure-velocity",
  size: 10,
  minRatio: 0.12,
  opacity: 1,
  smoothMode: "pulled-string",
  smoothAmount: 0.35,
  smoothCatchUp: false,
  stringLength: 0.35,
  stringCurve: 0.65,
  stringDrop: 0.14,
  smoothing: 0.42,
  streamline: 0.28,
  velocityScale: 1.6,
  velocityInvert: false,
  pressureCurve: 0,
  taperIn: 0.05,
  taperOut: 0.18,
  jitter: 0,
  splat: false,
  gradient: false,
  eraseMode: "brush",
  eraseFade: false,
  eraseMatter: false,
  asMatter: false,
  asAqua: false,
  asRaster: false,
  rasterHardness: 0.8,
  rasterSpacing: 0.1,
  rasterFlow: 0.9,
  rasterAngle: 0,
  rasterRoundness: 1,
  rasterAngleFollow: false,
  rasterScatter: 0,
  rasterScatterCount: 1,
  rasterSizeJitter: 0,
  rasterAngleJitter: 0,
  rasterRoundnessJitter: 0,
  rasterFlowJitter: 0,
  rasterOpacityJitter: 0,
  rasterPressureOpacity: 0,
  rasterPressureFlow: 0,
  invertErase: false,
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
