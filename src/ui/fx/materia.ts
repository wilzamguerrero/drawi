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
  /** Duración de la fase de expansión (bloom): el círculo crece hasta el rectángulo. */
  bloomMs?: number;
  /**
   * Silueta rectangular: el núcleo toma este ancho/alto y las gotas se reparten
   * por el PERÍMETRO del rectángulo (no por una circunferencia), para que la masa
   * que se forma tenga la proporción del elemento —un cuadro— en vez de un disco.
   * Si se omite, la masa es circular (el modo original del menú radial y la rueda).
   */
  rect?: { width: number; height: number; radius?: number };
  /**
   * Dibuja el núcleo sólido central (la masa "llena"). Por defecto `true`. Ponlo
   * en `false` para que la masa la formen SOLO las gotas gooey al fundirse, sin un
   * bloque sólido detrás. Útil cuando otra capa (p. ej. la piel ondulante de un
   * cuadro) hace de relleno: el núcleo recto se vería como un rectángulo plano que
   * desentona con los bordes vivos, así que se prescinde de él y solo quedan los
   * blobs orgánicos convergiendo.
   */
  solidCore?: boolean;
}

export class MateriaFx {
  /** La capa de partículas. Añádela a un contenedor `inset: 0`. */
  readonly el: HTMLElement;
  readonly gatherMs: number;
  readonly scatterMs: number;
  readonly bloomMs: number;

  private core: number;
  private reach: number;
  private dots: number;
  private solidCore: boolean;
  private clearTimer = 0;
  /** Silueta rectangular activa (ancho/alto/radio); null = masa circular. */
  private rect: { width: number; height: number; radius: number } | null = null;

  constructor(opts: MateriaFxOptions = {}) {
    ensureGoo();
    this.core = opts.coreSize ?? 112;
    this.reach = opts.reach ?? this.core * 0.85;
    this.dots = opts.dots ?? 8;
    this.solidCore = opts.solidCore ?? true;
    this.gatherMs = opts.gatherMs ?? 420;
    this.scatterMs = opts.scatterMs ?? 340;
    this.bloomMs = opts.bloomMs ?? 440;
    if (opts.rect) this.setRect(opts.rect.width, opts.rect.height, opts.rect.radius);

    this.el = document.createElement("div");
    this.el.className = "materia-fx";
    this.el.style.setProperty("--core", `${this.core}px`);
  }

