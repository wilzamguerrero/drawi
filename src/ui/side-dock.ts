import type { Editor, EditorState } from "../app/editor";
import { DEFAULT_PALETTES } from "../core/color";
import { DYNAMICS_INFO } from "../stroke/types";
import { symmetryCopies } from "../symmetry/symmetry";
import type { ToolId } from "../tools/types";
import { ColorPicker } from "./color-picker";
import { button, fieldLabel, row, section, segmented, swatches, type Control } from "./controls";
import { blurSoon, el, setClass } from "./dom";
import { MateriaEdge } from "./fx/materia-edge";
import type { MenuHooks } from "./hotbox/menu";
import { icon } from "./icons";
import { DockRenderer } from "./model/render-dock";
import { buildSchema } from "./model/schema";

/** Categorías del dock. Cada una agrupa las secciones de una herramienta. */
type CatId = "color" | "brush" | "symmetry" | "matter";

interface CatDef {
  id: CatId;
  label: string;
  icon: string;
}

const CATEGORIES: CatDef[] = [
  { id: "brush", label: "Pincel", icon: "brush" },
  { id: "matter", label: "Materia", icon: "shape" },
  { id: "color", label: "Color", icon: "droplet" },
  { id: "symmetry", label: "Simetría", icon: "symmetry" },
];

/**
 * Qué pestaña corresponde a cada herramienta. Al cambiar de herramienta el dock
 * resalta la pestaña relacionada (no la abre: solo la marca como "en uso"). Las
 * herramientas sin ajustes propios —cuentagotas y mano— no resaltan ninguna.
 */
const TOOL_TO_CAT: Partial<Record<ToolId, CatId>> = {
  brush: "brush",
  shape: "matter",
  matter: "matter",
  symmetry: "symmetry",
};

/**
 * El dock no consume los puertos de archivo/rueda (esos campos del esquema son
 * `surfaces: ["radial"]` y `DockRenderer` los omite), pero `buildSchema` los
 * exige. Se le pasa esta implementación vacía: nunca se invoca desde el dock.
 */
const NO_HOOKS: MenuHooks = {
  toggleWheel() {},
  help() {},
  newDoc() {},
  openFile() {},
  save() {},
  exportPng() {},
  exportSvg() {},
};
/**
 * Dock lateral izquierdo.
 *
 * Un único panel anclado al borde izquierdo que, plegado, deja ver solo su tira
 * de pestañas —una por categoría—. Al pulsar una pestaña el cajón se desliza
 * desde el borde con los ajustes de esa categoría; al volver a pulsarla, se
 * repliega. Cambiar de herramienta resalta su pestaña para invitar a abrirla,
 * pero no interrumpe el dibujo abriéndola sola.
 *
 * Los controles NO se declaran aquí: salen del esquema único (`model/schema.ts`)
 * a través de `DockRenderer`, que los crea una vez y los sincroniza por `id`. El
 * dock solo los compone en sus páginas y añade el cromo propio de la superficie
 * (selector HSV, paletas, vista previa, notas de ayuda). Reconstruir el panel en
 * cada cambio perdería el foco del campo en edición y haría parpadear los
 * deslizadores, así que solo se sincroniza (`dock.sync`) en cada `update`.
 */
export class SideDock {
  readonly el: HTMLElement;

  private sections: Record<string, HTMLElement> = {};
  private dock: DockRenderer;
  private pages: Record<CatId, HTMLElement> = {} as Record<CatId, HTMLElement>;
  private tabs = new Map<CatId, HTMLButtonElement>();

  private drawer: HTMLElement;
  private edge: MateriaEdge;
  private content!: HTMLElement;
  private heightTimer = 0;
  private dynamicsHint: HTMLElement;
  private symmetryCount: HTMLElement;
  private brushPreview: HTMLCanvasElement;
  private pullGroup: HTMLElement;
  // Controles que solo tienen sentido pintando (Trazo/Relleno/Arrastre) y los
  // exclusivos del Borrador: se intercambian por modo, igual que en el radial.
  private strokeGroup!: HTMLElement;
  private eraseGroup!: HTMLElement;

  // Estado del cajón: qué categoría está abierta (null = plegado) y cuál está
  // "en uso" por la herramienta activa (solo resalta la pestaña).
  private openCat: CatId | null = null;
  private activeTool: CatId | null = null;

  // Color: cromo propio del dock, se refresca con el estado como el resto.
  private colorPicker: ColorPicker;
  private recentSwatches: Control<{ colors: readonly string[]; value: string }>;
  private paletteTabs: Control<string>;
  private paletteWells: Control<{ colors: readonly string[]; value: string }>;

