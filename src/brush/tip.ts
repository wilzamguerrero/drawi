import { clamp01 } from "../core/math";

/**
 * Punta de pincel ráster: un mapa de ALFA (cobertura) que se estampa a lo largo
 * del trazo. El color del mapa es irrelevante —solo cuenta su canal alfa—,
 * porque `tintTip` lo recolorea con `source-in` al color del pincel.
 *
 * Las puntas se generan a una resolución fija (`TIP_RES`) y se escalan por
 * estampa con `drawImage`: así una sola punta sirve para cualquier tamaño.
 */

/** Resolución del mapa de punta procedural (px). Se escala por estampa. */
export const TIP_RES = 128;

/**
 * Punta redonda procedural: núcleo opaco hasta `hardness` (0..1) y caída suave
 * hasta el borde. `hardness = 1` es un disco duro; `hardness = 0`, un degradado
 * desde el centro.
 */
export function makeRoundTip(hardness: number): HTMLCanvasElement {
  const d = TIP_RES;
  const c = document.createElement("canvas");
  c.width = d;
  c.height = d;
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas 2D no disponible");
  const r = d / 2;
  const h = clamp01(hardness);
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(Math.min(0.999, Math.max(0.0001, h)), "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fill();
  return c;
}

/** Recolorea un mapa de punta (alfa) al color dado, conservando su alfa. */
export function tintTip(tip: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = tip.width;
  c.height = tip.height;
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas 2D no disponible");
  g.drawImage(tip, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}