  /** Coloca el centro de la masa en (x, y), en coordenadas del contenedor padre. */
  center(x: number, y: number): void {
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  /**
   * Ajusta la silueta rectangular de la masa (ancho/alto/radio de esquina). Se
   * llama antes de gather()/scatter() cuando el elemento cambia de tamaño, para
   * que las partículas formen un rectángulo con su proporción actual.
   */
  setRect(width: number, height: number, radius = 26): void {
    this.rect = { width, height, radius };
  }

  /** Las gotas nacen fuera y se juntan en el centro. */
  gather(): void {
    this.seed(false);
  }

  /** La masa central se deshace en gotas que salen despedidas. */
  scatter(): void {
    this.seed(true);
  }

  /**
   * Fase de expansión: la masa circular YA formada en el centro (por gather) crece
   * hasta el rectángulo dado y brotan MÁS gotas del centro hacia afuera, dándole
   * cuerpo, hasta cubrirlo. Es el paso intermedio entre el círculo y la caja: el
   * núcleo redondo se convierte en la silueta del cuadro mientras las gotas lo
   * llenan. Recibe el rectángulo por argumento (no usa `setRect`), para no alterar
   * el modo circular de gather/scatter de esta instancia.
   */
  bloom(width: number, height: number, radius = 24): void {
    window.clearTimeout(this.clearTimer);
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    this.el.classList.remove("is-gathering", "is-scattering", "is-fading", "is-blooming");

    // Núcleo: arranca circular (--core, del tamaño de la masa ya formada) y, en el
    // siguiente frame, transiciona hasta el rectángulo del cuadro.
    const core = document.createElement("div");
    core.className = "materia-fx-dot materia-fx-core materia-fx-core-bloom";
    core.style.width = `${this.core}px`;
    core.style.height = `${this.core}px`;
    core.style.borderRadius = "50%";
    this.el.appendChild(core);

    // MÁS gotas que brotan del centro y se reparten por el interior del rectángulo:
    // le dan cuerpo orgánico a la expansión mientras el núcleo se cuadra.
    const hw = width / 2;
    const hh = height / 2;
    const k = Math.min(width, height) / 220;
    const n = this.dots + 12;
    for (let i = 0; i < n; i++) {
      const bx = (Math.random() * 2 - 1) * hw * 0.92;
      const by = (Math.random() * 2 - 1) * hh * 0.92;
      const size = (14 + Math.random() * 20) * k;
      const dot = document.createElement("div");
      dot.className = "materia-fx-dot";
      dot.style.width = `${size.toFixed(1)}px`;
      dot.style.height = `${size.toFixed(1)}px`;
      dot.style.setProperty("--bx", `${bx.toFixed(1)}px`);
      dot.style.setProperty("--by", `${by.toFixed(1)}px`);
      dot.style.animationDelay = `${i * 5}ms`;
      this.el.appendChild(dot);
    }

    void this.el.offsetWidth;
    this.el.classList.add("is-blooming");
    // Siguiente frame: fijar el tamaño rectangular para que la transición del núcleo
    // (círculo → cuadro) arranque desde el estado circular ya pintado.
    requestAnimationFrame(() => {
      core.style.width = `${width}px`;
      core.style.height = `${height}px`;
      core.style.borderRadius = `${radius}px`;
    });
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

    // Núcleo: la masa central "llena". En modo rectangular tomaría el tamaño y
    // radio del cuadro (sobrescribe el --core circular del CSS); si no, lo fija
    // --core. Se omite cuando solidCore=false: entonces la masa la forman solo las
    // gotas al fundirse, sin un bloque recto detrás (p. ej. el cuadro de ayuda,
    // cuyo relleno lo pone su piel ondulante, no un rectángulo plano).
    if (this.solidCore) {
      const core = document.createElement("div");
      core.className = "materia-fx-dot materia-fx-core";
      if (this.rect) {
        core.style.width = `${this.rect.width}px`;
        core.style.height = `${this.rect.height}px`;
        core.style.borderRadius = `${this.rect.radius}px`;
      }
      this.el.appendChild(core);
    }

    // Escala de las gotas respecto al tamaño base. En modo rectángulo, según el
    // lado menor, para que las gotas guarden proporción con el cuadro.
    const base = this.rect ? Math.min(this.rect.width, this.rect.height) : this.core;
    const k = base / 112;

    for (let i = 0; i < this.dots; i++) {
      const size = (16 + Math.random() * 22) * k;
      let sx: number;
      let sy: number;

      if (this.rect) {
        // Punto de partida sobre el PERÍMETRO del rectángulo, empujado hacia
        // afuera `reach` px en la normal del lado. Así la nube de gotas dibuja un
        // rectángulo —la forma del cuadro— en vez de un círculo. Se recorre el
        // perímetro de forma uniforme y se reparte cada gota en su tramo.
        const hw = this.rect.width / 2;
        const hh = this.rect.height / 2;
        const jitter = (Math.random() - 0.5) * 0.6;
        const u = ((i + 0.5) / this.dots + jitter / this.dots) % 1; // 0..1 por el perímetro
        const p = perimeterPoint(hw, hh, u);
        const push = this.reach * (0.6 + Math.random() * 0.4);
        sx = p.x + p.nx * push;
        sy = p.y + p.ny * push;
      } else {
        // Modo circular original: gotas repartidas por una circunferencia.
        const a = (i / this.dots) * TAU + (Math.random() - 0.5) * 0.7;
        const dist = this.reach * (0.72 + Math.random() * 0.45);
        sx = Math.cos(a) * dist;
        sy = Math.sin(a) * dist;
      }

      const dot = document.createElement("div");
      dot.className = "materia-fx-dot";
      dot.style.width = `${size.toFixed(1)}px`;
      dot.style.height = `${size.toFixed(1)}px`;
      dot.style.setProperty("--sx", `${sx.toFixed(1)}px`);
      dot.style.setProperty("--sy", `${sy.toFixed(1)}px`);
      dot.style.animationDelay = `${i * (scatter ? 7 : 11)}ms`;
      this.el.appendChild(dot);
    }

    // Reflow para reiniciar la animación al re-añadir la clase.
    void this.el.offsetWidth;
    this.el.classList.add(scatter ? "is-scattering" : "is-gathering");
  }
}

/**
 * Punto sobre el perímetro de un rectángulo centrado (semiejes hw, hh) para un
 * parámetro u∈[0,1) que lo recorre, y la normal (nx, ny) que apunta hacia afuera
 * en ese punto. Se usa para lanzar/recoger las gotas desde el contorno del cuadro.
 */
function perimeterPoint(hw: number, hh: number, u: number): { x: number; y: number; nx: number; ny: number } {
  const w = 2 * hw;
  const h = 2 * hh;
  const per = 2 * (w + h);
  let d = u * per;

  // Lado superior (izq→der), derecho (arr→ab), inferior (der→izq), izquierdo (ab→arr).
  if (d < w) return { x: -hw + d, y: -hh, nx: 0, ny: -1 };
  d -= w;
  if (d < h) return { x: hw, y: -hh + d, nx: 1, ny: 0 };
  d -= h;
  if (d < w) return { x: hw - d, y: hh, nx: 0, ny: 1 };
  d -= w;
  return { x: -hw, y: hh - d, nx: -1, ny: 0 };
}

/** True si el usuario pide reducir el movimiento (para saltarse las partículas). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
