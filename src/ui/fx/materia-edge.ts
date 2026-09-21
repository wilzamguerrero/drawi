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
 * inferior quedan rectos; el iz quierdo se dibuja fuera de pantalla (x=0 del SVG,
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
  /**
   * Borde vivo completo: las CUATRO aristas ondulan y las cuatro esquinas se
   * redondean. Para siluetas que flotan (un diálogo centrado), donde no hay un
   * marco al que pegar un lado recto. Por defecto (false) es el modo panel: solo
   * ondulan tres bordes y el izquierdo queda recto pegado al marco.
   */
  full?: boolean;
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
  private full: boolean;

  constructor(opts: MateriaEdgeOptions = {}) {
    this.radius = opts.radius ?? 22;
    this.amp = opts.amplitude ?? 11;
    this.inset = opts.inset ?? 13;
    this.speed = opts.speed ?? 1;
    this.full = opts.full ?? false;

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
    const d = this.full ? this.buildFullPath() : this.buildPath();
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

  /**
   * Silueta con los CUATRO bordes vivos y las cuatro esquinas redondeadas, para
   * un elemento que flota (un diálogo centrado) y no tiene ningún lado pegado a
   * un marco.
   *
   * El rectángulo base se mete `inset` px por dentro del viewBox, dejando ese
   * margen para que los picos del ondulado asomen hacia afuera sin recortarse
   * (el SVG va con overflow visible). Cada arista oscila alrededor de su línea
   * base con una envolvente `sin(p·π)` que la lleva a cero en las dos esquinas,
   * así el tramo recto entronca sin salto con los cuartos de arco de las esquinas.
   */
  private buildFullPath(): string {
    const W = this.w;
    const H = this.h;
    if (W <= 0 || H <= 0) return "";

    const inset = this.inset;
    const a = this.amp * this.ampScale; // amplitud (0 = rectángulo recto)
    const t = this.t;

    // Rectángulo base (líneas de reposo de cada arista), metido `inset` px.
    const L = inset;
    const R = W - inset;
    const T = inset;
    const B = H - inset;
    const r = Math.max(0, Math.min(this.radius, (R - L) / 2 - 1, (B - T) / 2 - 1));

    // Tramos rectos de cada arista (entre las dos esquinas redondeadas).
    const hSpan = R - L - 2 * r; // ancho del tramo recto horizontal
    const vSpan = B - T - 2 * r; // alto del tramo recto vertical
    const step = 6;

    // Envolvente 0→1→0 a lo largo de un tramo [0, span].
    const env = (u: number, span: number): number => {
      if (span <= 0) return 0;
      const p = Math.max(0, Math.min(1, u / span));
      return Math.sin(p * Math.PI);
    };

    // Desplazamientos por arista: suma de dos senos incomensurables + envolvente.
    // Cada borde usa fases/frecuencias distintas para que el vaivén no se sienta
    // repetido de un lado a otro.
    const topOff = (x: number): number =>
      a * env(x - (L + r), hSpan) *
      (0.62 * Math.sin(x * 0.024 + t * 0.9 + 2.0) + 0.38 * Math.sin(x * 0.040 - t * 0.6 + 0.5));
    const botOff = (x: number): number =>
      a * env(x - (L + r), hSpan) *
      (0.62 * Math.sin(x * 0.022 - t * 1.0 + 3.7) + 0.38 * Math.sin(x * 0.037 + t * 0.55 + 1.1));
    const leftOff = (y: number): number =>
      a * env(y - (T + r), vSpan) *
      (0.62 * Math.sin(y * 0.023 - t * 0.85 + 1.4) + 0.38 * Math.sin(y * 0.039 + t * 0.65 + 2.6));
    const rightOff = (y: number): number =>
      a * env(y - (T + r), vSpan) *
      (0.62 * Math.sin(y * 0.020 + t * 1.1) + 0.38 * Math.sin(y * 0.034 - t * 0.7 + 1.3));

    // -------- construir el path (sentido horario desde arriba-izquierda) --------

    // Punto de arranque: fin del arco superior izquierdo, inicio del borde superior.
    let d = `M ${(L + r).toFixed(2)} ${(T + topOff(L + r)).toFixed(2)}`;

    // Borde SUPERIOR: izquierda → derecha, ondulando en Y.
    for (let x = L + r + step; x < R - r; x += step) {
      d += ` L ${x.toFixed(2)} ${(T + topOff(x)).toFixed(2)}`;
    }
    // Esquina superior derecha.
    d += ` L ${(R - r).toFixed(2)} ${(T + topOff(R - r)).toFixed(2)}`;
    d += ` Q ${R.toFixed(2)} ${T.toFixed(2)} ${(R + rightOff(T + r)).toFixed(2)} ${(T + r).toFixed(2)}`;

    // Borde DERECHO: arriba → abajo, ondulando en X.
    for (let y = T + r + step; y < B - r; y += step) {
      d += ` L ${(R + rightOff(y)).toFixed(2)} ${y.toFixed(2)}`;
    }
    // Esquina inferior derecha.
    d += ` L ${(R + rightOff(B - r)).toFixed(2)} ${(B - r).toFixed(2)}`;
    d += ` Q ${R.toFixed(2)} ${B.toFixed(2)} ${(R - r).toFixed(2)} ${(B + botOff(R - r)).toFixed(2)}`;

    // Borde INFERIOR: derecha → izquierda, ondulando en Y.
    for (let x = R - r - step; x > L + r; x -= step) {
      d += ` L ${x.toFixed(2)} ${(B + botOff(x)).toFixed(2)}`;
    }
    // Esquina inferior izquierda.
    d += ` L ${(L + r).toFixed(2)} ${(B + botOff(L + r)).toFixed(2)}`;
    d += ` Q ${L.toFixed(2)} ${B.toFixed(2)} ${(L + leftOff(B - r)).toFixed(2)} ${(B - r).toFixed(2)}`;

    // Borde IZQUIERDO: abajo → arriba, ondulando en X.
    for (let y = B - r - step; y > T + r; y -= step) {
      d += ` L ${(L + leftOff(y)).toFixed(2)} ${y.toFixed(2)}`;
    }
    // Esquina superior izquierda y cierre.
    d += ` L ${(L + leftOff(T + r)).toFixed(2)} ${(T + r).toFixed(2)}`;
    d += ` Q ${L.toFixed(2)} ${T.toFixed(2)} ${(L + r).toFixed(2)} ${(T + topOff(L + r)).toFixed(2)}`;
    d += ` Z`;
    return d;
  }
}
