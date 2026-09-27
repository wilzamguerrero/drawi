import type { Editor } from "../../app/editor";
import { TAU, clamp } from "../../core/math";
import { el, setClass } from "../dom";
import { MateriaFx, prefersReducedMotion } from "../fx/materia";
import { icon } from "../icons";
import type { Panels } from "../panels";
import { arcPathD, dialText, dialTFromValue, dialValueFromT, needlePathD } from "./arc-geometry";
import { buildRoot, type DialNode, type HotNode, type MenuHooks } from "./menu";

const NS = "http://www.w3.org/2000/svg";

/**
 * Pinta la etiqueta central del menú. Con `label` es texto plano (el nombre del
 * nodo bajo el cursor); sin él (`null`), la marca apilada: ZENCE y, debajo, DRAW
 * del mismo tamaño. La marca es el estado de reposo (raíz del menú).
 */
function setBrandLabel(node: HTMLElement, label: string | null): void {
  if (label !== null) {
    node.classList.remove("is-brand");
    node.textContent = label;
    return;
  }
  node.classList.add("is-brand");
  node.textContent = "";
  node.append(
    el("span", { class: "rm-brand-zence", text: "ZENCE" }),
    el("span", { class: "rm-brand-draw", text: "DRAW" }),
  );
}

// Configuración del menú radial - todo en un solo lugar
const CONFIG = {
  // Radios principales
  centerRadius: 50,
  innerRadius: 90,
  ringThickness: 55,
  submenuGap: 10,
  submenuThickness: 50,

  // Ángulos
  // Hueco entre sectores en PÍXELES (no en ángulo): así el separador mide lo
  // mismo en el borde interior y en el exterior. El desfase angular se calcula
  // por radio en createArc (arco = radio × ángulo).
  // Hueco entre sectores. Un poco mayor porque las esquinas ahora van redondeadas
  // con stroke-linejoin (como el color wheel): el trazo engorda cada sector ~2px
  // por lado, asi que el hueco debe ser > al ancho de trazo para que la separacion
  // y las esquinas redondas se vean.
  gapPx: 7,
  submenuArc: 0.42, // fracción del círculo que ocupa el abanico de un submenú

  // Tamaños de iconos
  iconSize: 28,
  iconSizeSub: 24,

  // Padding alrededor del anillo más externo
  padding: 40,

  get outerRadius() { return this.innerRadius + this.ringThickness; },
};

/** Pulsación sostenida (sin mover) que arranca el sector como trozo flotante. */
const LONG_PRESS_MS = 3000;
/** Si el puntero se aleja más que esto (px) del inicio, ya no es long-press: es un
    arrastre de dial o un gesto normal, y se cancela el armado. */
const LONG_PRESS_MOVE_TOL = 8;

/**
 * Descriptor que emite el menú al arrancar un sector: lo que un `RadialChip`
 * necesita para nacer en el sitio y quedar vivo. `path` liga el trozo al árbol
 * (para re-resolver el nodo y su `onInput` fresco); `viewport` es dónde aparece.
 */
export interface TearOffDescriptor {
  node: HotNode;
  /** Camino de índices desde la raíz (para re-resolver el nodo contra el árbol). */
  path: number[];
  ringLevel: number;
  /** Ancho angular del sector original (a1 − a0). */
  angleWidth: number;
  /** Ángulo medio del sector (radianes). */
  angleMid: number;
  /** Radios interior/exterior del anillo de origen (informativo; el trozo normaliza). */
  innerR: number;
  outerR: number;
  /** Punto medio del arco en coordenadas de viewport (dónde estaba en el menú). */
  viewport: { x: number; y: number };
}

interface RadialSector {
  node: HotNode;
  ringLevel: number; // 1 = círculo central, 2+ = anillos concéntricos
  index: number;
  /** Camino de índices desde la raíz hasta este sector. */
  path: number[];
  path_el: SVGPathElement;
  icon: HTMLElement;
  angleStart: number;
  angleEnd: number;
  angleMid: number;
  /** Capas extra cuando el nodo es un dial: se controla arrastrando por el arco. */
  dial?: {
    /** Arco de relleno desde el inicio hasta el valor actual. */
    fill: SVGPathElement;
    /** Aguja radial en la posición del valor. */
    thumb: SVGPathElement;
    /** Etiqueta (en la capa de iconos) con la lectura del valor. */
    valueLabel: HTMLElement;
  };
}

/** Distribución calculada de un anillo antes de dibujarlo. */
interface RingLayout {
  nodes: HotNode[];
  ringLevel: number;
  parentPath: number[];
  sectors: Array<{ node: HotNode; index: number; a0: number; a1: number; amid: number }>;
}

/**
 * Menú Radial Profesional
 *
 * Los submenús no reemplazan la vista: se despliegan como anillos concéntricos
 * hacia afuera al pasar el cursor, y se puede seguir bajando de nivel (Simetría
 * → Modo → ...). Un rastro de acento desde el centro marca el camino recorrido.
 */
