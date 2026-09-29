import type { InkItem } from "./types";

/**
 * Modelo de capas estilo Photoshop.
 *
 * La tinta sigue viviendo en el array plano `doc.items` (cada item lleva su
 * `layerId`): el z global lo decide el ORDEN de `doc.layers` y el z dentro de
 * una capa, el orden de sus items en `doc.items`. Así serialización, historial
 * (items compartidos por referencia) y el recuento de items no cambian de forma.
 *
 * La opacidad, el modo de fusión, la máscara, el alfa bloqueado y el recorte
 * exigen componer cada capa en su propio lienzo fuera de pantalla; de eso se
 * encarga el compositor (`src/render/compositor.ts`).
 */

/** Tipo de capa. La materia es una pseudo-capa fija (plano WebGL propio). */
export type LayerKind = "ink" | "group" | "matter";

/**
 * Modo de fusión. Los valores son los de `globalCompositeOperation` del canvas,
 * que cubren casi 1:1 el juego de Photoshop.
 */
export type BlendMode =
  | "source-over" // Normal
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export const BLEND_LABELS: Record<BlendMode, string> = {
  "source-over": "Normal",
  multiply: "Multiplicar",
  screen: "Trama",
  overlay: "Superponer",
  darken: "Oscurecer",
  lighten: "Aclarar",
  "color-dodge": "Sobreexponer",
  "color-burn": "Subexponer",
  "hard-light": "Luz fuerte",
  "soft-light": "Luz suave",
  difference: "Diferencia",
  exclusion: "Exclusión",
  hue: "Tono",
  saturation: "Saturación",
  color: "Color",
  luminosity: "Luminosidad",
};

export const BLEND_ORDER: BlendMode[] = [
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

/** Etiquetas de color de capa (como en Photoshop). `none` = sin etiqueta. */
export type LayerColor =
  | "none"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "violet"
  | "gray";

export const LAYER_COLOR_LABELS: Record<LayerColor, string> = {
  none: "Ninguno",
  red: "Rojo",
  orange: "Naranja",
  yellow: "Amarillo",
  green: "Verde",
  blue: "Azul",
  violet: "Violeta",
  gray: "Gris",
};

/** Valor CSS de cada etiqueta de color (la franja lateral de la fila). */
export const LAYER_COLOR_HEX: Record<LayerColor, string> = {
  none: "transparent",
  red: "#d64550",
  orange: "#e08c3b",
  yellow: "#e3c341",
  green: "#5fa85f",
  blue: "#4f8fd0",
  violet: "#9b6cc4",
  gray: "#8a8a94",
};

export const LAYER_COLOR_ORDER: LayerColor[] = [
  "none",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
  "gray",
];

/**
 * Máscara vectorial de una capa. Se guarda como una lista de trazos:
 * - trazo normal (`erase: false`) = OCULTA (negro).
 * - trazo de revelado (`erase: true`) = REVELA (blanco, recorta el ocultado).
 * Una máscara vacía no oculta nada; `inverted` intercambia oculto ⇄ visible.
 */
export interface LayerMask {
  enabled: boolean;
  inverted: boolean;
  items: InkItem[];
}

export interface SceneLayer {
  id: string;
  kind: LayerKind;
  name: string;
  /** Ojo: muestra/oculta la capa (y sus hijos si es grupo). */
  visible: boolean;
  /** Opacidad de la capa entera, incluida su fusión (0..1). */
  opacity: number;
  /** Relleno: opacidad solo del contenido, antes de la fusión (0..1). */
  fill: number;
  blend: BlendMode;
  /** Bloquea la edición y el movimiento de la capa. */
  locked: boolean;
  /** Alfa bloqueado: pintar solo cae sobre píxeles ya existentes. */
  alphaLock: boolean;
  /** Recorte: la capa se recorta a la capa base inmediatamente inferior. */
  clip: boolean;
  color: LayerColor;
  /** Grupo contraído en el panel (solo afecta a la UI). */
  collapsed: boolean;
  /** Id del grupo contenedor, o null si está en la raíz. */
  parentId: string | null;
  mask?: LayerMask;
}

export const makeMask = (): LayerMask => ({ enabled: true, inverted: false, items: [] });

/** Copia superficial de una capa (para el historial: mask.items por slice). */
export const cloneLayer = (l: SceneLayer): SceneLayer => ({
  ...l,
  mask: l.mask ? { ...l.mask, items: l.mask.items.slice() } : undefined,
});
