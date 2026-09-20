/**
 * Sistema de aparición / desaparición "materia" (compartido).
 *
 * Unas gotas negras se juntan y se funden (filtro gooey del CSS) para formar un
 * elemento al aparecer, y se desintegran al cerrarse. Lo usan el menú radial,
 * los paneles y la rueda de color: cambiar aquí (o en `styles-fx.css`) actualiza
 * la animación en todos.
 *
 * Uso típico:
 *   const fx = new MateriaFx({ coreSize: 112 });
 *   layer.appendChild(fx.el);          // layer = un contenedor inset:0
 *   fx.center(px, py);                 // centro del elemento, en coords del layer
 *   fx.gather();                       // al abrir
 *   setTimeout(() => fx.fadeOut(), fx.gatherMs);   // relevo al elemento real
 *   ...
 *   fx.center(px, py); fx.scatter();   // al cerrar
 *   setTimeout(() => fx.clear(), fx.scatterMs);
 */

const TAU = Math.PI * 2;

let gooInjected = false;

/** Inyecta una sola vez el filtro gooey (#materia-goo) que funde las gotas. */
function ensureGoo(): void {
  if (gooInjected || typeof document === "undefined") return;
  const holder = document.createElement("div");
  holder.className = "materia-goo-defs";
  holder.innerHTML =
    '<svg aria-hidden="true" width="0" height="0"><defs>' +
    '<filter id="materia-goo" color-interpolation-filters="sRGB">' +
    '<feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b"/>' +
    '<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11"/>' +
    "</filter></defs></svg>";
  document.body.appendChild(holder);
  gooInjected = true;
}

export interface MateriaFxOptions {
  /** Tamaño (diámetro px) de la masa formada. Las gotas y el alcance se escalan
      a partir de esto si no se dan explícitos. */
  coreSize?: number;
  /** Distancia desde la que nacen/parten las gotas. Por defecto ~0.85·coreSize. */
  reach?: number;
  /** Número de gotas satélite. */
  dots?: number;
  gatherMs?: number;
  scatterMs?: number;
}

export class MateriaFx {
  /** La capa de partículas. Añádela a un contenedor `inset: 0`. */
  readonly el: HTMLElement;
  readonly gatherMs: number;
  readonly scatterMs: number;

  private core: number;
  private reach: number;
  private dots: number;
  private clearTimer = 0;

  constructor(opts: MateriaFxOptions = {}) {
    ensureGoo();
    this.core = opts.coreSize ?? 112;
    this.reach = opts.reach ?? this.core * 0.85;
    this.dots = opts.dots ?? 8;
    this.gatherMs = opts.gatherMs ?? 420;
    this.scatterMs = opts.scatterMs ?? 340;

    this.el = document.createElement("div");
    this.el.className = "materia-fx";
    this.el.style.setProperty("--core", `${this.core}px`);
  }

  /** Coloca el centro de la masa en (x, y), en coordenadas del contenedor padre. */
  center(x: number, y: number): void {
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  /** Las gotas nacen fuera y se juntan en el centro. */
  gather(): void {
    this.seed(false);
  }

  /** La masa central se deshace en gotas que salen despedidas. */
  scatter(): void {
    this.seed(true);
  }

  /** Desvanece la capa (crossfade con el elemento real) y la limpia luego. */
  fadeOut(): void {
    this.el.classList.add("is-fading");
    window.clearTimeout(this.clearTimer);
    this.clearTimer = window.setTimeout(() => this.clear(), 300);
  }

  /** Quita todas las gotas y reinicia el estado. */
  clear(): void {
    window.clearTimeout(this.clearTimer);
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    this.el.classList.remove("is-gathering", "is-scattering", "is-fading");
  }

  private seed(scatter: boolean): void {
    window.clearTimeout(this.clearTimer);
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    this.el.classList.remove("is-gathering", "is-scattering", "is-fading");

    // Núcleo: la masa central. Su tamaño lo fija --core en el CSS.
    const core = document.createElement("div");
    core.className = "materia-fx-dot materia-fx-core";
    this.el.appendChild(core);

    const k = this.core / 112; // escala de las gotas respecto al tamaño base
    for (let i = 0; i < this.dots; i++) {
      const a = (i / this.dots) * TAU + (Math.random() - 0.5) * 0.7;
      const dist = this.reach * (0.72 + Math.random() * 0.45);
      const size = (16 + Math.random() * 22) * k;
      const dot = document.createElement("div");
      dot.className = "materia-fx-dot";
      dot.style.width = `${size.toFixed(1)}px`;
      dot.style.height = `${size.toFixed(1)}px`;
      dot.style.setProperty("--sx", `${(Math.cos(a) * dist).toFixed(1)}px`);
      dot.style.setProperty("--sy", `${(Math.sin(a) * dist).toFixed(1)}px`);
      dot.style.animationDelay = `${i * (scatter ? 7 : 11)}ms`;
      this.el.appendChild(dot);
    }

    // Reflow para reiniciar la animación al re-añadir la clase.
    void this.el.offsetWidth;
    this.el.classList.add(scatter ? "is-scattering" : "is-gathering");
  }
}

/** True si el usuario pide reducir el movimiento (para saltarse las partículas). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
