import type { Editor } from "../../app/editor";
import { TAU, clamp } from "../../core/math";
import { el, setClass } from "../dom";
import { icon } from "../icons";
import type { Panels } from "../panels";
import { buildRoot, type HotNode, type MenuHooks } from "./menu";

const NS = "http://www.w3.org/2000/svg";

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
  gapPx: 3,
  submenuArc: 0.35, // 35% del círculo = ~126 grados

  // Tamaños de iconos
  iconSize: 28,
  iconSizeSub: 24,

  // Padding
  padding: 40,

  get outerRadius() { return this.innerRadius + this.ringThickness; },
  get submenuInner() { return this.outerRadius + this.submenuGap; },
  get submenuOuter() { return this.submenuInner + this.submenuThickness; },
  get svgSize() { return 2 * (this.submenuOuter + this.padding); },
  get center() { return this.svgSize / 2; },
};

interface RadialSector {
  node: HotNode;
  level: 1 | 2;
  index: number;
  path: SVGPathElement;
  icon: HTMLElement;
  angleStart: number;
  angleEnd: number;
  angleMid: number;
}

/**
 * Menú Radial Profesional - Versión 2
 *
 * Sistema completamente reescrito con:
 * - Código limpio y modular
 * - Posicionamiento preciso
 * - Responsivo y escalable
 * - Basado en el estilo de Godot
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

  isOpen = false;
  private posX = 0;
  private posY = 0;

  private menuStack: Array<{ nodes: HotNode[]; title: string }> = [];
  private sectors: RadialSector[] = [];
  private expandedIndex = -1;
  private hoveredSector: RadialSector | null = null;

  constructor(editor: Editor, hooks: MenuHooks, panels: Panels) {
    this.editor = editor;
    this.hooks = hooks;
    this.panels = panels;

    // Crear estructura DOM
    this.svg = this.createSVG();
    this.iconsContainer = el("div", { class: "rm-icons" });
    this.centerLabel = el("span", { class: "rm-center-label", text: "drawi" });
    this.centerButton = el("button", {
      class: "rm-center-btn",
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

    this.el = el("div", { class: "radial-menu" }, [this.container]);
    this.el.hidden = true;

    this.setupEvents();
  }

  private createSVG(): SVGSVGElement {
    const svg = document.createElementNS(NS, "svg") as SVGSVGElement;
    svg.setAttribute("class", "rm-svg");
    svg.setAttribute("viewBox", `0 0 ${CONFIG.svgSize} ${CONFIG.svgSize}`);
    svg.setAttribute("width", String(CONFIG.svgSize));
    svg.setAttribute("height", String(CONFIG.svgSize));
    return svg;
  }

  private setupEvents(): void {
    this.container.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.container.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.centerButton.addEventListener("click", () => this.navigateBack());

    // Clic fuera del contenedor (en el backdrop de pantalla completa): cerrar.
    // El evento en el contenedor no se propaga aquí porque onPointerDown ya lo
    // maneja; este solo se dispara en el área vacía alrededor del menú.
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.close();
    });

    // Prevenir menú contextual
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  get isVisible(): boolean {
    return this.isOpen;
  }

  show(x: number, y: number): void {
    // Clamp position para que el menú siempre esté visible
    const margin = CONFIG.submenuOuter + CONFIG.padding + 20;
    this.posX = clamp(x, margin, window.innerWidth - margin);
    this.posY = clamp(y, margin, window.innerHeight - margin);

    this.isOpen = true;
    this.el.hidden = false;

    // Posicionar el contenedor
    this.container.style.left = `${this.posX}px`;
    this.container.style.top = `${this.posY}px`;

    // Inicializar menú
    this.menuStack = [{
      nodes: buildRoot(this.editor, this.editor.state, this.hooks),
      title: "drawi"
    }];
    this.expandedIndex = -1;
    this.hoveredSector = null;

    this.rebuild();

    // Animación de entrada
    this.container.classList.remove("is-closing");
    this.container.classList.add("is-opening");
  }

  close(): void {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.container.classList.remove("is-opening");
    this.container.classList.add("is-closing");

    setTimeout(() => {
      if (!this.isOpen) {
        this.el.hidden = true;
        this.container.classList.remove("is-closing");
      }
    }, 250);
  }

  dispose(): void {
    this.el.remove();
  }

  private get currentLevel(): { nodes: HotNode[]; title: string } {
    return this.menuStack[this.menuStack.length - 1];
  }

  private rebuild(): void {
    // Limpiar
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.iconsContainer.innerHTML = "";
    this.sectors = [];

    const { nodes } = this.currentLevel;

    // Dibujar nivel principal (círculo completo)
    this.drawMainLevel(nodes);

    // Dibujar submenú si hay uno expandido
    if (this.expandedIndex >= 0 && this.expandedIndex < nodes.length) {
      const parent = nodes[this.expandedIndex];
      if (parent.kind === "submenu") {
        this.drawSubmenu(parent.children, this.expandedIndex, nodes.length);
      }
    }

    // Actualizar botón central
    this.updateCenterButton();
  }

  private drawMainLevel(nodes: HotNode[]): void {
    const count = nodes.length;
    const angleStep = TAU / count;
    const startAngle = -Math.PI / 2; // Empezar arriba

    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      // Ángulos completos del sector (sin hueco): sirven para el hover, así no
      // quedan zonas muertas entre sectores. El hueco visual lo aplica
      // createArc por radio.
      const a0 = startAngle + i * angleStep;
      const a1 = startAngle + (i + 1) * angleStep;
      const amid = (a0 + a1) / 2;

      // Crear sector
      const path = this.createArc(
        CONFIG.innerRadius,
        CONFIG.outerRadius,
        a0,
        a1
      );

      this.styleMainSector(path, node);
      this.svg.appendChild(path);

      // Crear icono
      const iconEl = this.createIcon(node, amid,
        CONFIG.innerRadius + CONFIG.ringThickness / 2,
        CONFIG.iconSize,
        false
      );

      this.iconsContainer.appendChild(iconEl);

      this.sectors.push({
        node,
        level: 1,
        index: i,
        path,
        icon: iconEl,
        angleStart: a0,
        angleEnd: a1,
        angleMid: amid,
      });
    }
  }

  private drawSubmenu(nodes: HotNode[], parentIndex: number, parentCount: number): void {
    const count = nodes.length;

    // Ángulo de la MITAD del sector padre. El sector i va de i*step a
    // (i+1)*step, así que su centro está en (i + 0.5)*step. Usar el borde
    // (parentIndex*step) descentraba el submenú hacia un lado; con la mitad
    // el abanico queda simétrico respecto al elemento del que sale.
    const parentAngleStep = TAU / parentCount;
    const parentAngle = -Math.PI / 2 + (parentIndex + 0.5) * parentAngleStep;

    // El submenú se abre en un arco centrado en la mitad del padre.
    const arcSpan = TAU * CONFIG.submenuArc;
    const angleStep = arcSpan / count;
    const startAngle = parentAngle - arcSpan / 2;

    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      // Ángulos completos (sin hueco) para el hover; el hueco lo pone createArc.
      const a0 = startAngle + i * angleStep;
      const a1 = startAngle + (i + 1) * angleStep;
      const amid = (a0 + a1) / 2;

      // Crear sector
      const path = this.createArc(
        CONFIG.submenuInner,
        CONFIG.submenuOuter,
        a0,
        a1
      );

      this.styleSubmenuSector(path, node);
      // Retardo escalonado: cada sector entra un pelín después que el anterior,
      // así el submenú se "despliega" en abanico en vez de aparecer entero.
      const delay = `${(i * 0.03).toFixed(3)}s`;
      path.style.animationDelay = delay;
      this.svg.appendChild(path);

      // Crear icono
      const iconEl = this.createIcon(node, amid,
        CONFIG.submenuInner + CONFIG.submenuThickness / 2,
        CONFIG.iconSizeSub,
        true
      );
      iconEl.style.animationDelay = delay;

      this.iconsContainer.appendChild(iconEl);

      this.sectors.push({
        node,
        level: 2,
        index: i,
        path,
        icon: iconEl,
        angleStart: a0,
        angleEnd: a1,
        angleMid: amid,
      });
    }
  }

  private createArc(innerR: number, outerR: number, startA: number, endA: number): SVGPathElement {
    const c = CONFIG.center;

    // Hueco de ancho constante: el desfase angular en cada borde es gapPx/radio.
    // Como el arco crece con el radio, un ángulo fijo dejaría el hueco más ancho
    // por fuera; dividiendo entre el radio, el separador mide gapPx tanto en el
    // borde interior como en el exterior. Se usa medio hueco por lado.
    const halfGap = CONFIG.gapPx / 2;
    const outGap = halfGap / outerR;
    const inGap = halfGap / innerR;

    const startOut = startA + outGap;
    const endOut = endA - outGap;
    const startIn = startA + inGap;
    const endIn = endA - inGap;

    // Puntos del arco
    const x1 = c + Math.cos(startOut) * outerR;
    const y1 = c + Math.sin(startOut) * outerR;
    const x2 = c + Math.cos(endOut) * outerR;
    const y2 = c + Math.sin(endOut) * outerR;
    const x3 = c + Math.cos(endIn) * innerR;
    const y3 = c + Math.sin(endIn) * innerR;
    const x4 = c + Math.cos(startIn) * innerR;
    const y4 = c + Math.sin(startIn) * innerR;

    const largeArc = (endOut - startOut) > Math.PI ? 1 : 0;

    const d = [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
      `Z`,
    ].join(" ");

    const path = document.createElementNS(NS, "path") as SVGPathElement;
    path.setAttribute("d", d);

    return path;
  }

  private createIcon(node: HotNode, angle: number, radius: number, size: number, isSub: boolean): HTMLElement {
    const c = CONFIG.center;
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

    // Contenido del icono
    if (node.accent && node.id.startsWith("swatch-")) {
      // Muestra de color
      iconEl.style.background = node.accent;
      iconEl.classList.add("rm-icon-swatch");
    } else if (node.icon) {
      // Icono SVG
      iconEl.innerHTML = icon(node.icon);
    } else if (node.accent) {
      // Punto de color
      iconEl.style.background = node.accent;
      iconEl.classList.add("rm-icon-color");
    } else {
      // Fallback: mostrar texto (label corto) cuando no hay icono
      iconEl.classList.add("rm-icon-text");
      iconEl.textContent = this.shortLabel(node.label);
    }

    return iconEl;
  }

  /** Genera una etiqueta corta para items sin icono. */
  private shortLabel(label: string): string {
    // Si es un número (como sectores), mostrarlo completo si es corto
    if (/^\d+$/.test(label) && label.length <= 3) return label;
    // Tomar las primeras letras significativas
    const words = label.split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return label.slice(0, 3);
  }

  private styleMainSector(path: SVGPathElement, node: HotNode): void {
    path.setAttribute("class", "rm-sector rm-sector-main");
    if (node.active) path.classList.add("is-active");
    if (node.disabled) path.classList.add("is-disabled");
    if (node.kind === "submenu") path.classList.add("has-submenu");
  }

  private styleSubmenuSector(path: SVGPathElement, node: HotNode): void {
    path.setAttribute("class", "rm-sector rm-sector-sub");
    if (node.active) path.classList.add("is-active");
    if (node.disabled) path.classList.add("is-disabled");
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.container.getBoundingClientRect();
    const dx = e.clientX - rect.left - CONFIG.center;
    const dy = e.clientY - rect.top - CONFIG.center;
    const dist = Math.hypot(dx, dy);
    let angle = Math.atan2(dy, dx);

    // Normalizar ángulo a [0, TAU)
    if (angle < 0) angle += TAU;

    // Buscar sector bajo el cursor
    let found: RadialSector | null = null;

    for (const sector of this.sectors) {
      // Verificar radio
      const inRadius = sector.level === 1
        ? (dist >= CONFIG.innerRadius && dist <= CONFIG.outerRadius)
        : (dist >= CONFIG.submenuInner && dist <= CONFIG.submenuOuter);

      if (!inRadius) continue;

      // Normalizar ángulos del sector
      let start = sector.angleStart;
      let end = sector.angleEnd;
      let testAngle = angle;

      // Normalizar todo a [0, TAU)
      while (start < 0) start += TAU;
      while (end < 0) end += TAU;
      while (start >= TAU) start -= TAU;
      while (end >= TAU) end -= TAU;

      // Caso especial: el sector cruza el punto 0
      if (end < start) {
        if (testAngle >= start || testAngle <= end) {
          found = sector;
          break;
        }
      } else {
        if (testAngle >= start && testAngle <= end) {
          found = sector;
          break;
        }
      }
    }

    // Actualizar hover
    if (found !== this.hoveredSector) {
      this.hoveredSector = found;
      this.updateHover();

      // Expandir/contraer submenú
      if (found && found.level === 1 && found.node.kind === "submenu") {
        if (this.expandedIndex !== found.index) {
          this.expandedIndex = found.index;
          this.rebuild();
        }
      } else if (!found || found.level === 2) {
        // Mantener expandido si estamos en nivel 2
      } else {
        if (this.expandedIndex !== -1) {
          this.expandedIndex = -1;
          this.rebuild();
        }
      }
    }
  }

  private updateHover(): void {
    // Actualizar clases
    for (const sector of this.sectors) {
      const isHovered = sector === this.hoveredSector;
      setClass(sector.path, "is-hover", isHovered);
      setClass(sector.icon, "is-hover", isHovered);
    }

    // Actualizar label central
    if (this.hoveredSector) {
      this.centerLabel.textContent = this.hoveredSector.node.label;
    } else {
      this.centerLabel.textContent = this.currentLevel.title;
    }
  }

  private onPointerDown(e: PointerEvent): void {
    e.preventDefault();

    if (!this.hoveredSector) {
      this.close();
      return;
    }

    const node = this.hoveredSector.node;
    if (node.disabled) return;

    this.executeNode(node);
  }

  private executeNode(node: HotNode): void {
    switch (node.kind) {
      case "action": {
        const action = node as Extract<HotNode, { kind: "action" }>;

        // Si tiene panel flotante, abrirlo
        if (action.canFloat && action.buildPanel) {
          this.panels.toggle(
            {
              id: action.id,
              title: action.label,
              build: action.buildPanel,
            },
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
      case "submenu": {
        const submenu = node as Extract<HotNode, { kind: "submenu" }>;
        this.menuStack.push({ nodes: submenu.children, title: submenu.label });
        this.expandedIndex = -1;
        this.hoveredSector = null;
        this.rebuild();
        break;
      }
      case "dial":
        // TODO: Implementar dial mode
        break;
    }
  }

  private navigateBack(): void {
    if (this.menuStack.length > 1) {
      this.menuStack.pop();
      this.expandedIndex = -1;
      this.hoveredSector = null;
      this.rebuild();
    } else {
      this.close();
    }
  }

  private updateCenterButton(): void {
    const canGoBack = this.menuStack.length > 1;
    setClass(this.centerButton, "can-back", canGoBack);
    this.centerLabel.textContent = this.currentLevel.title;
  }

  private refresh(): void {
    const root = buildRoot(this.editor, this.editor.state, this.hooks);
    this.menuStack = [{ nodes: root, title: "drawi" }];
    this.rebuild();
  }
}