export class RadialMenu {
  readonly el: HTMLElement;

  private editor: Editor;
  private hooks: MenuHooks;
  private panels: Panels;

  private container: HTMLElement;
  private svg: SVGSVGElement;
  private iconsContainer: HTMLElement;
  private centerButton: HTMLElement;
  private centerLabel: HTMLElement;

  /** Partículas (metaball) que forman/deshacen el centro. Sistema compartido. */
  private fx: MateriaFx;
  private fxTimer = 0;

  isOpen = false;
  private posX = 0;
  private posY = 0;

  // Geometría dinámica según la profundidad del árbol.
  private maxRings = 3;
  private svgSize = 610;
  private center = 305;

  private rootNodes: HotNode[] = [];
  /** Cadena de submenús expandidos: openIndices[k] = índice expandido en el anillo k+1.
      Se conserva entre cierres: al reabrir, el menú recuerda cómo estaba. Solo
      el botón central lo limpia por completo. */
  private openIndices: number[] = [];
  /** Camino completo hasta el sector bajo el cursor (para el rastro y el resaltado). */
  private hoveredPath: number[] | null = null;

  /** Dial que se está arrastrando ahora mismo (o null). Mientras dura, el
      pointermove ajusta su valor en vez de mover el hover. */
  private dragDial: RadialSector | null = null;

  /** Punto y sector donde empezó la pulsación actual (para distinguir tap, arrastre
      y long-press). null si no hay pulsación en curso. */
  private pressStart: { x: number; y: number; path: number[] } | null = null;
  /** Timer del long-press que arranca el sector como trozo. */
  private longPressTimer = 0;
  /** Sector con el armado visual (is-arming) puesto, o null. */
  private armingPath: number[] | null = null;
  /** true tras arrancar un trozo en esta pulsación: corta el pointerup siguiente
      para que el mismo gesto no ejecute la acción ni cierre nada dos veces. */
  private torn = false;

  /** Callback al arrancar un sector (long-press): la app crea el trozo flotante. */
  onTearOff: ((desc: TearOffDescriptor) => void) | null = null;

  private sectors: RadialSector[] = [];
  /** Claves de los anillos ya dibujados en el rebuild anterior. Sirve para animar
      solo el anillo que se acaba de desplegar y no los que ya estaban. */
  private prevRingKeys = new Set<string>();

  /** Camino activo: el del cursor si hay hover; si no, la expansión recordada.
      Alimenta el haz del rastro y el resaltado del camino. */
  private get activePath(): number[] {
    return this.hoveredPath ?? this.openIndices;
  }

  constructor(editor: Editor, hooks: MenuHooks, panels: Panels) {
    this.editor = editor;
    this.hooks = hooks;
    this.panels = panels;

    this.svg = this.createSVG();
    this.iconsContainer = el("div", { class: "rm-icons" });
    this.centerLabel = el("span", { class: "rm-center-label" });
    setBrandLabel(this.centerLabel, null);
    this.centerButton = el("button", {
      class: "rm-center-btn materia-blob",
      type: "button"
    }, [
      el("span", { class: "rm-center-icon", html: icon("back") }),
      this.centerLabel,
    ]);

    this.container = el("div", { class: "rm-container" }, [
      this.svg as unknown as HTMLElement,
      this.iconsContainer,
      this.centerButton,
    ]);

    // Capa de partículas: hermana del contenedor (no hija), así la opacidad del
    // menú al abrir/cerrar no la afecta. Se coloca en el centro en cada show().
    // Sistema compartido (mismo que paneles y rueda de color).
    this.fx = new MateriaFx({ coreSize: 112, reach: 96 });

    // fx va antes que el contenedor: el botón central (en el contenedor) pinta por
    // encima de las partículas durante el relevo.
    this.el = el("div", { class: "radial-menu" }, [this.fx.el, this.container]);
    this.el.hidden = true;

    this.setupEvents();
  }

  private createSVG(): SVGSVGElement {
    const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
    svg.setAttribute("class", "rm-svg");
    this.applySvgSize(svg);
    return svg;
  }

  private applySvgSize(svg: SVGSVGElement = this.svg): void {
    svg.setAttribute("viewBox", `0 0 ${this.svgSize} ${this.svgSize}`);
    svg.setAttribute("width", String(this.svgSize));
    svg.setAttribute("height", String(this.svgSize));
  }

  // ---------------------------------------------------------------- geometría

  /** Radio interior del anillo de nivel L (1 = círculo central). */
  private ringInner(level: number): number {
    if (level <= 1) return CONFIG.innerRadius;
    return CONFIG.outerRadius + (level - 1) * CONFIG.submenuGap + (level - 2) * CONFIG.submenuThickness;
  }

