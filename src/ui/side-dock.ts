import type { Editor, EditorState } from "../app/editor";
import { DEFAULT_PALETTES } from "../core/color";
import { DYNAMICS_INFO } from "../stroke/types";
import { symmetryCopies } from "../symmetry/symmetry";
import type { ToolId } from "../tools/types";
import { ColorPicker } from "./color-picker";
import { button, fieldLabel, section, segmented, swatches } from "./controls";
import { blurSoon, el, setClass } from "./dom";
import { MateriaEdge } from "./fx/materia-edge";
import type { MenuHooks } from "./hotbox/menu";
import { icon } from "./icons";
import { LayersPanel } from "./layers-panel";
import { DockRenderer } from "./model/render-dock";
import { buildSchema, isGroup, val, type Domain, type Field, type SchemaNode } from "./model/schema";

/**
 * Qué dominios del esquema son pestañas del dock, en qué orden y con qué icono.
 * El dock elige su subconjunto y disposición; el contenido de cada página sale
 * del esquema (igual que el radial). `icon` sobreescribe el del dominio (Materia
 * usa el icono de Forma) y `label` su etiqueta.
 */
interface TabDef {
  domain: string;
  icon?: string;
  label?: string;
}

const DOCK_TABS: TabDef[] = [
  { domain: "select" },
  { domain: "brush" },
  { domain: "layers" },
  { domain: "matter-cfg", icon: "shape" },
  { domain: "color" },
  { domain: "symmetry" },
];

/**
 * Ids de dominio que el dock expone como pestañas. Otros consumidores del
 * esquema (el paletón) lo usan para saber qué opción tiene panel al que llevar.
 */
export const DOCK_TAB_DOMAINS: string[] = DOCK_TABS.map((t) => t.domain);

/**
 * Qué pestaña corresponde a cada herramienta. Al cambiar de herramienta el dock
 * resalta la pestaña relacionada (no la abre: solo la marca como "en uso"). Las
 * herramientas sin ajustes propios —cuentagotas y mano— no resaltan ninguna.
 */
const TOOL_TO_CAT: Partial<Record<ToolId, string>> = {
  select: "select",
  brush: "brush",
  shape: "matter-cfg",
  matter: "matter-cfg",
  symmetry: "symmetry",
};

/**
 * El dock no consume los puertos de archivo/rueda (esos dominios/campos son
 * `surfaces: ["radial"]` y no entran en sus páginas), pero `buildSchema` los
 * exige. Se le pasa esta implementación vacía: nunca se invoca desde el dock.
 */
const NO_HOOKS: MenuHooks = {
  toggleWheel() {},
  help() {},
  newDoc() {},
  openFile() {},
  importImage() {},
  save() {},
  exportPng() {},
  exportSvg() {},
};
/**
 * Dock lateral izquierdo.
 *
 * Un único panel anclado al borde izquierdo que, plegado, deja ver solo su tira
 * de pestañas —una por dominio de `DOCK_TABS`—. Al pulsar una pestaña el cajón
 * se desliza desde el borde con los ajustes de ese dominio; al volver a pulsarla,
 * se repliega. Cambiar de herramienta resalta su pestaña para invitar a abrirla,
 * pero no interrumpe el dibujo abriéndola sola.
 *
 * Las páginas y secciones NO se declaran aquí: se derivan del esquema único
 * (`model/schema.ts`) recorriendo cada dominio —igual que hace el radial—. Los
 * campos genéricos salen de `DockRenderer` (creados una vez y sincronizados por
 * `id`); el cromo propio de la superficie (selector HSV, paletas, vista previa,
 * notas, conteo) se declara como campos `custom` y se rinde con los adaptadores
 * de `buildCustoms`. Así, añadir un dominio al esquema lo hace aparecer en el
 * dock y en el radial sin tocar este archivo. Reconstruir el panel en cada
 * cambio perdería el foco del campo en edición y haría parpadear los
 * deslizadores, así que solo se sincroniza (`update`) en cada fotograma.
 */
