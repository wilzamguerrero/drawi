import type { Editor } from "../../app/editor";
import { clamp, TAU } from "../../core/math";
import { el, setClass } from "../dom";
import { icon } from "../icons";
import type { Panels } from "../panels";
import { buildRoot, type DialNode, type HotNode, type MenuHooks } from "./menu";

const NS = "http://www.w3.org/2000/svg";

// Radios - ajustados para mejor visualización
const INNER_RADIUS = 70;
const RING_WIDTH = 50;
const OUTER_RADIUS = INNER_RADIUS + RING_WIDTH;
const SUBMENU_INNER = OUTER_RADIUS + 8;
const SUBMENU_OUTER = SUBMENU_INNER + 50;

const PAD = 30;
const SIZE = 2 * (SUBMENU_OUTER + PAD);
const C = SIZE / 2;
const GAP_ANGLE = 0.015;
const TOP = -Math.PI / 2;

/** Los submenús ocupan un arco más amplio para mejor legibilidad */
const SUBMENU_COVERAGE = 0.4; // ~144 grados para submenús

interface Sector {
  node: HotNode;
  ring: 1 | 2;
  index: number;
  path: SVGPathElement;
  iconEl: HTMLElement;
  angleStart: number;
  angleEnd: number;
}

export class HotboxNew {
  readonly el: HTMLElement;

  private editor: Editor;
  private hooks: MenuHooks;
  // panels se usará en futura implementación para convertir items en flotantes
  // private panels: Panels;

  private root: HTMLElement;
  private svg: SVGSVGElement;
  private iconsLayer: HTMLElement;
  private centerHub: HTMLElement;

  private open = false;
  private cx = 0;
  private cy = 0;

  private stack: { nodes: HotNode[]; label: string }[] = [];
  private path: string[] = [];
  private sectors: Sector[] = [];
  private expandedIndex = -1;
  private hoveredSector: Sector | null = null;

  private dial: { node: DialNode; startAngle: number; value: number } | null = null;