  /** Radio exterior del anillo de nivel L. */
  private ringOuter(level: number): number {
    if (level <= 1) return CONFIG.outerRadius;
    return this.ringInner(level) + CONFIG.submenuThickness;
  }

  /** Radio medio (donde van los iconos) del anillo de nivel L. */
  private ringMid(level: number): number {
    return (this.ringInner(level) + this.ringOuter(level)) / 2;
  }

  /** Profundidad máxima del árbol (cuántos anillos concéntricos puede haber). */
  private treeDepth(nodes: HotNode[]): number {
    let max = 1;
    for (const n of nodes) {
      if (n.kind === "submenu") max = Math.max(max, 1 + this.treeDepth(n.children));
    }
    return max;
  }

  /**
   * Recorta una cadena de expansión al árbol actual: al reabrir el menú con otra
   * herramienta activa, algún índice puede quedar fuera de rango o dejar de ser
   * un submenú. Se conserva el prefijo válido y se descarta el resto.
   */
  private validateOpenIndices(indices: number[]): number[] {
    const valid: number[] = [];
    let nodes = this.rootNodes;
    for (const idx of indices) {
      const node = nodes[idx];
      if (!node || node.kind !== "submenu") break;
      valid.push(idx);
      nodes = node.children;
    }
    return valid;
  }

