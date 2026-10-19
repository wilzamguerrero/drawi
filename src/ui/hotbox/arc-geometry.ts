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

/**
 * Una baldosa RECTANGULAR del modo tira: el anillo "enderezado".
 *
 * Todo va en coordenadas LOCALES, con el origen en el CENTRO de la baldosa. El
 * eje de la tira es +X (horizontal) o +Y (vertical) y la banda va perpendicular.
 * Así la misma baldosa se dibuja igual en los dos ejes sin duplicar matemática,
 * y el rectángulo sale axis-alineado porque los dos ejes son perpendiculares.
 */
export interface TileSpec {
  /** true = la tira corre en vertical (el largo va en Y); false = horizontal. */
  vertical: boolean;
  /** Semilargo total de la baldosa a lo largo del eje. */
  halfLen: number;
  /** Semiancho de la banda, perpendicular al eje. */
  halfBand: number;
  /** Tramo visible a lo largo del eje, en fracción 0..1 desde el inicio. */
  from: number;
  to: number;
  /** Hueco entre baldosas, en píxeles. El mismo que entre sectores del menú. */
  gapPx: number;
}

/** Lleva un punto local (largo, ancho) a coordenadas del SVG de la baldosa. */
function tilePoint(vertical: boolean, along: number, across: number): string {
  const x = vertical ? across : along;
  const y = vertical ? along : across;
  return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

/**
 * El atributo `d` de una baldosa en tira. `from`/`to` recortan la baldosa a lo
 * largo del eje: el relleno de un dial en tira es esta misma función con `to` en
 * su valor, igual que en el aro. `gapPx` mantiene el mismo hueco que el menú, y
 * las esquinas redondeadas salen del `stroke-linejoin` del CSS, como en
 * `.rm-chip-sector`. Devuelve "" cuando el recorte es degenerado (valor mínimo).
 */
export function tilePathD(spec: TileSpec): string {
  const { vertical, halfLen, halfBand, from, to, gapPx } = spec;
  const h = gapPx / 2;
  const a0 = -halfLen + from * 2 * halfLen + h;
  const a1 = -halfLen + to * 2 * halfLen - h;
  // El hueco separa solo a lo largo del eje (entre baldosas vecinas); la banda se
  // mantiene entera de borde a borde, como la banda radial de un aro.
  const b0 = -halfBand;
  const b1 = halfBand;
  if (a1 <= a0 || b1 <= b0) return "";
  return [
    `M ${tilePoint(vertical, a0, b0)}`,
    `L ${tilePoint(vertical, a1, b0)}`,
    `L ${tilePoint(vertical, a1, b1)}`,
    `L ${tilePoint(vertical, a0, b1)}`,
    `Z`,
  ].join(" ");
}

/**
 * Aguja recta del dial en tira: cruza la banda en la posición `at` (0..1). Es el
 * equivalente del "pulgar" de `needlePathD`, pero perpendicular al eje.
 */
export function tileNeedleD(spec: TileSpec, at: number, pad = 3): string {
  const { vertical, halfLen, halfBand } = spec;
  const a = -halfLen + at * 2 * halfLen;
  const b0 = -halfBand + pad;
  const b1 = halfBand - pad;
  return [
    `M ${tilePoint(vertical, a, b0)}`,
    `L ${tilePoint(vertical, a, b1)}`,
  ].join(" ");
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