export class SideDock {
  readonly el: HTMLElement;

  private dock: DockRenderer;
  private pages: Record<string, HTMLElement> = {};
  private tabs = new Map<string, HTMLButtonElement>();
  private tabDefs: { id: string; label: string; icon: string }[] = [];

  // Adaptadores del cromo propio del dock (campos `custom`), indexados por id.
  private customs = new Map<string, { el: HTMLElement; sync?: (s: EditorState) => void }>();
  // Sincronías vivas (valor que sigue al estado) y visibilidades por predicado
  // de secciones/campos custom (los campos genéricos los resuelve DockRenderer).
  private customSyncs: ((s: EditorState) => void)[] = [];
  private dynVis: { el: HTMLElement; visible: (s: EditorState) => boolean }[] = [];

  private drawer: HTMLElement;
  private edge: MateriaEdge;
  private content!: HTMLElement;
  private heightTimer = 0;
  private flashTimer = 0;
  private flashOutTimer = 0;
  /** Campo resaltado por el paletón (persiste hasta la próxima interacción). */
  private flashed: HTMLElement | null = null;
  private dockTitle!: HTMLElement;

  // Estado del cajón: qué dominio está abierto (null = plegado) y cuál está
  // "en uso" por la herramienta activa (solo resalta la pestaña).
  private openCat: string | null = null;
  private activeTool: string | null = null;

  /** Abre la rueda de color flotante (la resuelve la App). */
  private onOpenWheel: () => void;

