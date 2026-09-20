/**
 * Borde vivo vectorial — "materia" para siluetas rectangulares.
 *
 * Un panel anclado por su borde izquierdo necesita que su lado exterior (el que
 * da al lienzo) ondule como una masa, sin dejar de ser un panel. Los filtros SVG
 * de desplazamiento (feDisplacementMap) deforman una imagen de píxeles y siempre
 * dejan bandas/"vetas" y dentado al remuestrear el ruido. Aquí NO deformamos
 * píxeles: dibujamos la silueta como un `<path>` que se recalcula cada frame. Un
 * trazo vectorial se antialiasea perfecto a cualquier resolución, así que el
 * contorno se ve continuo y fluido, sin pixelado.
 *
 * El movimiento es una suma de senos (dos frecuencias incomensurables) a lo
 * largo del borde derecho, con una envolvente que lo lleva a cero en las esquinas
 * para que estas queden estables y redondeadas. Los lados izquierdo, superior e
 * inferior quedan rectos; el izquierdo se dibuja fuera de pantalla (x=0 del SVG,
 * detrás del marco) para que ese lado nunca descubra huecos.
 *
 * Es un sistema compartido: cualquier elemento rectangular que quiera este borde
 * vivo puede instanciarlo, montar `.el` detrás de su contenido y llamar
 * `start()`/`stop()`.
 */

import { prefersReducedMotion } from "./materia";

const SVGNS = "http://www.w3.org/2000/svg";

export interface MateriaEdgeOptions {
  /** Color de relleno de la silueta. */
  fill?: string;
  /** Radio de las esquinas exteriores (px). */
  radius?: number;
  /** Amplitud del ondulado en el centro del borde (px). */
  amplitude?: number;
  /** Distancia del centro del ondulado al borde derecho del elemento (px). */
  inset?: number;
  /** Velocidad del vaivén (rad/s aprox.). */
  speed?: number;
}

export class MateriaEdge {
  /** SVG a montar detrás del contenido (posición absoluta, inset:0 del padre). */
  readonly el: SVGSVGElement;

  private path: SVGPathElement;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private last = 0;
  private t = 0;
  private w = 0;
  private h = 0;
  private running = false;

  private radius: number;
  private amp: number;
  private inset: number;
  private speed: number;

  constructor(opts: MateriaEdgeOptions = {}) {
    this.radius = opts.radius ?? 22;
    this.amp = opts.amplitude ?? 11;
    this.inset = opts.inset ?? 13;
    this.speed = opts.speed ?? 1;

    this.el = document.createElementNS(SVGNS, "svg");
    this.el.setAttribute("preserveAspectRatio", "none");
    this.el.setAttribute("aria-hidden", "true");

    this.path = document.createElementNS(SVGNS, "path");
    this.path.setAttribute("fill", opts.fill ?? "#161619");
    this.el.appendChild(this.path);

    // El tamaño lo marca el elemento (inset del padre). Un ResizeObserver
    // mantiene el viewBox y redibuja aunque no estemos animando.
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (!r) return;
        this.w = r.width;
        this.h = r.height;
        this.el.setAttribute("viewBox", `0 0 ${this.w} ${this.h}`);
        if (!this.running) this.redraw();
      });
      this.ro.observe(this.el as unknown as Element);
    }
  }

  /** Arranca el vaivén. Con movimiento reducido, dibuja una silueta estática. */
  start(): void {
    if (this.running) return;
    if (prefersReducedMotion()) {
      this.redraw();
      return;
    }
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Detiene el vaivén (ahorra CPU cuando el elemento no se ve). */
  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    this.ro = null;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    if (!this.last) this.last = now;
    // dt acotado: si la pestaña estuvo en segundo plano, no damos un salto.
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt * this.speed;
    this.redraw();
    this.raf = requestAnimationFrame(this.frame);
  };

  private redraw(): void {
    const d = this.buildPath();
    if (d) this.path.setAttribute("d", d);
  }

  /**
   * Silueta: lados izquierdo/superior/inferior rectos, borde derecho ondulante.
   * El izquierdo va en x=0 (fuera de pantalla, tras el marco). Las esquinas
   * derechas se redondean con un cuarto de curva y el ondulado se anula en ellas
   * (envolvente senoidal) para que queden fijas.
   */
  private buildPath(): string {
    const W = this.w;
    const H = this.h;
    if (W <= 0 || H <= 0) return "";
    const r = Math.max(0, Math.min(this.radius, H / 2 - 1));
    const cx = W - this.inset; // centro del ondulado
    const span = H - 2 * r;

    // x del borde derecho a la altura y (con envolvente que se apaga en esquinas).
    const edgeX = (y: number): number => {
      let env = 1;
      if (span > 0) {
        const p = Math.max(0, Math.min(1, (y - r) / span));
        env = Math.sin(p * Math.PI); // 0 en esquinas, 1 en el centro
      }
      const wave =
        0.62 * Math.sin(y * 0.020 + this.t * 1.1) +
        0.38 * Math.sin(y * 0.034 - this.t * 0.7 + 1.3);
      return cx + this.amp * env * wave;
    };

    const topX = edgeX(r);
    const botX = edgeX(H - r);

    let d = `M 0 0`;
    d += ` L ${(topX - r).toFixed(2)} 0`;
    d += ` Q ${topX.toFixed(2)} 0 ${topX.toFixed(2)} ${r.toFixed(2)}`;

    // Borde derecho: muestreo denso de una función suave. Los segmentos rectos
    // entre puntos muy juntos los antialiasea el rasterizador vectorial, así que
    // se ve como una curva continua, sin facetas ni pixelado.
    const step = 5;
    for (let y = r + step; y < H - r; y += step) {
      d += ` L ${edgeX(y).toFixed(2)} ${y.toFixed(2)}`;
    }

    d += ` L ${botX.toFixed(2)} ${(H - r).toFixed(2)}`;
    d += ` Q ${botX.toFixed(2)} ${H.toFixed(2)} ${(botX - r).toFixed(2)} ${H.toFixed(2)}`;
    d += ` L 0 ${H.toFixed(2)}`;
    d += ` Z`;
    return d;
  }
}