  constructor(editor: Editor, hooks: MenuHooks, _panels: Panels) {
    this.editor = editor;
    this.hooks = hooks;
    // this.panels = panels; // Para futura implementación

    // SVG para los sectores
    this.svg = document.createElementNS(NS, "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "hb-svg");
    this.svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
    this.svg.setAttribute("width", String(SIZE));
    this.svg.setAttribute("height", String(SIZE));

    // Capa de iconos
    this.iconsLayer = el("div", { class: "hb-icons" });

    // Hub central (sin tooltip separado)
    this.centerHub = el("div", { class: "hb-hub" }, [
      el("span", { class: "hb-hub-icon", html: icon("back") }),
      el("span", { class: "hb-hub-label", text: "drawi" }),
    ]);

    this.root = el("div", { class: "hb-ring" }, [
      this.svg as unknown as HTMLElement,
      this.iconsLayer,
      this.centerHub,
    ]);

    this.el = el("div", { class: "hotbox-new" }, [this.root]);
    this.el.hidden = true;

    this.setupEvents();
  }

  private setupEvents(): void {
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.el.addEventListener("click", () => this.onClick());

    this.centerHub.addEventListener("click", (e) => {
      e.stopPropagation();
      this.back();
    });
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(x: number, y: number): void {
    this.cx = clamp(x, SUBMENU_OUTER + PAD, window.innerWidth - SUBMENU_OUTER - PAD);
    this.cy = clamp(y, SUBMENU_OUTER + PAD, window.innerHeight - SUBMENU_OUTER - PAD);

    this.open = true;
    this.el.hidden = false;
    this.root.style.left = `${this.cx}px`;
    this.root.style.top = `${this.cy}px`;

    this.stack = [{ nodes: buildRoot(this.editor, this.editor.state, this.hooks), label: "drawi" }];
    this.path = [];
    this.expandedIndex = -1;
    this.hoveredSector = null;
    this.dial = null;

    this.rebuild();
    this.root.classList.remove("is-out");
    this.root.classList.add("is-in");
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add("is-out");
    setTimeout(() => {
      if (!this.open) this.el.hidden = true;
    }, 200);
  }

  dispose(): void {
    // Cleanup
  }

  private get currentNodes(): HotNode[] {
    return this.stack[this.stack.length - 1].nodes;
  }

  private rebuild(): void {
    // Limpiar
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.iconsLayer.textContent = "";
    this.sectors = [];

    const nodes = this.currentNodes;

    // Dibujar anillo principal (círculo completo)
    for (let i = 0; i < nodes.length; i++) {
      this.addSector(nodes[i], 1, i, nodes.length);
    }

    // Dibujar submenú si está expandido
    if (this.expandedIndex >= 0) {
      const parent = nodes[this.expandedIndex];
      if (parent && parent.kind === "submenu") {
        const children = parent.children;
        for (let i = 0; i < children.length; i++) {
          this.addSubmenuSector(children[i], 2, i, children.length, this.expandedIndex, nodes.length);
        }
      }
    }

    // Actualizar hub central
    const canBack = this.stack.length > 1 || this.dial !== null;
    setClass(this.centerHub, "can-back", canBack);
    const labelEl = this.centerHub.querySelector(".hb-hub-label") as HTMLElement;
    if (labelEl) labelEl.textContent = this.stack[this.stack.length - 1].label;
  }

  private addSector(node: HotNode, ring: 1 | 2, index: number, count: number): void {
    // Círculo completo: 360 grados dividido entre items
    const sectorAngle = TAU / count;
    const angleStart = TOP + index * sectorAngle + GAP_ANGLE;
    const angleEnd = TOP + (index + 1) * sectorAngle - GAP_ANGLE;
    const angleMid = (angleStart + angleEnd) / 2;

    // Crear sector SVG
    const path = this.createSectorPath(INNER_RADIUS, OUTER_RADIUS, angleStart, angleEnd);
    path.setAttribute("class", "hb-sector");
    if (node.active) path.classList.add("is-active");
    if (node.disabled) path.classList.add("is-disabled");
    if (node.kind === "submenu") path.classList.add("has-submenu");

    this.svg.appendChild(path);

    // Posicionar icono - Sistema relativo al centro del root
    const iconRadius = INNER_RADIUS + RING_WIDTH / 2;
    const iconX = Math.cos(angleMid) * iconRadius;
    const iconY = Math.sin(angleMid) * iconRadius;

    const iconEl = el("div", {
      class: "hb-icon",
      style: {
        left: '0',
        top: '0',
        transform: `translate(${iconX}px, ${iconY}px)`
      },
    });

    if (node.accent && node.id.startsWith("swatch-")) {
      // Muestra de color
      iconEl.style.background = node.accent;
      iconEl.classList.add("is-swatch");
    } else if (node.icon) {
      iconEl.innerHTML = icon(node.icon);
    } else if (node.accent) {
      iconEl.style.background = node.accent;
      iconEl.classList.add("is-dot");
    }

    this.iconsLayer.appendChild(iconEl);

    this.sectors.push({ node, ring, index, path, iconEl, angleStart, angleEnd });
  }

  private addSubmenuSector(node: HotNode, ring: 1 | 2, index: number, count: number, parentIndex: number, parentCount: number): void {
    // El submenú se abre en el ángulo del sector padre
    const parentSectorAngle = TAU / parentCount;
    const parentAngleMid = TOP + parentIndex * parentSectorAngle;

    // Arco más amplio para submenús
    const submenuSpan = TAU * SUBMENU_COVERAGE;
    const sectorAngle = submenuSpan / count;
    const angleStart = parentAngleMid - submenuSpan / 2 + index * sectorAngle + GAP_ANGLE;
    const angleEnd = parentAngleMid - submenuSpan / 2 + (index + 1) * sectorAngle - GAP_ANGLE;
    const angleMid = (angleStart + angleEnd) / 2;

    // Crear sector SVG
    const path = this.createSectorPath(SUBMENU_INNER, SUBMENU_OUTER, angleStart, angleEnd);
    path.setAttribute("class", "hb-sector hb-sector-sub");
    if (node.active) path.classList.add("is-active");
    if (node.disabled) path.classList.add("is-disabled");

    this.svg.appendChild(path);

    // Posicionar icono - Sistema relativo al centro
    const iconRadius = SUBMENU_INNER + RING_WIDTH / 2;
    const iconX = Math.cos(angleMid) * iconRadius;
    const iconY = Math.sin(angleMid) * iconRadius;

    const iconEl = el("div", {
      class: "hb-icon hb-icon-sub",
      style: {
        left: '0',
        top: '0',
        transform: `translate(${iconX}px, ${iconY}px)`
      },
    });

    if (node.accent && node.id.startsWith("swatch-")) {
      iconEl.style.background = node.accent;
      iconEl.classList.add("is-swatch");
    } else if (node.icon) {
      iconEl.innerHTML = icon(node.icon);
    } else if (node.accent) {
      iconEl.style.background = node.accent;
      iconEl.classList.add("is-dot");
    }

    this.iconsLayer.appendChild(iconEl);

    this.sectors.push({ node, ring, index, path, iconEl, angleStart, angleEnd });
  }

  private createSectorPath(innerR: number, outerR: number, startAngle: number, endAngle: number): SVGPathElement {
    const x1 = C + Math.cos(startAngle) * outerR;
    const y1 = C + Math.sin(startAngle) * outerR;
    const x2 = C + Math.cos(endAngle) * outerR;
    const y2 = C + Math.sin(endAngle) * outerR;
    const x3 = C + Math.cos(endAngle) * innerR;
    const y3 = C + Math.sin(endAngle) * innerR;
    const x4 = C + Math.cos(startAngle) * innerR;
    const y4 = C + Math.sin(startAngle) * innerR;

    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

    const d = [
      `M ${x1} ${y1}`,
      `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${x3} ${y3}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4}`,
      `Z`,
    ].join(" ");

    const path = document.createElementNS(NS, "path") as SVGPathElement;
    path.setAttribute("d", d);
    return path;
  }

  private onPointerMove(e: PointerEvent): void {
    const dx = e.clientX - this.cx;
    const dy = e.clientY - this.cy;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    // Encontrar sector bajo el cursor
    let hovered: Sector | null = null;

    for (const sector of this.sectors) {
      const inRadius = (sector.ring === 1)
        ? (dist >= INNER_RADIUS && dist <= OUTER_RADIUS)
        : (dist >= SUBMENU_INNER && dist <= SUBMENU_OUTER);

      if (inRadius) {
        let normalizedAngle = angle;
        if (normalizedAngle < sector.angleStart) normalizedAngle += TAU;
        if (normalizedAngle >= sector.angleStart && normalizedAngle <= sector.angleEnd) {
          hovered = sector;
          break;
        }
      }
    }

    // Actualizar hover
    if (this.hoveredSector !== hovered) {
      this.hoveredSector = hovered;
      this.updateHover();
    }

    // Expandir/contraer submenú
    if (hovered && hovered.ring === 1 && hovered.node.kind === "submenu") {
      if (this.expandedIndex !== hovered.index) {
        this.expandedIndex = hovered.index;
        this.rebuild();
        this.updateHover();
      }
    } else if (hovered && hovered.ring === 2) {
      // Mantener expandido
    } else if (!hovered && dist >= INNER_RADIUS) {
      if (this.expandedIndex !== -1) {
        this.expandedIndex = -1;
        this.rebuild();
      }
    }
  }

  private updateHover(): void {
    // Actualizar clases de hover
    for (const sector of this.sectors) {
      const isHovered = sector === this.hoveredSector;
      setClass(sector.path, "is-hover", isHovered);
      setClass(sector.iconEl, "is-hover", isHovered);
    }

    // Mostrar nombre en el hub central
    const labelEl = this.centerHub.querySelector(".hb-hub-label") as HTMLElement;
    if (labelEl) {
      if (this.hoveredSector) {
        labelEl.textContent = this.hoveredSector.node.label;
      } else {
        labelEl.textContent = this.stack[this.stack.length - 1].label;
      }
    }
  }

  private onClick(): void {
    if (!this.hoveredSector) {
      this.close();
      return;
    }

    const node = this.hoveredSector.node;
    if (node.disabled) return;

    switch (node.kind) {
      case "action": {
        const actionNode = node as Extract<HotNode, { kind: "action" }>;
        actionNode.run();
        if (!actionNode.keepOpen) this.close();
        else {
          this.refresh();
        }
        break;
      }
      case "submenu":
        this.drill(node as Extract<HotNode, { kind: "submenu" }>);
        break;
      case "dial":
        // TODO: Implementar dial
        break;
    }
  }

  private drill(node: Extract<HotNode, { kind: "submenu" }>): void {
    this.path.push(node.id);
    this.stack.push({ nodes: node.children, label: node.label });
    this.expandedIndex = -1;
    this.hoveredSector = null;
    this.rebuild();
  }

  private back(): void {
    if (this.stack.length > 1) {
      this.stack.pop();
      this.path.pop();
      this.expandedIndex = -1;
      this.hoveredSector = null;
      this.rebuild();
    } else {
      this.close();
    }
  }

  private refresh(): void {
    const root = buildRoot(this.editor, this.editor.state, this.hooks);
    this.stack = [{ nodes: root, label: "drawi" }];
    // Reconstruir path
    // TODO: Navegar por el path guardado
    this.rebuild();
  }
}
