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

  // Escala de amplitud (0..1). Al colapsar baja suavemente a 0 para que el borde
  // quede recto al final del deslizamiento, no ondulado congelado. Al abrir sube
  // a 1 y el borde cobra vida.
  private ampScale = 1;
  private ampTarget = 1;

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
    // El borde vuelve a cobrar vida: amplitud objetivo 1.
    this.ampTarget = 1;
    if (this.running) return;
    if (prefersReducedMotion()) {
      this.ampScale = 0; // sin ondulado
      this.redraw();
      return;
    }
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * Colapsa el borde: la amplitud baja suavemente a 0 y, cuando llega, el bucle
   * se detiene con la silueta recta. Así al replegarse el panel no se ve el
   * ondulado congelado asomando por el marco, sino un borde limpio.
   */
  collapse(): void {
    this.ampTarget = 0;
    if (prefersReducedMotion() || !this.running) {
      // Sin animación: recto de inmediato.
      this.ampScale = 0;
      this.stop();
      this.redraw();
      return;
    }
    // El bucle sigue corriendo hasta que ampScale llega a ~0 (ver frame()).
  }

  /** Detiene el vaivén de inmediato (ahorra CPU cuando el elemento no se ve). */
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

    // Acercar ampScale a su objetivo. La constante marca la rapidez del
    // aplanado/rebrote: ~0.36s para pasar de 1 a casi 0, igual que el
    // deslizamiento del panel, así el borde queda recto justo al replegarse.
    const k = Math.min(1, dt * 9);
    this.ampScale += (this.ampTarget - this.ampScale) * k;

    this.redraw();

    // Al colapsar, cuando el ondulado ya es imperceptible, congelar recto y
    // parar el bucle para no gastar CPU con el panel plegado.
    if (this.ampTarget === 0 && this.ampScale < 0.01) {
      this.ampScale = 0;
      this.redraw();
      this.stop();
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private redraw(): void {
    const d = this.buildPath();
    if (d) this.path.setAttribute("d", d);
  }

  /**
   * Silueta con tres bordes vivos (superior, derecho, inferior) y el izquierdo
   * recto pegado al marco.
   *
   * Los bordes superior e inferior ondulan en Y (picos hacia arriba/abajo) y el
   * derecho ondula en X (picos hacia el lienzo). Las esquinas derechas se
   * redondean con un cuarto de arco y la envolvente anula el ondulado cerca de
   * ellas para que no haya un salto discontinuo entre el tramo recto y el curvo.
   *
   * El izquierdo va en x=0 y siempre recto: pegado al marco de la ventana.
   */
  private buildPath(): string {
    const W = this.w;
    const H = this.h;
    if (W <= 0 || H <= 0) return "";
    const r = Math.max(0, Math.min(this.radius, H / 2 - 1));
    const cx = W - this.inset;
    const step = 5;
    const a = this.amp * this.ampScale; // amplitud (0 = borde recto al colapsar)
    const t = this.t;                   // tiempo acumulado

    // -------- funciones de ondulado --------

    // Ondulado vertical para el borde derecho (desplazamiento en X).
    const rightSpan = H - 2 * r;
    const rightX = (y: number): number => {
      let env = 1;
      if (rightSpan > 0) {
        const p = Math.max(0, Math.min(1, (y - r) / rightSpan));
        env = Math.sin(p * Math.PI);
      }
      const wave =
        0.62 * Math.sin(y * 0.020 + t * 1.1) +
        0.38 * Math.sin(y * 0.034 - t * 0.7 + 1.3);
      return cx + a * env * wave;
    };

    // Ondulado horizontal para bordes superior/inferior (desplazamiento en Y).
    // La envolvente va de 0 en el punto izquierdo (para que quede recto ahí) a
    // 1 en el centro del borde y vuelve a 0 en la esquina derecha (donde está
    // el arco).
    const topSpan = cx - r;     // ancho del tramo recto del borde superior
    const topY = (x: number): number => {
      if (topSpan <= 0) return 0;
      const p = Math.max(0, Math.min(1, x / topSpan));
      const env = Math.sin(p * Math.PI);
      const wave =
        0.62 * Math.sin(x * 0.025 + t * 0.9 + 2.0) +
        0.38 * Math.sin(x * 0.041 - t * 0.6 + 0.5);
      return a * 0.7 * env * wave;
    };

    const botY = (x: number): number => {
      if (topSpan <= 0) return H;
      const p = Math.max(0, Math.min(1, x / topSpan));
      const env = Math.sin(p * Math.PI);
      const wave =
        0.62 * Math.sin(x * 0.022 - t * 1.0 + 3.7) +
        0.38 * Math.sin(x * 0.038 + t * 0.55 + 1.1);
      return H + a * 0.7 * env * wave;
    };

    // -------- construir el path --------

    // Empezar en la esquina superior izquierda (siempre fija).
    let d = `M 0 0`;

    // Borde SUPERIOR: izquierda → derecha, ondulando en Y.
    for (let x = step; x < topSpan; x += step) {
      d += ` L ${x.toFixed(2)} ${topY(x).toFixed(2)}`;
    }

    // Esquina superior derecha: del tramo recto al arco.
    const trX = rightX(r);
    d += ` L ${(trX - r).toFixed(2)} ${topY(topSpan).toFixed(2)}`;
    d += ` Q ${trX.toFixed(2)} 0 ${trX.toFixed(2)} ${r.toFixed(2)}`;

    // Borde DERECHO: arriba → abajo, ondulando en X.
    for (let y = r + step; y < H - r; y += step) {
      d += ` L ${rightX(y).toFixed(2)} ${y.toFixed(2)}`;
    }

    // Esquina inferior derecha: del borde derecho al arco inferior.
    const brX = rightX(H - r);
    d += ` L ${brX.toFixed(2)} ${(H - r).toFixed(2)}`;
    d += ` Q ${brX.toFixed(2)} ${H.toFixed(2)} ${(brX - r).toFixed(2)} ${botY(topSpan).toFixed(2)}`;

    // Borde INFERIOR: derecha → izquierda, ondulando en Y.
    for (let x = topSpan - step; x > 0; x -= step) {
      d += ` L ${x.toFixed(2)} ${botY(x).toFixed(2)}`;
    }

    // Vuelta a la esquina inferior izquierda y cierre.
    d += ` L 0 ${H.toFixed(2)}`;
    d += ` Z`;
    return d;
  }
}
