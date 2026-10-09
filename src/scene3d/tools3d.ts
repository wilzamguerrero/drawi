/**
 * Herramientas propias del visor espacial y sus ajustes.
 *
 * El modo 3D no secuestra el manifiesto de herramientas del 2D: tiene el suyo,
 * mas pequeno, porque sus herramientas no dibujan tinta vectorial sino trazos
 * espaciales y no comparten ni el contexto ni los gestos.
 *
 * El PINCEL, en cambio, si es el mismo: sus cuatro modos -trazo, relleno,
 * arrastre y borrador- son los de `BrushSettings`, y en el espacio significan lo
 * que su nombre dice. Lo que se anade aqui es lo que en 2D no existe: suavizar un
 * trazo ya dibujado, y el radio con el que se agarra.
 */

import type { BrushMode } from "../stroke/types";

/** Herramientas del visor. */
export type Tool3D = "brush" | "smooth";

export const TOOL3D_LABELS: Record<Tool3D, string> = {
  brush: "Pincel",
  smooth: "Suavizar",
};

export const TOOL3D_ORDER: Tool3D[] = ["brush", "smooth"];

export interface Scene3DSettings {
  tool: Tool3D;
  /**
   * Radio de agarre, en unidades de mundo.
   *
   * Lo comparten el suavizado y el arrastre: es el tamano de la zona que la punta
   * afecta, y va aparte del tamano del pincel porque no son lo mismo -se puede
   * querer un pincel fino y una mano ancha para retocar-.
   */
  radius: number;
  /** Cuanto relaja cada fotograma mientras se arrastra, 0..1. */
  strength: number;
  /**
   * Mejora el trazo al soltarlo.
   *
   * Aplica un suavizado y una limpieza de esquinas al cerrar el gesto. Va
   * apagado por defecto: es un cambio silencioso en lo que se acaba de dibujar, y
   * eso solo debe pasar si se ha pedido.
   */
  refineOnRelease: boolean;
  /** Fuerza de esa mejora al soltar, 0..1. */
  refineStrength: number;
}

export const DEFAULT_SCENE3D: Scene3DSettings = {
  tool: "brush",
  radius: 40,
  strength: 0.35,
  refineOnRelease: false,
  refineStrength: 0.5,
};

/**
 * Que hace el puntero en el espacio ahora mismo, en una palabra.
 *
 * Vive aqui y no en el visor porque lo dicen dos sitios -el propio visor y la
 * barra de estado-, y dos listas de palabras para lo mismo se desvian.
 */
export const spaceToolLabel = (settings: Scene3DSettings, mode: BrushMode): string => {
  if (settings.tool === "smooth") return "suavizar";
  if (mode === "erase") return "borrador";
  if (mode === "pull") return "arrastre";
  if (mode === "fill") return "relleno";
  return "trazo";
};