  private setupEvents(): void {
    this.container.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.container.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.container.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.container.addEventListener("pointercancel", (e) => this.onPointerCancel(e));
    // El botón central limpia toda la expansión (vuelve a la raíz). Si ya está
    // en la raíz, cierra el menú.
    this.centerButton.addEventListener("click", () => this.collapseOrClose());

    // Clic en el backdrop (área vacía de pantalla completa): cerrar.
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });

    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  get isVisible(): boolean {
    return this.isOpen;
  }

  show(x: number, y: number, openPath?: number[]): void {
    this.rootNodes = buildRoot(this.editor, this.editor.state, this.hooks);

    // Dimensionar el SVG para la profundidad real del árbol.
    this.maxRings = this.treeDepth(this.rootNodes);
    this.svgSize = 2 * (this.ringOuter(this.maxRings) + CONFIG.padding);
    this.center = this.svgSize / 2;
    this.applySvgSize();

    // Clamp para que el menú siempre quede visible.
    const margin = this.ringOuter(this.maxRings) + CONFIG.padding + 10;
    this.posX = clamp(x, margin, window.innerWidth - margin);
    this.posY = clamp(y, margin, window.innerHeight - margin);

    this.isOpen = true;
    this.el.hidden = false;

    this.container.style.left = `${this.posX}px`;
    this.container.style.top = `${this.posY}px`;

    // Recordar la expansión anterior, pero validarla: el árbol pudo cambiar
    // (otra herramienta activa) y algún índice ya no apuntar a un submenú. Con
    // `openPath` (reabrir desde un trozo-submenú) se fuerza esa rama en su lugar.
    this.openIndices = this.validateOpenIndices(openPath ?? this.openIndices);
    this.hoveredPath = null;

    // Empezar de cero: en la apertura, todos los anillos expandidos se animan.
    this.prevRingKeys.clear();

    this.rebuild();

    window.clearTimeout(this.fxTimer);
    this.container.classList.remove("is-closing", "is-forming", "is-dissolving", "is-opening");
    this.container.classList.add("is-open");

    if (prefersReducedMotion()) {
      // Sin movimiento: aparición directa, sin partículas.
      this.fx.clear();
      return;
    }

    // Las partículas se juntan y forman el centro; los anillos y el botón esperan
    // (encogidos/ocultos por .is-forming) hasta que la masa está hecha. Al quitar
    // .is-forming, cada capa entra con su transición: los anillos crecen desde el
    // centro y el botón se funde con la masa (mismo negro). El relevo es continuo.
    this.container.classList.add("is-forming");
    this.fx.center(this.posX, this.posY);
    this.fx.gather();

    this.fxTimer = window.setTimeout(() => {
      if (!this.isOpen) return;
      this.container.classList.remove("is-forming");
      this.fx.fadeOut();
    }, this.fx.gatherMs);
  }

  close(): void {
    if (!this.isOpen) return;

    this.isOpen = false;
    window.clearTimeout(this.fxTimer);
    this.container.classList.remove("is-opening", "is-forming", "is-open");

    if (prefersReducedMotion()) {
      this.container.classList.add("is-closing");
      this.fxTimer = window.setTimeout(() => {
        if (!this.isOpen) {
          this.el.hidden = true;
          this.container.classList.remove("is-closing");
        }
      }, 250);
      return;
    }

    // El centro se desintegra en partículas mientras los anillos se van.
    this.container.classList.add("is-closing", "is-dissolving");
    this.fx.center(this.posX, this.posY);
    this.fx.scatter();

    this.fxTimer = window.setTimeout(() => {
      if (!this.isOpen) {
        this.el.hidden = true;
        this.container.classList.remove("is-closing", "is-dissolving");
        this.fx.clear();
      }
    }, this.fx.scatterMs);
  }

  dispose(): void {
    this.el.remove();
  }

  // ------------------------------------------------------------ construcción

  /**
   * Calcula la distribución de todos los anillos visibles a partir de
   * openIndices. El anillo 1 es el círculo completo; cada submenú expandido
   * añade un anillo concéntrico centrado en la mitad del sector padre.
   */
  private computeLayout(): RingLayout[] {
    const layouts: RingLayout[] = [];
    let nodes = this.rootNodes;
    let parentPath: number[] = [];
    let centerAngle = 0; // solo relevante a partir del anillo 2

    for (let level = 1; ; level++) {
      const count = nodes.length;
      if (count === 0) break;

      const sectors: RingLayout["sectors"] = [];

      if (level === 1) {
        // Círculo completo, empezando arriba (norte).
        const step = TAU / count;
        const start = -Math.PI / 2;
        for (let i = 0; i < count; i++) {
          const a0 = start + i * step;
          const a1 = start + (i + 1) * step;
          sectors.push({ node: nodes[i], index: i, a0, a1, amid: (a0 + a1) / 2 });
        }
      } else {
        // Abanico centrado en la mitad del sector padre.
        const arcSpan = TAU * CONFIG.submenuArc;
        const step = arcSpan / count;
        const start = centerAngle - arcSpan / 2;
        for (let i = 0; i < count; i++) {
          const a0 = start + i * step;
          const a1 = start + (i + 1) * step;
          sectors.push({ node: nodes[i], index: i, a0, a1, amid: (a0 + a1) / 2 });
        }
      }

      layouts.push({ nodes, ringLevel: level, parentPath: [...parentPath], sectors });

      // ¿Hay un submenú expandido en este nivel? Si sí, prepara el siguiente.
      const openIdx = this.openIndices[level - 1];
      if (openIdx === undefined) break;
      const openNode = nodes[openIdx];
      if (!openNode || openNode.kind !== "submenu") break;

      centerAngle = sectors[openIdx].amid;
      parentPath = [...parentPath, openIdx];
      nodes = openNode.children;
    }

    return layouts;
  }

  private rebuild(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.iconsContainer.innerHTML = "";
    this.sectors = [];

    const layouts = this.computeLayout();

    // Anima solo los anillos nuevos respecto al rebuild anterior. La clave de un
    // anillo es su rama (parentPath): si esa rama ya estaba dibujada, no se
    // re-anima; solo el nivel recién desplegado hace su entrada.
    const nextKeys = new Set<string>();
    for (const ring of layouts) {
      const key = ring.parentPath.join(",");
      nextKeys.add(key);
      const isNew = ring.ringLevel > 1 && !this.prevRingKeys.has(key);
      this.drawRing(ring, isNew);
    }
    this.prevRingKeys = nextKeys;

    this.updateCenterButton();
    this.updateHover();
    // El rebuild recreó los sectores: vuelve a poner el armado del long-press si
    // lo hay (p. ej. al expandir un submenú manteniéndolo pulsado).
    this.applyArmingVisual();
  }

  private drawRing(ring: RingLayout, animate: boolean): void {
    const innerR = this.ringInner(ring.ringLevel);
    const outerR = this.ringOuter(ring.ringLevel);
    const midR = this.ringMid(ring.ringLevel);
    const iconSize = ring.ringLevel === 1 ? CONFIG.iconSize : CONFIG.iconSizeSub;
    const isSub = ring.ringLevel > 1;

    // Escalonado desde el centro hacia los lados: el retardo crece con la
    // distancia al sector del medio, así el abanico se abre simétrico y no de
    // izquierda a derecha.
    const mid = (ring.sectors.length - 1) / 2;

    for (const s of ring.sectors) {
      const path = this.createArc(innerR, outerR, s.a0, s.a1);
      const sectorPath = [...ring.parentPath, s.index];
      this.styleSector(path, s.node, isSub, sectorPath);

      const delay = `${(Math.abs(s.index - mid) * 0.04).toFixed(3)}s`;
      if (animate) {
        path.classList.add("is-deploying");
        path.style.animationDelay = delay;
      }
      this.svg.appendChild(path);

      const iconEl = this.createIcon(s.node, s.amid, midR, iconSize, isSub);
      if (animate) {
        iconEl.classList.add("is-deploying");
        iconEl.style.animationDelay = delay;
      }
      this.iconsContainer.appendChild(iconEl);

      const sector: RadialSector = {
        node: s.node,
        ringLevel: ring.ringLevel,
        index: s.index,
        path: sectorPath,
        path_el: path,
        icon: iconEl,
        angleStart: s.a0,
        angleEnd: s.a1,
        angleMid: s.amid,
      };
      this.sectors.push(sector);

      // Dial: capas de relleno + aguja sobre el arco, para arrastrarlo como slider.
      if (s.node.kind === "dial") this.decorateDial(sector, animate ? delay : null);
    }
  }

  /**
   * Convierte el sector de un dial en un slider con forma de arco: un arco de
   * relleno que crece desde el inicio hasta el valor actual y una aguja radial en
   * esa posición. El valor se ajusta arrastrando por el propio arco (onPointerMove
   * mientras `dragDial` apunta a este sector).
   */
  private decorateDial(sector: RadialSector, delay: string | null): void {
    const fill = document.createElementNS(NS, "path") as SVGPathElement;
    fill.setAttribute("class", "rm-dial-fill");
    const thumb = document.createElementNS(NS, "path") as SVGPathElement;
    thumb.setAttribute("class", "rm-dial-thumb");

    if (delay !== null) {
      fill.classList.add("is-deploying");
      thumb.classList.add("is-deploying");
      fill.style.animationDelay = delay;
      thumb.style.animationDelay = delay;
    }

    // Van tras el sector base (encima de él) y antes de los siguientes sectores.
    this.svg.appendChild(fill);
    this.svg.appendChild(thumb);

    sector.dial = { fill, thumb, valueLabel: sector.icon };
    this.updateDialVisual(sector);
  }

  /** Repinta el relleno, la aguja y la lectura de un dial según su valor actual. */
  private updateDialVisual(sector: RadialSector): void {
    if (!sector.dial) return;
    const node = sector.node as DialNode;
    const innerR = this.ringInner(sector.ringLevel);
    const outerR = this.ringOuter(sector.ringLevel);
    const t = dialTFromValue(node);
    const aVal = sector.angleStart + t * (sector.angleEnd - sector.angleStart);

    // Relleno vacío cuando el valor está al mínimo (arco degenerado: se oculta).
    sector.dial.fill.setAttribute("d", t <= 0.002 ? "" : this.arcD(innerR, outerR, sector.angleStart, aVal));
    sector.dial.thumb.setAttribute("d", this.needleD(innerR, outerR, aVal));
    sector.dial.valueLabel.textContent = dialText(node, false);
  }

  /**
   * Resalta el camino recorrido sin reconstruir los anillos (así el abanico no
   * se re-anima en cada hover). Dos señales combinadas:
   *  - Los sectores ancestros del camino activo llevan `is-onpath` (tinte suave).
   *  - Un arco grueso de acento en el borde interno (el inicio) de cada sector
   *    del camino, que marca "por dónde avancé" sin cruzar los anillos.
   * Se usa `activePath` (hover o, si no hay, la expansión persistida) para que al
   * reabrir el menú se vea la última selección aunque el cursor esté en otro sitio.
   */
  private updateActivePathVisuals(): void {
    const active = this.activePath;

    // Limpia los marcadores previos (se redibujan según el camino actual).
    for (const mark of Array.from(this.svg.querySelectorAll(".rm-onpath-mark"))) {
      mark.remove();
    }

    for (const sector of this.sectors) {
      // En el camino = submenú abierto cuya ruta es prefijo del camino activo.
      // Incluye el último nivel desplegado (p. ej. Modo), no solo sus ancestros,
      // para que la marca se quede aunque el cursor no esté encima.
      const onPath =
        sector.path.length > 0 &&
        sector.node.kind === "submenu" &&
        isPrefix(sector.path, active);
      setClass(sector.path_el, "is-onpath", onPath);
      if (onPath) this.drawOnPathMark(sector);
    }
  }

  /**
   * Marca de acento gruesa en el borde interno de un sector del camino: un arco
   * pegado al inicio del botón (lado que mira al centro), como en la referencia.
   */
  private drawOnPathMark(sector: RadialSector): void {
    const c = this.center;
    const r = this.ringInner(sector.ringLevel) + 2;
    const halfGap = CONFIG.gapPx / 2 / r;
    const a0 = sector.angleStart + halfGap;
    const a1 = sector.angleEnd - halfGap;

    const x1 = c + Math.cos(a0) * r;
    const y1 = c + Math.sin(a0) * r;
    const x2 = c + Math.cos(a1) * r;
    const y2 = c + Math.sin(a1) * r;
    const largeArc = (a1 - a0) > Math.PI ? 1 : 0;

    const mark = document.createElementNS(NS, "path") as SVGPathElement;
    mark.setAttribute("d", `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`);
    mark.setAttribute("class", "rm-onpath-mark");
    this.svg.appendChild(mark);
  }

  private createArc(innerR: number, outerR: number, startA: number, endA: number): SVGPathElement {
    const path = document.createElementNS(NS, "path") as SVGPathElement;
    path.setAttribute("d", this.arcD(innerR, outerR, startA, endA));
    return path;
  }

  /** El atributo `d` de un sector anular (con el hueco de ancho constante). Lo
      comparten el sector base y el relleno de los dials. Envoltorio fino sobre
      `arcPathD` (arc-geometry.ts) que pasa el centro del menú y `CONFIG.gapPx`. */
  private arcD(innerR: number, outerR: number, startA: number, endA: number): string {
    return arcPathD({
      cx: this.center,
      cy: this.center,
      innerR,
      outerR,
      a0: startA,
      a1: endA,
      gapPx: CONFIG.gapPx,
    });
  }

  /** Aguja radial (del borde interior al exterior) en un ángulo dado: el "pulgar"
      del dial que marca la posición del valor sobre el arco. Envoltorio fino sobre
      `needlePathD` (arc-geometry.ts). */
  private needleD(innerR: number, outerR: number, angle: number): string {
    return needlePathD(this.center, this.center, innerR, outerR, angle);
  }

  private createIcon(node: HotNode, angle: number, radius: number, size: number, isSub: boolean): HTMLElement {
    const c = this.center;
    const x = c + Math.cos(angle) * radius;
    const y = c + Math.sin(angle) * radius;

    const iconEl = el("div", {
      class: `rm-icon${isSub ? " rm-icon-sub" : ""}`,
      style: {
        left: `${x}px`,
        top: `${y}px`,
        width: `${size}px`,
        height: `${size}px`,
      },
    });

    if (node.kind === "dial") {
      // El dial muestra su valor (no un icono): la lectura vive en el centro del arco.
      iconEl.classList.add("rm-icon-dial");
      iconEl.textContent = dialText(node, false);
    } else if (node.accent && node.id.startsWith("swatch-")) {
      iconEl.style.background = node.accent;
      iconEl.classList.add("rm-icon-swatch");
    } else if (node.icon) {
      iconEl.innerHTML = icon(node.icon);
    } else if (node.accent) {
      iconEl.style.background = node.accent;
      iconEl.classList.add("rm-icon-color");
    } else {
      iconEl.classList.add("rm-icon-text");
      iconEl.textContent = this.shortLabel(node.label);
    }

    // Indicador de que el nodo tiene más niveles (submenú).
    if (node.kind === "submenu") iconEl.classList.add("rm-icon-has-children");

    return iconEl;
  }

  private shortLabel(label: string): string {
    if (/^\d+$/.test(label) && label.length <= 3) return label;
    const words = label.split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return label.slice(0, 3);
  }

  private styleSector(path: SVGPathElement, node: HotNode, isSub: boolean, _sectorPath: number[]): void {
    path.setAttribute("class", isSub ? "rm-sector rm-sector-sub" : "rm-sector rm-sector-main");
    if (node.active) path.classList.add("is-active");
    if (node.disabled) path.classList.add("is-disabled");
    if (node.kind === "submenu") path.classList.add("has-submenu");
    if (node.kind === "dial") path.classList.add("is-dial");
    // El resaltado del camino (is-onpath) lo aplica updateActivePathVisuals, que
    // se refresca en cada hover sin reconstruir los sectores.
  }

  // -------------------------------------------------------------- interacción

  private onPointerMove(e: PointerEvent): void {
    // Si hay una pulsación armada y el puntero se aleja del inicio, ya no es un
    // long-press: es un arrastre (de dial) o un gesto normal. Se cancela el armado.
    if (this.pressStart) {
      const dx = e.clientX - this.pressStart.x;
      const dy = e.clientY - this.pressStart.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOL) this.cancelLongPress();
    }

    // Arrastrando un dial: el movimiento ajusta su valor, no el hover.
    if (this.dragDial) {
      this.applyDialDrag(e, this.dragDial);
      return;
    }

    const rect = this.container.getBoundingClientRect();
    const dx = e.clientX - rect.left - this.center;
    const dy = e.clientY - rect.top - this.center;
    const dist = Math.hypot(dx, dy);
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += TAU;

    // En el hueco central: no hay sector, pero se mantiene la expansión actual.
    if (dist < CONFIG.innerRadius) {
      if (this.hoveredPath !== null) {
        this.hoveredPath = null;
        this.updateHover();
      }
      return;
    }

    let found: RadialSector | null = null;
    for (const sector of this.sectors) {
      const inRadius = dist >= this.ringInner(sector.ringLevel) && dist <= this.ringOuter(sector.ringLevel);
      if (!inRadius) continue;

      let start = sector.angleStart;
      let end = sector.angleEnd;
      while (start < 0) start += TAU;
      while (end < 0) end += TAU;
      while (start >= TAU) start -= TAU;
      while (end >= TAU) end -= TAU;

      if (end < start) {
        if (angle >= start || angle <= end) { found = sector; break; }
      } else {
        if (angle >= start && angle <= end) { found = sector; break; }
      }
    }

    const newHoveredPath = found ? found.path : null;
    if (pathEq(newHoveredPath, this.hoveredPath)) return;

    this.hoveredPath = newHoveredPath;

    // La cadena de expansión es: si el sector es submenú, se expande él mismo
    // (su camino); si es una hoja, se mantiene expandido su padre.
    const newOpen = found
      ? (found.node.kind === "submenu" ? [...found.path] : found.path.slice(0, -1))
      : this.openIndices;

    if (!pathEq(newOpen, this.openIndices)) {
      this.openIndices = newOpen;
      this.rebuild(); // rebuild vuelve a resolver el hover por camino
    } else {
      this.updateHover();
    }
  }

  private updateHover(): void {
    const hp = this.hoveredPath;
    let hoveredNode: HotNode | null = null;

    for (const sector of this.sectors) {
      const isHovered = hp !== null && pathEq(sector.path, hp);
      setClass(sector.path_el, "is-hover", isHovered);
      setClass(sector.icon, "is-hover", isHovered);
      if (isHovered) hoveredNode = sector.node;
    }

    this.setCenterLabel(hoveredNode);

    // Refresca el resaltado del camino y el haz central sin reconstruir.
    this.updateActivePathVisuals();
  }

  /** Etiqueta central según el nodo bajo el cursor: la marca en reposo, el nombre
      de un nodo normal, o nombre + lectura cuando es un dial (para verlo al
      arrastrar). */
  private setCenterLabel(node: HotNode | null): void {
    if (node && node.kind === "dial") {
      this.centerLabel.classList.remove("is-brand");
      this.centerLabel.classList.add("is-dial");
      this.centerLabel.textContent = "";
      this.centerLabel.append(
        el("span", { class: "rm-dial-name", text: node.label }),
        el("span", { class: "rm-dial-read", text: dialText(node, true) }),
      );
      return;
    }
    this.centerLabel.classList.remove("is-dial");
    setBrandLabel(this.centerLabel, node ? node.label : null);
  }

  private onPointerDown(e: PointerEvent): void {
    e.preventDefault();

    this.torn = false;
    this.cancelLongPress();

    const hovered = this.hoveredPath ? this.findSector(this.hoveredPath) : null;
    if (!hovered) {
      this.close();
      return;
    }

    const node = hovered.node;
    if (node.disabled) return;

    // Cualquier sector se puede arrancar como trozo flotante manteniéndolo pulsado
    // (sin mover) ~3 s. Se arma aquí; onPointerMove lo cancela si el puntero se
    // aleja y onPointerUp/onPointerCancel al soltar antes de tiempo.
    this.pressStart = { x: e.clientX, y: e.clientY, path: [...hovered.path] };
    this.armLongPress(hovered);

    // Los submenús se expanden al pulsar (además de al pasar el cursor). El rebuild
    // vuelve a aplicar el armado (ver rebuild()).
    if (node.kind === "submenu") {
      if (!pathEq([...hovered.path], this.openIndices)) {
        this.openIndices = [...hovered.path];
        this.rebuild();
      }
      return;
    }

    // Dial: empieza el arrastre. El valor salta ya a donde se pulsó (como tocar un
    // slider) y luego sigue el cursor por el arco hasta soltar. Si el puntero se
    // queda quieto, salta el long-press y se arranca en vez de ajustar.
    if (node.kind === "dial") {
      this.dragDial = hovered;
      this.container.classList.add("is-dial-drag");
      try { this.container.setPointerCapture(e.pointerId); } catch { /* sin captura: no pasa nada */ }
      this.applyDialDrag(e, hovered);
      return;
    }

    // Acción: ya NO se ejecuta aquí. Se ejecuta en onPointerUp si no hubo long-press
    // ni movimiento, para no dispararse durante el armado del trozo.
  }

  private onPointerUp(e: PointerEvent): void {
    const wasTorn = this.torn;
    const press = this.pressStart;
    const draggedDial = this.dragDial;

    this.cancelLongPress();

    if (this.dragDial) {
      this.dragDial = null;
      this.container.classList.remove("is-dial-drag");
      try { this.container.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    }

    // El gesto arrancó un trozo: no se ejecuta nada más (el menú ya se cerró).
    if (wasTorn) return;
    // Un dial se ajustó arrastrando: nada que ejecutar al soltar.
    if (draggedDial) return;

    // Tap sobre una acción (sin long-press ni arrastre): ejecutarla ahora.
    if (press) {
      const sector = this.findSector(press.path);
      if (sector && !sector.node.disabled && sector.node.kind === "action") {
        this.executeNode(sector.node);
      }
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    this.cancelLongPress();
    if (this.dragDial) {
      this.dragDial = null;
      this.container.classList.remove("is-dial-drag");
      try { this.container.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    }
  }

  /** Arranca el temporizador del long-press sobre un sector y le pone el armado
      visual (is-arming: relleno que crece ~3 s como realimentación). Al cumplirse,
      arranca el trozo. */
  private armLongPress(sector: RadialSector): void {
    window.clearTimeout(this.longPressTimer);
    this.armingPath = [...sector.path];
    this.applyArmingVisual();
    this.longPressTimer = window.setTimeout(() => {
      // Re-resolver por si un rebuild (expandir submenú) recreó los sectores.
      const target = this.pressStart ? this.findSector(this.pressStart.path) : null;
      if (target) this.tearOff(target);
    }, LONG_PRESS_MS);
  }

  /** Cancela el long-press en curso (soltar, mover o arrancar) y quita el armado. */
  private cancelLongPress(): void {
    window.clearTimeout(this.longPressTimer);
    this.longPressTimer = 0;
    this.pressStart = null;
    this.armingPath = null;
    this.applyArmingVisual();
  }

  /** Refleja `armingPath` en el DOM: solo ese sector lleva `is-arming`. */
  private applyArmingVisual(): void {
    for (const sector of this.sectors) {
      setClass(sector.path_el, "is-arming", this.armingPath !== null && pathEq(sector.path, this.armingPath));
    }
  }

  /**
   * Arranca un sector como trozo flotante: construye el descriptor (nodo, camino,
   * geometría y punto medio del arco en viewport) y lo emite por `onTearOff`; luego
   * cierra el menú. `torn` corta el pointerup para que el mismo gesto no ejecute la
   * acción ni ajuste el dial.
   */
  private tearOff(sector: RadialSector): void {
    this.torn = true;
    this.cancelLongPress();

    const midR = this.ringMid(sector.ringLevel);
    // El contenedor está centrado en (posX, posY) con translate(-50%,-50%): un punto
    // del SVG a ángulo a, radio r, cae en viewport (posX + cos a·r, posY + sin a·r).
    const viewport = {
      x: this.posX + Math.cos(sector.angleMid) * midR,
      y: this.posY + Math.sin(sector.angleMid) * midR,
    };

    this.onTearOff?.({
      node: sector.node,
      path: [...sector.path],
      ringLevel: sector.ringLevel,
      angleWidth: sector.angleEnd - sector.angleStart,
      angleMid: sector.angleMid,
      innerR: this.ringInner(sector.ringLevel),
      outerR: this.ringOuter(sector.ringLevel),
      viewport,
    });

    this.close();
  }

  /** Ajusta el valor de un dial según el ángulo del cursor sobre su arco. */
  private applyDialDrag(e: PointerEvent, sector: RadialSector): void {
    const node = sector.node as DialNode;
    const rect = this.container.getBoundingClientRect();
    const dx = e.clientX - rect.left - this.center;
    const dy = e.clientY - rect.top - this.center;
    const angle = Math.atan2(dy, dx);

    // Lleva el ángulo del cursor al rango continuo del sector [angleStart, angleEnd]
    // (que puede ser negativo o mayor que TAU), y saca la posición t (0..1).
    let a = angle;
    while (a < sector.angleStart - Math.PI) a += TAU;
    while (a > sector.angleStart + Math.PI) a -= TAU;
    const t = clamp((a - sector.angleStart) / (sector.angleEnd - sector.angleStart || 1), 0, 1);

    const v = dialValueFromT(node, t);
    if (v !== node.value) {
      node.value = v;
      node.onInput(v);
    }
    this.updateDialVisual(sector);
    this.setCenterLabel(node);
  }

  private findSector(path: number[]): RadialSector | null {
    return this.sectors.find((s) => pathEq(s.path, path)) ?? null;
  }

  /** Botón central: colapsa toda la expansión; si ya está en la raíz, cierra. */
  private collapseOrClose(): void {
    if (this.openIndices.length > 0) {
      this.openIndices = [];
      this.hoveredPath = null;
      this.rebuild();
    } else {
      this.close();
    }
  }

  private executeNode(node: HotNode): void {
    switch (node.kind) {
      case "action": {
        const action = node as Extract<HotNode, { kind: "action" }>;

        if (action.canFloat && action.buildPanel) {
          this.panels.toggle(
            { id: action.id, title: action.label, build: action.buildPanel },
            this.posX,
            this.posY
          );
          this.close();
          return;
        }

        action.run();
        if (!action.keepOpen) {
          this.close();
        } else {
          this.refresh();
        }
        break;
      }
      case "dial":
        // El dial se ajusta arrastrando por su arco (onPointerDown → dragDial),
        // no ejecutando una acción; aquí no hay nada que hacer.
        break;
    }
  }

  private updateCenterButton(): void {
    // El botón central siempre cierra; se muestra el título de la raíz.
    setClass(this.centerButton, "can-back", false);
    if (this.hoveredPath === null) setBrandLabel(this.centerLabel, null);
  }

  private refresh(): void {
    this.rootNodes = buildRoot(this.editor, this.editor.state, this.hooks);
    this.rebuild();
  }
}

/** Igualdad de caminos (arrays de índices), tolerante a null. */
function pathEq(a: number[] | null, b: number[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** ¿`prefix` es prefijo (inicial) de `full`? */
function isPrefix(prefix: number[], full: number[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== full[i]) return false;
  return true;
}
