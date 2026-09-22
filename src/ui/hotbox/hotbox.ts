import type { Editor } from "../../app/editor";
import { clamp, TAU } from "../../core/math";
import { el, setClass } from "../dom";
import { icon } from "../icons";
import type { Panels } from "../panels";
import { buildRoot, type DialNode, type HotNode, type MenuHooks } from "./menu";

const NS = "http://www.w3.org/2000/svg";
const R0 = 50; // radio del nucleo
const R1 = 110; // borde exterior del anillo principal
const R2 = 170; // borde exterior del anillo de submenú
const PAD = 20;
const SIZE = 2 * (R2 + PAD);
const C = SIZE / 2;
const GAP = 0.015; // separacion angular entre sectores
const TOP = -Math.PI / 2; // Inicio en la parte superior

/** Los submenús ocupan solo el sector correspondiente expandido */
const SUBMENU_COVERAGE = 0.25; // ~90 grados para submenús

interface Level {
  nodes: HotNode[];
  label: string;
}

interface Wedge {
  node: HotNode;
  path: SVGPathElement;
  glyph: HTMLElement;
  ring: 1 | 2;
  index: number;
}

/**
 * Hotbox: menu radial contextual de sectores concentricos (estilo marking menu).
 *
 * Aparece bajo el cursor con el clic derecho —manten y arrastra para marcar,
 * suelta para elegir; un clic suelto lo deja abierto para explorar—. Cada nivel
 * es un anillo; al apuntar un sector con hijos, estos florecen en el anillo de
 * fuera, de modo que ves la profundidad sin perder el contexto. Confirmar sobre
 * un submenu profundiza (se recoloca en el centro).
 *
 * El arbol es puramente declarativo (menu.ts) y se reconstruye del estado en
 * cada apertura: anadir opciones es anadir nodos, no tocar este motor.
 */
export class Hotbox {
  readonly el: HTMLElement;

  private editor: Editor;
  private hooks: MenuHooks;
  private panels: Panels;
  private svg: SVGSVGElement;
  private glyphLayer: HTMLElement;
  private ring: HTMLElement;
  private hub: HTMLElement;
  private hubLabel: HTMLElement;

  private open = false;
  private armed = false;
  private cx = 0;
  private cy = 0;
  private justOpened = false;

  private stack: Level[] = [];
  private path: string[] = [];
  private wedges: Wedge[] = [];
  private ring2Nodes: HotNode[] = [];
  private expanded = -1;
  private highlight: { ring: 1 | 2; index: number } | null = null;

  private engaged = false;
  private openPointer = { x: 0, y: 0 };

  private dial: { node: DialNode; lastAngle: number; value: number } | null = null;

  private onKey: (e: KeyboardEvent) => void;
  private onWinMove: (e: PointerEvent) => void;