  constructor(editor: Editor, onOpenWheel: () => void = () => {}) {
    this.onOpenWheel = onOpenWheel;
    const schema = buildSchema(editor, editor.state, NO_HOOKS);
    const byId = new Map(schema.map((d) => [d.id, d] as const));
    this.dock = new DockRenderer(editor, schema);
    this.buildCustoms(editor);

    // Tira de pestañas + su página, ambas derivadas del esquema.
    const strip = el("div", { class: "dock-tabs" });
    for (const tab of DOCK_TABS) {
      const domain = byId.get(tab.domain);
      if (!domain) continue;
      const label = tab.label ?? val(domain.label ?? domain.id, editor.state);
      const iconName = tab.icon ?? val(domain.icon, editor.state);
      this.tabDefs.push({ id: domain.id, label, icon: iconName });
      this.pages[domain.id] = this.buildPage(domain, editor.state);
      const btn = el("button", { class: "dock-tab", type: "button", title: label, html: icon(iconName) });
      btn.addEventListener("click", () => {
        this.toggle(domain.id);
        blurSoon(btn);
      });
      this.tabs.set(domain.id, btn);
      strip.appendChild(btn);
    }

    // Cabecera del cajón: título del dominio abierto + botón de cerrar.
    const titleEl = el("span", { class: "dock-title" });
    const closeBtn = el("button", { class: "dock-close", type: "button", title: "Cerrar panel", html: icon("close") });
    closeBtn.addEventListener("click", () => this.setOpen(null));
    const head = el("div", { class: "dock-head" }, [titleEl, closeBtn]);
    this.dockTitle = titleEl;

    const scroll = el("div", { class: "dock-scroll" }, Object.values(this.pages));

    // "Piel" del panel: el relleno dibujado como un trazo vectorial que se
    // remodela por frames (MateriaEdge). Solo el borde derecho ondula; los otros
    // tres quedan rectos. Va detrás del contenido, que vive en su capa nítida.
    this.edge = new MateriaEdge({ fill: "#161619", radius: 22, amplitude: 11 });
    this.edge.el.classList.add("dock-skin");
    this.content = el("div", { class: "dock-content" }, [head, scroll]);
    this.drawer = el("div", { class: "dock-drawer" }, [this.edge.el, this.content]);

    this.el = el("aside", { class: "side-dock", role: "toolbar" }, [this.drawer, strip]);
    this.renderState();
  }
  /**
   * Cromo propio del dock. Cada campo `custom` del esquema con presencia en el
   * dock se resuelve aquí por `id`: color (HSV), paletas, recientes, vista previa
   * del pincel, notas vivas y el botón de hornear. Se crea una vez; `sync` (si lo
   * hay) refresca su valor con el estado. Las notas estáticas (`note-*`) no pasan
   * por aquí: las rinde `fieldEl` por convención.
   */
  private buildCustoms(editor: Editor): void {
    // Color: selector HSV (la rueda del radial cumple ese papel).
    const picker = new ColorPicker(editor.color, (hex) => editor.setColor(hex));

    // Muestras primario/secundario al estilo Photoshop: el cuadro del primario
    // arriba y el del secundario detrás-abajo. Clic en el secundario (o en las
    // flechas) intercambia ambos; un botón aparte abre la rueda de color.
    const primarySw = el("span", { class: "ps-swatch ps-swatch-primary", title: "Color primario" });
    const secondarySw = el("button", {
      class: "ps-swatch ps-swatch-secondary",
      type: "button",
      title: "Color secundario · clic para intercambiar (X)",
      on: { click: () => editor.swapColors() },
    });
    const swapBtn = button({
      iconName: "swap",
      title: "Intercambiar primario ⇄ secundario (X)",
      onClick: () => editor.swapColors(),
    });
    swapBtn.el.classList.add("ps-swap");
    const wheelBtn = button({
      iconName: "wheel",
      label: "Rueda de color",
      title: "Abrir la rueda de color flotante (R)",
      onClick: () => this.onOpenWheel(),
    });
    const psRow = el("div", { class: "ps-colors" }, [
      el("div", { class: "ps-swatch-stack" }, [secondarySw, primarySw, swapBtn.el]),
      wheelBtn.el,
    ]);
    const colorStack = el("div", { class: "dock-stack" }, [psRow, picker.el]);
    this.customs.set("color-picker", {
      el: colorStack,
      sync: (s) => {
        picker.set(s.color);
        primarySw.style.background = s.color;
        secondarySw.style.background = s.secondaryColor;
      },
    });

    // Paleta: pestañas + pozos. Elegir un color marca la paleta y lo aplica.
    const wells = swatches({
      colors: editor.palette.colors,
      value: editor.color,
      onPick: (hex) => { editor.setColor(hex); picker.set(hex); },
    });
    const tabs = segmented({
      options: DEFAULT_PALETTES.map((p, i) => ({ value: String(i), label: p.name })),
      value: String(editor.paletteIndex),
      onChange: (v) => { editor.setPalette(Number(v)); wells.set({ colors: editor.palette.colors, value: editor.color }); },
    });
    const paletteEl = el("div", { class: "dock-stack" }, [tabs.el, wells.el]);
    this.customs.set("palette", {
      el: paletteEl,
      sync: (s) => { tabs.set(String(s.paletteIndex)); wells.set({ colors: s.palette.colors, value: s.color }); },
    });
    // APPEND_CUSTOMS_2

    // Recientes: rótulo + muestras de los últimos colores usados.
    const recent = swatches({
      colors: editor.recentColors,
      value: editor.color,
      onPick: (hex) => { editor.setColor(hex); picker.set(hex); },
    });
    const recentEl = el("div", { class: "dock-stack" }, [fieldLabel("Recientes"), recent.el]);
    this.customs.set("recents", { el: recentEl, sync: (s) => recent.set({ colors: s.recentColors, value: s.color }) });

    // Vista previa del pincel: una S con perfil de presión sintético.
    const preview = el("canvas", { class: "brush-preview" });
    preview.width = 520;
    preview.height = 128;
    this.customs.set("brush-preview", { el: preview, sync: (s) => drawBrushPreview(preview, s) });

    // Nota viva de la dinámica activa.
    const dynHint = fieldLabel(DYNAMICS_INFO[editor.brush.dynamics].hint);
    this.customs.set("brush-dyn-hint", { el: dynHint, sync: (s) => { dynHint.textContent = DYNAMICS_INFO[s.brush.dynamics].hint; } });

    // Conteo vivo de copias de simetría.
    const copies = fieldLabel("1 copia");
    this.customs.set("sym-copies", {
      el: copies,
      sync: (s) => { const n = symmetryCopies(s.symmetry); copies.textContent = n === 1 ? "1 copia" : `${n} copias por trazo`; },
    });

    // Hornear a tinta (el radial trae su propia acción `bake`).
    const bake = button({ label: "Hornear a tinta", iconName: "bake", title: "Convierte el contorno fundido en trazos editables", onClick: () => editor.bakeMatter() });
    this.customs.set("bake-dock", { el: bake.el });

    const selInfo = fieldLabel("Nada seleccionado");
    this.customs.set("select-info", { el: selInfo, sync: (s) => { selInfo.textContent = s.selectCount === 0 ? "Nada seleccionado — clic o arrastra para elegir tinta, materia o imagen. Shift añade." : `${s.selectCount} elemento(s) — ${s.selectBounds ? `${Math.round(s.selectBounds.w)}×${Math.round(s.selectBounds.h)}` : ""}`; } });
    const alignRow = el("div", { class: "select-align-row" }, [
      button({ iconName: "alignLeft", title: "Alinear izquierda", onClick: () => editor.alignSelection("left") }).el,
      button({ iconName: "alignCenter", title: "Alinear centro", onClick: () => editor.alignSelection("center") }).el,
      button({ iconName: "alignRight", title: "Alinear derecha", onClick: () => editor.alignSelection("right") }).el,
    ]);
    this.customs.set("select-align", { el: alignRow });

    // Panel de capas (estilo Photoshop): monta LayersPanel y lo sincroniza cada
    // fotograma. Toda la interacción (filas, arrastre, menú) vive en la clase.
    const layers = new LayersPanel(editor);
    this.customs.set("layers-panel", { el: layers.el, sync: (s) => layers.update(s) });
  }
  /** ¿El nodo (dominio, grupo o campo) aparece en el dock? */
  private inDock(n: SchemaNode): boolean {
    return !n.surfaces || n.surfaces.includes("dock");
  }