  constructor(editor: Editor) {
    const dock = new DockRenderer(editor, buildSchema(editor, editor.state, NO_HOOKS));
    this.dock = dock;
    const c = (id: string): HTMLElement => dock.el(id);
    // ============================================================ color
    // Selector HSV, recientes y paletas: cromo propio del dock (la rueda del
    // radial cumple ese papel). Se cablean a mano y se refrescan en update().
    this.colorPicker = new ColorPicker(editor.color, (hex) => editor.setColor(hex));
    this.recentSwatches = swatches({
      colors: editor.recentColors,
      value: editor.color,
      onPick: (hex) => { editor.setColor(hex); this.colorPicker.set(hex); },
    });
    this.paletteTabs = segmented({
      options: DEFAULT_PALETTES.map((p, i) => ({ value: String(i), label: p.name })),
      value: String(editor.paletteIndex),
      onChange: (v) => {
        editor.setPalette(Number(v));
        this.paletteWells.set({ colors: editor.palette.colors, value: editor.color });
      },
    });
    this.paletteWells = swatches({
      colors: editor.palette.colors,
      value: editor.color,
      onPick: (hex) => { editor.setColor(hex); this.colorPicker.set(hex); },
    });
    this.sections.color = section("Color", [
      this.colorPicker.el,
      fieldLabel("Recientes"),
      this.recentSwatches.el,
      this.paletteTabs.el,
      this.paletteWells.el,
    ]);

    // ------------------------------------------------------------- pincel
    this.dynamicsHint = fieldLabel(DYNAMICS_INFO[editor.brush.dynamics].hint);
    this.brushPreview = el("canvas", { class: "brush-preview" });
    this.brushPreview.width = 520;
    this.brushPreview.height = 128;
    // "Familia" (solo Arrastre): control + nota; se oculta el grupo entero.
    this.pullGroup = el("div", { class: "ctrl-group" }, [
      c("pull-family"),
      fieldLabel("Arrastra para estirar una forma entre los dos puntos."),
    ]);

    const modeEl = dock.modeEl;
    // Opciones de pintura (dinamica, perfil, degradado, splat…): se ocultan en
    // el Borrador. Van envueltas para intercambiarlas de un golpe por modo, sin
    // depender de la visibilidad campo a campo (que el radial sí resuelve por
    // grupo, pero el dock compone a mano).
    this.strokeGroup = el("div", { class: "dock-stack" }, [
      this.brushPreview,
      c("dynamics"),
      this.dynamicsHint,
      c("min-ratio"),
      c("pressure-curve"),
      c("velocity-scale"),
      c("velocity-invert"),
      row([c("taper-in"), c("taper-out")]),
      c("jitter"),
      el("div", { class: "ctrl-group" }, [c("splat"), c("gradient"), c("invert-erase")]),
    ]);
    // Opciones exclusivas del Borrador: mismo contenido que muestra el radial.
    this.eraseGroup = el("div", { class: "dock-stack" }, [
      c("erase-mode"),
      el("div", { class: "ctrl-group" }, [c("erase-fade"), c("erase-matter")]),
    ]);
    this.sections.brush = section("Pincel", [
      ...(modeEl ? [modeEl] : []),
      c("size"),
      c("opacity"),
      this.pullGroup,
      this.strokeGroup,
      this.eraseGroup,
    ]);
    this.sections.stabilize = section("Respuesta del lapiz", [
      c("smoothing"),
      c("streamline"),
      fieldLabel("El suavizado corrige el temblor y el estabilizador la direccion. Si notas la punta lenta, baja el estabilizador antes que el suavizado."),
    ]);
    // -------------------------------------------------------------- forma
    this.sections.shape = section("Forma", [
      c("shape-kind"),
      c("shape-size"),
      c("shape-aspect"),
      c("shape-sides"),
      c("shape-inner"),
      c("shape-round"),
      fieldLabel("Arrastra en el lienzo para colocarla y girarla antes de soltarla."),
    ]);

    // ----------------------------------------------------------- simetria
    this.symmetryCount = fieldLabel("1 copia");
    this.sections.symmetry = section("Simetria", [
      c("sym-mode"),
      c("sym-count"),
      c("sym-angle"),
      el("div", { class: "ctrl-group" }, [c("sym-visible"), c("sym-locked")]),
      row([c("sym-center"), c("sym-straighten")]),
      this.symmetryCount,
      fieldLabel("Con la herramienta de simetria (S) puedes arrastrar el eje a cualquier punto del lienzo."),
    ]);

    // ------------------------------------------------------------ fisica
    this.sections.physics = section("Fisica", [
      c("gravity"),
      c("gravity-x"),
      c("cohesion"),
      c("damping"),
      row([c("restitution"), c("friction")]),
      c("iterations"),
      c("time-scale"),
      el("div", { class: "ctrl-group" }, [c("sleeping"), c("walls"), c("colliders")]),
      row([c("zero-g"), c("clear-matter")]),
    ]);

    // ------------------------------------------------------------- campo
    this.sections.field = section("Materia", [
      c("blend"),
      c("outline"),
      c("shade"),
      c("gloss"),
      c("depth"),
      c("field-alpha"),
      button({
        label: "Hornear a tinta",
        iconName: "bake",
        title: "Convierte el contorno fundido en trazos editables",
        onClick: () => editor.bakeMatter(),
      }).el,
    ]);
    // =================================================== páginas por categoría
    this.pages.color = el("div", { class: "dock-page" }, [this.sections.color]);
    this.pages.brush = el("div", { class: "dock-page" }, [this.sections.brush, this.sections.stabilize]);
    this.pages.symmetry = el("div", { class: "dock-page" }, [this.sections.symmetry]);
    // Materia arranca con los ajustes de Forma (antes pestaña propia): la forma
    // se coloca al dibujar y alimenta la materia, así que viven juntas.
    this.pages.matter = el("div", { class: "dock-page" }, [this.sections.shape, this.sections.field, this.sections.physics]);

    // Cabecera del cajón: título de la categoría abierta + botón de cerrar.
    const titleEl = el("span", { class: "dock-title" });
    const closeBtn = el("button", {
      class: "dock-close",
      type: "button",
      title: "Cerrar panel",
      html: icon("close"),
    });
    closeBtn.addEventListener("click", () => this.setOpen(null));
    const head = el("div", { class: "dock-head" }, [titleEl, closeBtn]);
    this.dockTitle = titleEl;

    const scroll = el("div", { class: "dock-scroll" }, Object.values(this.pages));

    // "Piel" del panel: el relleno del panel dibujado como un trazo vectorial que
    // se remodela por frames (MateriaEdge). El borde derecho —el que da al
    // lienzo— ondula como una masa; los otros tres quedan rectos. Al ser vector,
    // el contorno se antialiasea perfecto: continuo y fluido, sin el pixelado ni
    // las "vetas" que dejaba deformar píxeles con un filtro SVG. Va detrás del
    // contenido, que vive en su propia capa nítida.
    this.edge = new MateriaEdge({ fill: "#161619", radius: 22, amplitude: 11 });
    this.edge.el.classList.add("dock-skin");
    this.content = el("div", { class: "dock-content" }, [head, scroll]);
    this.drawer = el("div", { class: "dock-drawer" }, [this.edge.el, this.content]);

    // Tira de pestañas, siempre visible en el borde.
    const strip = el("div", { class: "dock-tabs" });
    for (const cat of CATEGORIES) {
      const tab = el("button", {
        class: "dock-tab",
        type: "button",
        title: cat.label,
        html: icon(cat.icon),
      });
      tab.addEventListener("click", () => {
        this.toggle(cat.id);
        blurSoon(tab);
      });
      this.tabs.set(cat.id, tab);
      strip.appendChild(tab);
    }

    this.el = el("aside", { class: "side-dock", role: "toolbar" }, [this.drawer, strip]);
    this.renderState();
  }
  private dockTitle!: HTMLElement;

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  /** Pulsar una pestaña: abre su categoría, o la repliega si ya estaba abierta. */
  private toggle(cat: CatId): void {
    this.setOpen(this.openCat === cat ? null : cat);
  }