  constructor(editor: Editor, hooks: MenuHooks, panels: Panels) {
    this.editor = editor;
    this.hooks = hooks;
    this.panels = panels;

    this.svg = document.createElementNS(NS, "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "hot-svg");
    this.svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
    this.svg.setAttribute("width", String(SIZE));
    this.svg.setAttribute("height", String(SIZE));

    this.glyphLayer = el("div", { class: "hot-glyphs" });
    this.hubLabel = el("span", { class: "hot-hub-label" });
    this.hub = el("div", { class: "hot-hub" }, [
      el("span", { class: "hot-hub-glyph", html: icon("back") }),
      this.hubLabel,
    ]);
    this.ring = el("div", { class: "hot-ring" }, [this.svg as unknown as HTMLElement, this.glyphLayer, this.hub]);

    this.el = el("div", { class: "hotbox" }, [this.ring]);
    this.el.hidden = true;

    this.onWinMove = (e: PointerEvent) => this.onPointerMove(e);
    this.el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.el.addEventListener("click", () => this.onClick());
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.hub.addEventListener("click", (e) => {
      e.stopPropagation();
      this.back();
    });

    this.onKey = (e: KeyboardEvent) => {
      if (!this.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
    window.addEventListener("keydown", this.onKey, true);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(x: number, y: number, armed = false): void {
    this.cx = clamp(x, R2 + 8, window.innerWidth - R2 - 8);
    this.cy = clamp(y, R2 + 8, window.innerHeight - R2 - 8);
    this.armed = armed;
    this.open = true;
    this.el.hidden = false;
    this.el.style.pointerEvents = "auto";
    this.ring.style.left = `${this.cx}px`;
    this.ring.style.top = `${this.cy}px`;
    this.stack = [{ nodes: buildRoot(this.editor, this.editor.state, this.hooks), label: "Zence" }];
    this.path = [];
    this.dial = null;
    this.expanded = -1;
    this.highlight = null;
    this.engaged = false;
    this.openPointer = { x, y };
    this.justOpened = true;
    this.build(true);

    // Ignorar el click que dispara el contextmenu para no cerrar al abrir.
    window.setTimeout(() => { this.justOpened = false; }, 150);

    if (armed) {
      window.addEventListener("pointermove", this.onWinMove, true);
      const up = (): void => {
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointermove", this.onWinMove, true);
        this.onArmedRelease();
      };
      window.addEventListener("pointerup", up, true);
    }
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.armed = false;
    this.dial = null;
    this.el.style.pointerEvents = "none";
    this.ring.classList.add("is-out");
    window.setTimeout(() => {
      if (!this.open) this.el.hidden = true;
    }, 160);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey, true);
  }

  // ------------------------------------------------------------ navegacion

  private drill(node: Extract<HotNode, { kind: "submenu" }>): void {
    this.path.push(node.id);
    this.stack.push({ nodes: node.children, label: node.label });
    this.expanded = -1;
    this.highlight = null;
    this.build(true);
  }

  private back(): void {
    if (this.dial) {
      this.dial = null;
      this.ring.classList.remove("is-dial");
      this.build(false);
      return;
    }
    if (this.stack.length > 1) {
      this.stack.pop();
      this.path.pop();
      this.expanded = -1;
      this.highlight = null;
      this.build(true);
    } else {
      this.close();
    }
  }

  /** Reconstruye siguiendo el camino de ids (para toggles con keepOpen). */
  private refresh(): void {
    const root = buildRoot(this.editor, this.editor.state, this.hooks);
    const levels: Level[] = [{ nodes: root, label: "Zence" }];
    let nodes = root;
    for (const id of this.path) {
      const parent = nodes.find((n) => n.id === id);
      if (parent && parent.kind === "submenu") {
        nodes = parent.children;
        levels.push({ nodes, label: parent.label });
      } else break;
    }
    this.stack = levels;
    this.build(false);
  }

  // --------------------------------------------------------------- dibujo

  private get current(): HotNode[] {
    return this.stack[this.stack.length - 1].nodes;
  }

  private build(animate: boolean): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.glyphLayer.textContent = "";
    this.wedges = [];
    this.ring2Nodes = [];

    const nodes = this.current;
    const n = nodes.length;
    for (let i = 0; i < n; i++) this.addWedge(nodes[i], 1, i, n, R0, R1);

    if (this.expanded >= 0) this.buildRing2();

    const canBack = this.stack.length > 1 || this.dial !== null;
    setClass(this.hub, "can-back", canBack);
    this.hubLabel.textContent = this.dial ? "" : this.stack[this.stack.length - 1].label;
    this.updateHot();

    if (animate) {
      this.ring.classList.remove("is-out");
      this.ring.classList.remove("is-in");
      // Reinicia la animacion de entrada.
      void this.ring.offsetWidth;
      this.ring.classList.add("is-in");
    }
  }

  private buildRing2(): void {
    const parent = this.current[this.expanded];
    if (!parent || parent.kind !== "submenu") return;
    const kids = parent.children;
    this.ring2Nodes = kids;
    for (let i = 0; i < kids.length; i++) this.addWedge(kids[i], 2, i, kids.length, R1 + 3, R2);
  }

  private addWedge(node: HotNode, ring: 1 | 2, index: number, count: number, rIn: number, rOut: number): void {
    let sector: number, start: number, a0: number, a1: number;

    if (ring === 1) {
      // Anillo principal: círculo completo
      sector = TAU / count;
      start = TOP;
      a0 = start + index * sector + GAP / 2;
      a1 = start + (index + 1) * sector - GAP / 2;
    } else {
      // Submenú: se abre en el ángulo del sector padre
      const parentSector = TAU / this.current.length;
      const parentAngle = TOP + this.expanded * parentSector;
      const submenuSpan = TAU * SUBMENU_COVERAGE;
      sector = submenuSpan / count;
      start = parentAngle - submenuSpan / 2;
      a0 = start + index * sector + GAP / 2;
      a1 = start + (index + 1) * sector - GAP / 2;
    }

    const mid = (a0 + a1) / 2;
    const midR = (rIn + rOut) / 2;

    const path = document.createElementNS(NS, "path") as SVGPathElement;
    path.setAttribute("d", sectorPath(rIn, rOut, a0, a1));
    path.setAttribute("class", "hot-wedge");
    if (node.disabled) path.classList.add("is-disabled");
    if (node.active) path.classList.add("is-on");
    if (node.kind === "submenu") path.classList.add("has-more");
    const isSwatch = node.accent && node.id.startsWith("swatch-");
    if (isSwatch) path.style.fill = node.accent as string;
    this.svg.appendChild(path);

    const gx = C + Math.cos(mid) * midR;
    const gy = C + Math.sin(mid) * midR;
    const glyphChildren: (HTMLElement | null)[] = [];
    if (!isSwatch) {
      if (node.accent) glyphChildren.push(el("span", { class: "hot-g-dot", style: { background: node.accent } }));
      else if (node.icon) glyphChildren.push(el("span", { class: "hot-g-icon", html: icon(node.icon) }));
      glyphChildren.push(el("span", { class: "hot-g-label", text: node.label }));
      if (node.kind === "dial") glyphChildren.push(el("span", { class: "hot-g-value", text: `${formatDial(node.value, node.step)}${node.unit ?? ""}` }));
    }
    const glyph = el(
      "div",
      {
        class: `hot-glyph${isSwatch ? " is-swatch" : ""}${node.kind === "action" && node.canFloat ? " can-float" : ""}`,
        style: { left: `${gx}px`, top: `${gy}px` }
      },
      glyphChildren,
    );
    this.glyphLayer.appendChild(glyph);

    this.wedges.push({ node, path, glyph, ring, index });
  }

  private updateHot(): void {
    for (const w of this.wedges) {
      const on = this.highlight !== null && this.highlight.ring === w.ring && this.highlight.index === w.index;
      setClass(w.path, "is-hot", on);
      setClass(w.glyph, "is-hot", on);
    }
  }

  // ------------------------------------------------------------ puntero

  private onPointerMove(e: PointerEvent): void {
    if (this.dial) {
      this.scrubDial(e);
      return;
    }
    const dx = e.clientX - this.cx;
    const dy = e.clientY - this.cy;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    if (!this.engaged && Math.hypot(e.clientX - this.openPointer.x, e.clientY - this.openPointer.y) > 20) {
      this.engaged = true;
    }

    // Expandir/contraer el anillo hijo segun el sector interior apuntado.
    // Se decide con el anillo interior (ring 1): si el sector actual donde apunta
    // el cursor es un submenu, ese se expande; si no, se contrae.
    const innerIdx = this.engaged && dist >= R0 && dist < R1 ? angleIndex(angle, this.current.length) : -1;
    const innerNode = innerIdx >= 0 ? this.current[innerIdx] : null;
    const wantExpand = innerNode && innerNode.kind === "submenu" ? innerIdx : -1;
    if (wantExpand !== this.expanded) {
      this.expanded = wantExpand;
      this.rebuildRing2();
    }

    // Recalcular el hit ahora que el anillo 2 esta actualizado.
    let hit: { ring: 1 | 2; index: number } | null = null;
    if (this.engaged && dist >= R0) {
      if (dist >= R1 && this.expanded >= 0 && this.ring2Nodes.length > 0) {
        const idx = angleIndexSubmenu(angle, this.ring2Nodes.length, this.expanded, this.current.length);
        if (idx >= 0) hit = { ring: 2, index: idx };
      } else if (dist < R1) {
        const idx = angleIndex(angle, this.current.length);
        if (idx >= 0) hit = { ring: 1, index: idx };
      }
    }

    this.highlight = hit;
    this.updateHot();
  }

  private rebuildRing2(): void {
    for (let i = this.wedges.length - 1; i >= 0; i--) {
      if (this.wedges[i].ring === 2) {
        this.wedges[i].path.remove();
        this.wedges[i].glyph.remove();
        this.wedges.splice(i, 1);
      }
    }
    this.ring2Nodes = [];
    if (this.expanded >= 0) this.buildRing2();
    this.updateHot();
  }

  private onClick(): void {
    if (this.armed) return;
    if (this.justOpened) return;
    if (this.highlight) this.commit();
    else if (this.engaged) this.close();
  }

  private onArmedRelease(): void {
    this.armed = false;
    if (this.justOpened) return;
    if (!this.engaged) return; // toque suelto: queda abierto para explorar
    if (this.highlight) this.commit();
    else this.close();
  }

  private commit(): void {
    const h = this.highlight;
    if (!h) return;
    const node = h.ring === 2 ? this.ring2Nodes[h.index] : this.current[h.index];
    if (!node || node.disabled) return;
    this.armed = false;

    switch (node.kind) {
      case "action": {
        const actionNode = node as Extract<HotNode, { kind: "action" }>;
        // Shift + click = abrir como panel flotante si está disponible
        if (actionNode.canFloat && actionNode.buildPanel && window.event && (window.event as KeyboardEvent).shiftKey) {
          this.openAsPanel(actionNode);
          this.close();
        } else {
          actionNode.run();
          if (actionNode.keepOpen) this.refresh();
          else this.close();
        }
        break;
      }
      case "submenu":
        this.drill(node as Extract<HotNode, { kind: "submenu" }>);
        break;
      case "dial":
        this.enterDial(node as DialNode);
        break;
    }
  }

  private openAsPanel(node: Extract<HotNode, { kind: "action" }>): void {
    if (!node.canFloat || !node.buildPanel) return;
    this.panels.open({
      id: `hotbox-${node.id}`,
      title: node.label,
      build: node.buildPanel,
    }, this.cx, this.cy);
  }

  // -------------------------------------------------------------- dial

  private enterDial(node: DialNode): void {
    this.dial = { node, lastAngle: NaN, value: node.value };
    this.expanded = -1;
    this.highlight = null;
    this.ring.classList.add("is-dial");
    this.build(false);
    this.renderDial();
  }

  private scrubDial(e: PointerEvent): void {
    const d = this.dial;
    if (!d) return;
    const ang = Math.atan2(e.clientY - this.cy, e.clientX - this.cx);
    if (Number.isNaN(d.lastAngle)) {
      d.lastAngle = ang;
      return;
    }
    let delta = ang - d.lastAngle;
    if (delta > Math.PI) delta -= TAU;
    if (delta < -Math.PI) delta += TAU;
    d.lastAngle = ang;
    const range = d.node.max - d.node.min;
    let v = d.value + (delta / TAU) * range;
    v = clamp(v, d.node.min, d.node.max);
    if (d.node.step && d.node.step > 0) v = Math.round(v / d.node.step) * d.node.step;
    d.value = v;
    d.node.onInput(v);
    this.renderDial();
  }

  private renderDial(): void {
    const d = this.dial;
    if (!d) return;
    const t = (d.value - d.node.min) / (d.node.max - d.node.min || 1);
    this.hub.style.setProperty("--dial", `${(t * 100).toFixed(1)}%`);
    this.hubLabel.innerHTML = `<b>${formatDial(d.value, d.node.step)}</b><i>${d.node.label}${d.node.unit ? " · " + d.node.unit : ""}</i>`;
  }
}

/** Sector anular en coordenadas del SVG (centro en C,C). */
function sectorPath(rIn: number, rOut: number, a0: number, a1: number): string {
  const p = (r: number, a: number): string =>
    `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(rOut, a0)} A ${rOut} ${rOut} 0 ${large} 1 ${p(rOut, a1)} L ${p(rIn, a1)} A ${rIn} ${rIn} 0 ${large} 0 ${p(rIn, a0)} Z`;
}

/** Indice de sector para un angulo en el anillo principal (círculo completo). */
function angleIndex(angle: number, count: number): number {
  const sector = TAU / count;
  const start = TOP;
  let t = (angle - start) % TAU;
  if (t < 0) t += TAU;
  return Math.floor(t / sector) % count;
}

/** Indice de sector para un angulo en un submenú (sector específico). */
function angleIndexSubmenu(angle: number, count: number, parentIndex: number, parentCount: number): number {
  const parentSector = TAU / parentCount;
  const parentAngle = TOP + parentIndex * parentSector;
  const submenuSpan = TAU * SUBMENU_COVERAGE;
  const sector = submenuSpan / count;
  const start = parentAngle - submenuSpan / 2;

  let t = (angle - start) % TAU;
  if (t < 0) t += TAU;

  if (t >= submenuSpan) return -1;
  return Math.min(count - 1, Math.floor(t / sector));
}

function formatDial(v: number, step?: number): string {
  const decimals = step && step < 1 ? 2 : 0;
  return v.toFixed(decimals);
}