  /**
   * Página de un dominio. Los campos sueltos (fuera de grupos) se juntan en una
   * sección con la etiqueta del dominio; cada grupo es su propia sección. El
   * orden entre la sección suelta y las de grupos sigue a qué aparece primero en
   * el esquema (opciones del pincel arriba; acciones de materia abajo).
   */
  private buildPage(domain: Domain, s0: EditorState): HTMLElement {
    const looseEls: HTMLElement[] = [];
    const groupSecs: HTMLElement[] = [];
    let looseFirst: boolean | null = null;

    // El pincel abre con su segmentado de modo (Trazo/Relleno/Arrastre/Borrador).
    if (domain.layout === "brush-by-mode" && this.dock.modeEl) {
      looseEls.push(this.dock.modeEl);
      looseFirst = true;
    }

    for (const child of domain.children) {
      if (!this.inDock(child)) continue;
      if (isGroup(child)) {
        if (looseFirst === null) looseFirst = false;
        const kids = this.nodeEls(child.children, s0);
        if (kids.length === 0) continue;
        const sec = section(val(child.label ?? "", s0), kids);
        if (child.visible) this.dynVis.push({ el: sec, visible: child.visible });
        groupSecs.push(sec);
      } else {
        const e = this.fieldEl(child, s0);
        if (!e) continue;
        if (looseFirst === null) looseFirst = true;
        looseEls.push(e);
      }
    }

    const parts: HTMLElement[] = [];
    const looseSec = looseEls.length ? section(val(domain.label ?? domain.id, s0), looseEls) : null;
    if (looseSec && looseFirst !== false) parts.push(looseSec);
    parts.push(...groupSecs);
    if (looseSec && looseFirst === false) parts.push(looseSec);
    return el("div", { class: "dock-page" }, parts);
  }
  /** Elementos de una lista de nodos (para el contenido de un grupo/sección). */
  private nodeEls(nodes: SchemaNode[], s0: EditorState): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const n of nodes) {
      if (!this.inDock(n)) continue;
      if (isGroup(n)) {
        const kids = this.nodeEls(n.children, s0);
        if (kids.length === 0) continue;
        const sec = section(val(n.label ?? "", s0), kids);
        if (n.visible) this.dynVis.push({ el: sec, visible: n.visible });
        out.push(sec);
      } else {
        const e = this.fieldEl(n, s0);
        if (e) out.push(e);
      }
    }
    return out;
  }

  /**
   * Elemento de un campo, etiquetado con `data-field-id` para que el paletón
   * pueda desplazarse a él y destellarlo (ver `reveal`). El armado real lo hace
   * `rawFieldEl`; aquí solo se marca.
   */
  private fieldEl(f: Field, s0: EditorState): HTMLElement | null {
    const e = this.rawFieldEl(f, s0);
    if (e) e.dataset.fieldId = f.id;
    return e;
  }

  /**
   * Elemento de un campo: `custom` → su adaptador (o una nota `note-*` por
   * convención); cualquier otro → el control genérico que ya creó DockRenderer.
   * Registra sincronía y visibilidad viva cuando el campo las declara.
   */
  private rawFieldEl(f: Field, s0: EditorState): HTMLElement | null {
    if (f.kind === "custom") {
      const c = this.customs.get(f.id);
      if (c) {
        if (c.sync) this.customSyncs.push(c.sync);
        if (f.visible) this.dynVis.push({ el: c.el, visible: f.visible });
        return c.el;
      }
      // Notas estáticas de ayuda: se rinden con su `hint` como texto.
      if (f.id.startsWith("note-")) {
        const note = fieldLabel(val(f.hint ?? f.label, s0));
        if (f.visible) this.dynVis.push({ el: note, visible: f.visible });
        return note;
      }
      return null; // custom sin adaptador en el dock (p. ej. solo-radial)
    }
    // Campo genérico: DockRenderer ya lo construyó (si no, no aplica al dock).
    try {
      return this.dock.el(f.id);
    } catch {
      return null;
    }
  }
  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  /**
   * Abre la pestaña del dominio y, si se indica un campo, lo centra en el panel y
   * lo resalta con un halo. El resalte NO se quita solo: se mantiene hasta que el
   * usuario vuelve a hacer clic en cualquier sitio o pulsa una tecla (interactuar),
   * para que pueda mirarlo con calma. Lo usa el paletón para "llevar" al usuario a
   * la opción elegida. Si el dominio no es una pestaña del dock, no hace nada.
   */
  reveal(domainId: string, fieldId?: string): void {
    if (!this.tabs.has(domainId)) return;
    // Si el cajón venía cerrado o en otra pestaña, se le da un respiro para que el
    // deslizamiento/altura lo traiga a la vista antes de centrar y destellar; si ya
    // estaba en esa pestaña, es inmediato.
    const wasShowing = this.openCat === domainId;
    this.setOpen(domainId);
    if (!fieldId) return;
    this.clearFlash();
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      const node = this.content.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(fieldId)}"]`);
      if (!node) return;
      node.scrollIntoView({ block: "center", behavior: wasShowing ? "smooth" : "auto" });
      // Por si este mismo campo se estaba desvaneciendo de un resalte anterior:
      // cancelar su salida y arrancar limpio.
      window.clearTimeout(this.flashOutTimer);
      node.classList.remove("is-flash-out");
      node.classList.add("is-flash");
      // Marco punteado (SVG con esquinas redondeadas) que marcha alrededor. Va como
      // elemento hijo para que el trazo siga la curva de las esquinas sin cortes.
      if (!node.querySelector(".dock-flash-frame")) node.appendChild(this.makeFlashFrame());
      this.flashed = node;
      // Armar el descarte en el próximo frame: así el mismo gesto que abrió el panel
      // (el clic en el paletón) no lo cierra de inmediato; solo la siguiente acción.
      requestAnimationFrame(() => {
        window.addEventListener("pointerdown", this.dismissFlash, true);
        window.addEventListener("keydown", this.dismissFlash, true);
      });
    }, wasShowing ? 0 : 200);
  }

  /** Quita el resalte a la próxima interacción del usuario. */
  private dismissFlash = (): void => this.clearFlash();

  /** Construye el marco punteado del resalte: un SVG con un `<rect>` redondeado. La
      geometría (posición, tamaño, radio, trazo y marcha) la fija el CSS; aquí solo se
      crea el esqueleto. */
  private makeFlashFrame(): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "dock-flash-frame");
    svg.setAttribute("aria-hidden", "true");
    svg.appendChild(document.createElementNS(NS, "rect"));
    return svg;
  }

  /** Retira el resalte activo (si lo hay) y desarma sus escuchas. La salida es
      suave: se marca `is-flash-out` para que el CSS funda el halo y el marco, y se
      quitan las clases y el marco al terminar la transición. */
  private clearFlash(): void {
    window.removeEventListener("pointerdown", this.dismissFlash, true);
    window.removeEventListener("keydown", this.dismissFlash, true);
    const node = this.flashed;
    this.flashed = null;
    if (!node) return;
    window.clearTimeout(this.flashOutTimer);
    node.classList.add("is-flash-out");
    this.flashOutTimer = window.setTimeout(() => {
      node.classList.remove("is-flash", "is-flash-out");
      node.querySelector(".dock-flash-frame")?.remove();
    }, 460);
  }

  /** Pulsar una pestaña: abre su dominio, o lo repliega si ya estaba abierto. */
  private toggle(cat: string): void {
    this.setOpen(this.openCat === cat ? null : cat);
  }

  private setOpen(cat: string | null): void {
    // Cambiar de un dominio a otro estando ya abierto: animar la altura del panel
    // de la anterior a la nueva (si no, saltaría de golpe). Al abrir desde cerrado
    // o al cerrar no aplica: ahí manda el deslizamiento lateral.
    const switching = this.openCat !== null && cat !== null && cat !== this.openCat;

    this.openCat = cat;
    if (cat) this.edge.start();
    else this.edge.collapse();

    // Al CERRAR (cat === null) no se ocultan las páginas todavía: el cajón se
    // desliza fuera con su contenido intacto. Solo se quita is-open.
    if (cat !== null) {
      if (switching) this.animateHeightSwap();
      else this.renderState();
    } else {
      setClass(this.el, "is-open", false);
      for (const [id, tab] of this.tabs) {
        setClass(tab, "is-open", false);
        setClass(tab, "is-active", id === this.activeTool);
      }
    }
  }
  /**
   * Cambia de página animando la altura (técnica FLIP): mide el alto actual,
   * intercambia la página, mide el nuevo y transiciona entre ambos. El
   * ResizeObserver del borde vivo redibuja la silueta en cada paso intermedio.
   */
  private animateHeightSwap(): void {
    const from = this.content.offsetHeight;
    this.renderState();
    this.content.style.height = "auto";
    const to = this.content.offsetHeight;
    if (from === to) return;

    this.content.style.height = `${from}px`;
    void this.content.offsetHeight; // reflow: fija el punto de partida
    this.content.classList.add("is-resizing");
    this.content.style.height = `${to}px`;

    window.clearTimeout(this.heightTimer);
    this.heightTimer = window.setTimeout(() => {
      this.content.classList.remove("is-resizing");
      this.content.style.height = "";
    }, 340);
  }

  /**
   * Resalta la pestaña de la herramienta activa sin abrir el cajón. Herramientas
   * sin ajustes (cuentagotas, mano) no resaltan ninguna.
   */
  focusTool(tool: ToolId): void {
    this.activeTool = TOOL_TO_CAT[tool] ?? null;
    this.renderState();
  }
  /** Pinta el estado de pestañas/cajón: abierta, en-uso y qué página se ve. */
  private renderState(): void {
    setClass(this.el, "is-open", this.openCat !== null);
    for (const [id, tab] of this.tabs) {
      setClass(tab, "is-open", id === this.openCat);
      setClass(tab, "is-active", id === this.activeTool);
    }
    for (const def of this.tabDefs) {
      setClass(this.pages[def.id], "is-shown", def.id === this.openCat);
    }
    if (this.openCat) {
      const def = this.tabDefs.find((d) => d.id === this.openCat);
      if (def) this.dockTitle.textContent = def.label;
    }
  }

  update(state: EditorState): void {
    // La pestaña "en uso" sigue a la herramienta activa.
    this.focusTool(state.tool);

    // Todos los controles del esquema: valor + visibilidad por campo.
    this.dock.sync(state);
    // Cromo propio: refresco de valores (color, paletas, vista previa, notas…).
    for (const sync of this.customSyncs) sync(state);
    // Visibilidad de secciones (grupos) y campos custom por predicado.
    for (const { el: node, visible } of this.dynVis) setClass(node, "is-hidden", !visible(state));
  }

}