  private setOpen(cat: CatId | null): void {
    // Cambiar de una categoría a otra estando ya abierto: animar la altura del
    // panel de la anterior a la nueva (si no, saltaría de golpe y se siente
    // seco). Al abrir desde cerrado o al cerrar no aplica: ahí manda el
    // deslizamiento lateral.
    const switching = this.openCat !== null && cat !== null && cat !== this.openCat;

    this.openCat = cat;
    // Al abrir, el borde cobra vida; al cerrar, se aplana suavemente a recto
    // mientras el panel se desliza fuera (collapse), así al final no asoma el
    // ondulado congelado por el marco.
    if (cat) this.edge.start();
    else this.edge.collapse();

    // Al CERRAR (cat === null), NO ocultar las páginas todavía: el cajón se
    // desliza fuera de la ventana con su contenido intacto (misma altura). Si
    // quitáramos display:none ahora, el contenido desaparecería primero, el
    // drawer se encogiría a 0 y la animación se vería como un "achicamiento"
    // en vez de un deslizamiento limpio. Las páginas se ocultan cuando se abra
    // otra categoría (renderState las intercambia) o se quedan hidden fuera de
    // la ventana, sin coste visual.
    if (cat !== null) {
      if (switching) {
        this.animateHeightSwap();
      } else {
        // Abrir desde cerrado: intercambiar páginas normalmente.
        this.renderState();
      }
    } else {
      // Cerrar: solo quitar la clase is-open del contenedor y las pestañas,
      // sin tocar las páginas para que el drawer mantenga su tamaño.
      setClass(this.el, "is-open", false);
      for (const [id, tab] of this.tabs) {
        setClass(tab, "is-open", false);
        setClass(tab, "is-active", id === this.activeTool);
      }
    }
  }
  /**
   * Cambia de página animando la altura (técnica FLIP): mide el alto actual,
   * intercambia la página, mide el nuevo y transiciona entre ambos con una
   * altura explícita. El ResizeObserver del borde vivo redibuja la silueta en
   * cada paso intermedio, así el contorno ondulado acompaña el cambio de tamaño.
   */
  private animateHeightSwap(): void {
    const from = this.content.offsetHeight;
    // Intercambiar la página visible y actualizar pestañas/título.
    this.renderState();
    // Alto natural de la nueva página (con la altura aún sin fijar).
    this.content.style.height = "auto";
    const to = this.content.offsetHeight;
    if (from === to) return;

    // Fijar el alto de partida, forzar reflow y transicionar al de destino.
    this.content.style.height = `${from}px`;
    void this.content.offsetHeight; // reflow: fija el punto de partida
    this.content.classList.add("is-resizing");
    this.content.style.height = `${to}px`;

    window.clearTimeout(this.heightTimer);
    this.heightTimer = window.setTimeout(() => {
      // Al terminar, soltar la altura fija para que vuelva a adaptarse sola
      // (p.ej. si un control cambia de alto o se abre/cierra una sección).
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
    for (const cat of CATEGORIES) {
      setClass(this.pages[cat.id], "is-shown", cat.id === this.openCat);
    }
    if (this.openCat) {
      const def = CATEGORIES.find((c) => c.id === this.openCat);
      if (def) this.dockTitle.textContent = def.label;
    }
  }
  update(state: EditorState): void {
    // La pestaña "en uso" sigue a la herramienta activa.
    this.focusTool(state.tool);

    // Color: cromo propio del dock, sincronizado a mano.
    this.colorPicker.set(state.color);
    this.recentSwatches.set({ colors: state.recentColors, value: state.color });
    this.paletteTabs.set(String(state.paletteIndex));
    this.paletteWells.set({ colors: state.palette.colors, value: state.color });

    // Todos los controles del esquema: valor + visibilidad (atenuar/ocultar).
    this.dock.sync(state);

    // Notas de ayuda que dependen del estado (viven fuera del esquema).
    this.dynamicsHint.textContent = DYNAMICS_INFO[state.brush.dynamics].hint;
    const copies = symmetryCopies(state.symmetry);
    this.symmetryCount.textContent = copies === 1 ? "1 copia" : `${copies} copias por trazo`;

    // El grupo "Familia" (control + nota) se oculta entero fuera de Arrastre.
    setClass(this.pullGroup, "is-hidden", state.brush.mode !== "pull");

    // Borrador (tecla 4): intercambia las opciones de pintura por las de borrado
    // y oculta la sección de respuesta del lápiz, igual que hace el menú radial.
    const erasing = state.brush.mode === "erase";
    setClass(this.strokeGroup, "is-hidden", erasing);
    setClass(this.eraseGroup, "is-hidden", !erasing);
    setClass(this.sections.stabilize, "is-hidden", erasing);

    this.drawPreview(state);
  }
  /**
   * Vista previa del pincel.
   *
   * Dibuja una S con un perfil de presion sintetico usando los mismos ajustes
   * de ancho: es la unica forma de ver que hace realmente "curva de presion" o
   * "afilado final" sin gastar un trazo en el lienzo.
   */
  private drawPreview(state: EditorState): void {
    const c = this.brushPreview;
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
}
