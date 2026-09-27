import { clamp } from "../../core/math";
import type { DialNode } from "./menu";

/**
 * Geometría de arcos y dials, compartida por el menú radial (`radial-menu.ts`) y
 * los trozos arrancables (`radial-chips.ts`).
 *
 * Todo aquí es puro: recibe centro/radios/ángulos por parámetro y devuelve el
 * atributo `d` de un `<path>` o un número. Así el menú y los trozos dibujan la
 * misma tajada anular y mapean el mismo dial sin duplicar la matemática.
 */

export interface ArcSpec {
  /** Centro del anillo, en el sistema de coordenadas del SVG que lo dibuja. */
  cx: number;
  cy: number;
  innerR: number;
  outerR: number;
  /** Ángulos de inicio/fin del sector (radianes, 0 = este, sentido horario). */
  a0: number;
  a1: number;
  /** Hueco entre sectores, en PÍXELES (constante en el borde interior y exterior). */
  gapPx: number;
}

/**
 * El atributo `d` de un sector anular con hueco de ancho constante: el desfase
 * angular en cada borde es gapPx/radio, así el separador mide lo mismo dentro y
 * fuera. Lo comparten el sector base y el relleno de los dials.
 */
export function arcPathD(spec: ArcSpec): string {
  const { cx, cy, innerR, outerR, a0, a1, gapPx } = spec;

  const halfGap = gapPx / 2;
  const outGap = halfGap / outerR;
  const inGap = halfGap / innerR;

  const startOut = a0 + outGap;
  const endOut = a1 - outGap;
  const startIn = a0 + inGap;
  const endIn = a1 - inGap;

  const x1 = cx + Math.cos(startOut) * outerR;
  const y1 = cy + Math.sin(startOut) * outerR;
  const x2 = cx + Math.cos(endOut) * outerR;
  const y2 = cy + Math.sin(endOut) * outerR;
  const x3 = cx + Math.cos(endIn) * innerR;
  const y3 = cy + Math.sin(endIn) * innerR;
  const x4 = cx + Math.cos(startIn) * innerR;
  const y4 = cy + Math.sin(startIn) * innerR;

  const largeArc = endOut - startOut > Math.PI ? 1 : 0;

  return [
    `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
    `Z`,
  ].join(" ");
}

/**
 * Aguja radial (del borde interior al exterior) en un ángulo dado: el "pulgar"
 * del dial que marca la posición del valor sobre el arco.
 */
export function needlePathD(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  angle: number,
  pad = 3,
): string {
  const xi = cx + Math.cos(angle) * (innerR + pad);
  const yi = cy + Math.sin(angle) * (innerR + pad);
  const xo = cx + Math.cos(angle) * (outerR - pad);
  const yo = cy + Math.sin(angle) * (outerR - pad);
  return `M ${xi.toFixed(2)} ${yi.toFixed(2)} L ${xo.toFixed(2)} ${yo.toFixed(2)}`;
}

/**
 * Valor de un dial a partir de la posición `t` (0..1) a lo largo de su arco.
 * Misma curva `gamma` que los deslizadores del panel (ui/controls.ts): con
 * gamma>1 el recorrido reparte más resolución en los valores bajos. `step`
 * cuantiza.
 */
export function dialValueFromT(node: DialNode, t: number): number {
  const g = node.gamma ?? 1;
  const tt = Math.pow(clamp(t, 0, 1), g);
  const v = node.min + tt * (node.max - node.min);
  const step = node.step ?? 0;
  return step > 0 ? Math.round(v / step) * step : v;
}

/** Posición `t` (0..1) sobre el arco que corresponde al valor actual del dial. */
export function dialTFromValue(node: DialNode): number {
  const norm = (node.value - node.min) / (node.max - node.min || 1);
  const g = node.gamma ?? 1;
  return clamp(Math.pow(clamp(norm, 0, 1), 1 / g), 0, 1);
}

/** Texto compacto del valor de un dial. Con `withUnit`, añade la unidad. */
export function dialText(node: DialNode, withUnit: boolean): string {
  const step = node.step ?? 0;
  const decimals = step > 0 && step < 1 ? 2 : 0;
  const txt = decimals > 0 ? node.value.toFixed(2) : String(Math.round(node.value));
  if (!withUnit || !node.unit) return txt;
  const unit = node.unit === "deg" ? "°" : ` ${node.unit}`;
  return `${txt}${unit}`;
}