/**
 * Vista previa del pincel.
 *
 * Dibuja una S con un perfil de presion sintetico usando los mismos ajustes de
 * ancho: es la unica forma de ver que hace realmente "curva de presion" o
 * "afilado final" sin gastar un trazo en el lienzo.
 */
function drawBrushPreview(c: HTMLCanvasElement, state: EditorState): void {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);

  const b = state.brush;
  const steps = 96;
  const maxR = Math.min(h * 0.42, Math.max(2, b.size * 0.5) * 2.2);
  const top: { x: number; y: number }[] = [];
  const bottom: { x: number; y: number }[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = 18 + t * (w - 36);
    const y = h / 2 + Math.sin(t * Math.PI * 1.7) * h * 0.24;

    // Perfil sintetico: sube, se mantiene y cae, como un trazo real.
    let p = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.85 + 0.15;
    if (b.pressureCurve !== 0) {
      p = Math.pow(p, Math.exp(b.pressureCurve * 1.2));
    }
    const speed = 0.35 + 0.65 * Math.abs(Math.cos(t * Math.PI * 1.7));
    const vel = b.velocityInvert ? speed : 1 - speed;
    const dyn = b.dynamics;
    let k =
      dyn === "constant"
        ? 1
        : dyn === "pressure"
          ? p
          : dyn === "velocity"
            ? vel
            : dyn === "tilt"
              ? 0.55 + 0.45 * Math.sin(t * Math.PI)
              : p * 0.6 + vel * 0.4;
    const taper = Math.min(
      b.taperIn > 0 ? Math.min(1, t / b.taperIn) : 1,
      b.taperOut > 0 ? Math.min(1, (1 - t) / b.taperOut) : 1,
    );
    k = (b.minRatio + (1 - b.minRatio) * k) * taper;
    if (b.jitter > 0) k *= 1 - b.jitter * 0.5 * Math.abs(Math.sin(t * 57.3));

    const r = Math.max(0.4, k * maxR);
    const dy = Math.cos(t * Math.PI * 1.7) * h * 0.24 * ((Math.PI * 1.7) / (w - 36));
    const len = Math.hypot(1, dy) || 1;
    const px = -dy / len;
    const py = 1 / len;
    top.push({ x: x + px * r, y: y + py * r });
    bottom.push({ x: x - px * r, y: y - py * r });
  }
  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  for (const p of top) ctx.lineTo(p.x, p.y);
  for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i].x, bottom[i].y);
  ctx.closePath();
  ctx.globalAlpha = b.opacity;
  ctx.fillStyle = state.color;
  ctx.fill();
  ctx.globalAlpha = 1;
}
