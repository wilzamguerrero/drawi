import type { Editor, EditorState } from "../app/editor";
import { DEFAULT_PALETTES } from "../core/color";
import { SHAPE_LABELS, type ShapeKind } from "../physics/shapes";
import { DYNAMICS_INFO, type BrushMode, type StrokeDynamics } from "../stroke/types";
import { SYMMETRY_LABELS, symmetryCopies, type SymmetryMode } from "../symmetry/symmetry";
import { PULL_LABELS, type PullFamily } from "../tools/pull-shapes";
import type { ToolId } from "../tools/types";
import { ColorPicker } from "./color-picker";
import { button, fieldLabel, row, section, segmented, select, slider, swatches, toggle, type Control } from "./controls";
import { blurSoon, el, setClass } from "./dom";
import { MateriaEdge } from "./fx/materia-edge";
import { icon } from "./icons";

const MODE_LABELS: Record<BrushMode, string> = {
  stroke: "Trazo",
  fill: "Relleno",
  pull: "Arrastre",
};

/** Categorías del dock. Cada una agrupa las secciones de una herramienta. */
type CatId = "color" | "brush" | "shape" | "symmetry" | "matter";

interface CatDef {
  id: CatId;
  label: string;
  icon: string;
}

const CATEGORIES: CatDef[] = [
  { id: "color", label: "Color", icon: "droplet" },
  { id: "brush", label: "Pincel", icon: "brush" },
  { id: "shape", label: "Forma", icon: "shape" },
  { id: "symmetry", label: "Simetría", icon: "symmetry" },
  { id: "matter", label: "Materia", icon: "matter" },
];

/**
 * Qué pestaña corresponde a cada herramienta. Al cambiar de herramienta el dock
 * resalta la pestaña relacionada (no la abre: solo la marca como "en uso"). Las
 * herramientas sin ajustes propios —cuentagotas y mano— no resaltan ninguna.
 */
const TOOL_TO_CAT: Partial<Record<ToolId, CatId>> = {
  brush: "brush",
  shape: "shape",
  matter: "matter",
  symmetry: "symmetry",
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
 * El color, que antes vivía en el menú radial, es ahora una pestaña más: un solo
 * sitio para todos los ajustes.
 *
 * Las secciones se construyen una vez y se muestran u ocultan por categoría:
 * reconstruir el panel en cada cambio perdería el foco del campo que estuvieras
 * editando y haría parpadear los deslizadores.
 */
export class SideDock {
  readonly el: HTMLElement;

  private sections: Record<string, HTMLElement> = {};
  private controls: Record<string, Control<never>> = {};
  private pages: Record<CatId, HTMLElement> = {} as Record<CatId, HTMLElement>;
  private tabs = new Map<CatId, HTMLButtonElement>();

  private drawer: HTMLElement;
  private edge: MateriaEdge;
  private dynamicsHint: HTMLElement;
  private symmetryCount: HTMLElement;
  private brushPreview: HTMLCanvasElement;
  private velocityGroup: HTMLElement;
  private pressureGroup: HTMLElement;
  private pullGroup: HTMLElement;

  // Estado del cajón: qué categoría está abierta (null = plegado) y cuál está
  // "en uso" por la herramienta activa (solo resalta la pestaña).
  private openCat: CatId | null = null;
  private activeTool: CatId | null = null;

  // Color: se refresca con el estado, como el resto de controles.
  private colorPicker: ColorPicker;
  private recentSwatches: Control<{ colors: readonly string[]; value: string }>;
  private paletteTabs: Control<string>;
  private paletteWells: Control<{ colors: readonly string[]; value: string }>;

  constructor(editor: Editor) {
    const b = editor.brush;

    // ============================================================ color
    this.colorPicker = new ColorPicker(editor.color, (hex) => editor.setColor(hex));
    this.recentSwatches = swatches({
      colors: editor.recentColors,
      value: editor.color,
      onPick: (hex) => {
        editor.setColor(hex);
        this.colorPicker.set(hex);
      },
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
      onPick: (hex) => {
        editor.setColor(hex);
        this.colorPicker.set(hex);
      },
    });

    this.sections.color = section("Color", [
      this.colorPicker.el,
      fieldLabel("Recientes"),
      this.recentSwatches.el,
      this.paletteTabs.el,
      this.paletteWells.el,
    ]);

    // ------------------------------------------------------------- pincel
    const mode = segmented<BrushMode>({
      options: (["stroke", "fill", "pull"] as BrushMode[]).map((m) => ({
        value: m,
        label: MODE_LABELS[m],
        title: `${MODE_LABELS[m]} (${m === "stroke" ? 1 : m === "fill" ? 2 : 3})`,
      })),
      value: b.mode,
      onChange: (v) => editor.setBrush({ mode: v }),
    });
    this.controls.mode = mode as Control<never>;

    const dynamics = select<StrokeDynamics>({
      label: "Dinamica",
      options: (Object.keys(DYNAMICS_INFO) as StrokeDynamics[]).map((k) => ({
        value: k,
        label: DYNAMICS_INFO[k].label,
      })),
      value: b.dynamics,
      onChange: (v) => editor.setBrush({ dynamics: v }),
    });
    this.controls.dynamics = dynamics as Control<never>;
    this.dynamicsHint = fieldLabel(DYNAMICS_INFO[b.dynamics].hint);

    this.brushPreview = el("canvas", { class: "brush-preview" });
    this.brushPreview.width = 520;
    this.brushPreview.height = 128;

    const size = slider({
      label: "Tamano",
      min: 0.5,
      max: 400,
      step: 0.5,
      decimals: 1,
      gamma: 2.2,
      value: b.size,
      unit: "px",
      hint: "Diametro base ([ y ] lo cambian sin soltar el lapiz).",
      onInput: (v) => editor.setBrush({ size: v }),
    });
    this.controls.size = size as Control<never>;

    const minRatio = slider({
      label: "Ancho minimo",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: b.minRatio,
      hint: "Fraccion del diametro a la que puede llegar la dinamica.",
      onInput: (v) => editor.setBrush({ minRatio: v }),
    });
    this.controls.minRatio = minRatio as Control<never>;

    const opacity = slider({
      label: "Opacidad",
      min: 0.02,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: b.opacity,
      onInput: (v) => editor.setBrush({ opacity: v }),
    });
    this.controls.opacity = opacity as Control<never>;

    const smoothing = slider({
      label: "Suavizado",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: b.smoothing,
      hint: "Filtro One-Euro: quita el temblor sin anadir retraso a velocidad alta.",
      onInput: (v) => editor.setBrush({ smoothing: v }),
    });
    this.controls.smoothing = smoothing as Control<never>;

    const streamline = slider({
      label: "Estabilizador",
      min: 0,
      max: 0.95,
      step: 0.01,
      decimals: 2,
      value: b.streamline,
      hint: "La punta persigue al cursor. Alto da curvas limpias, pero se nota el arrastre.",
      onInput: (v) => editor.setBrush({ streamline: v }),
    });
    this.controls.streamline = streamline as Control<never>;

    const pressureCurve = slider({
      label: "Curva de presion",
      min: -1,
      max: 1,
      step: 0.05,
      decimals: 2,
      value: b.pressureCurve,
      hint: "Negativo: responde antes con poca fuerza. Positivo: exige apretar mas.",
      onInput: (v) => editor.setBrush({ pressureCurve: v }),
    });
    this.controls.pressureCurve = pressureCurve as Control<never>;
    this.pressureGroup = el("div", { class: "ctrl-group" }, [pressureCurve.el]);

    const velocityScale = slider({
      label: "Escala de velocidad",
      min: 0.2,
      max: 6,
      step: 0.05,
      decimals: 2,
      value: b.velocityScale,
      unit: "px/ms",
      hint: "Velocidad de referencia: por encima de ella el trazo llega a su extremo.",
      onInput: (v) => editor.setBrush({ velocityScale: v }),
    });
    this.controls.velocityScale = velocityScale as Control<never>;

    const velocityInvert = toggle({
      label: "Rapido = grueso",
      value: b.velocityInvert,
      hint: "Apagado imita la tinta (rapido afina). Encendido imita el pincel seco.",
      onChange: (v) => editor.setBrush({ velocityInvert: v }),
    });
    this.controls.velocityInvert = velocityInvert as Control<never>;
    this.velocityGroup = el("div", { class: "ctrl-group" }, [velocityScale.el, velocityInvert.el]);

    const taperIn = slider({
      label: "Afilado inicial",
      min: 0,
      max: 0.5,
      step: 0.01,
      decimals: 2,
      value: b.taperIn,
      onInput: (v) => editor.setBrush({ taperIn: v }),
    });
    this.controls.taperIn = taperIn as Control<never>;

    const taperOut = slider({
      label: "Afilado final",
      min: 0,
      max: 0.5,
      step: 0.01,
      decimals: 2,
      value: b.taperOut,
      onInput: (v) => editor.setBrush({ taperOut: v }),
    });
    this.controls.taperOut = taperOut as Control<never>;

    const jitter = slider({
      label: "Temblor",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: b.jitter,
      hint: "Ruido de ancho: da textura de carboncillo.",
      onInput: (v) => editor.setBrush({ jitter: v }),
    });
    this.controls.jitter = jitter as Control<never>;

    const splat = toggle({
      label: "Splat",
      value: b.splat,
      hint: "Contorno anguloso en vez de suave (modificador de Alchemy). Tecla P.",
      onChange: (v) => editor.setBrush({ splat: v }),
    });
    this.controls.splat = splat as Control<never>;

    const gradient = toggle({
      label: "Degradado",
      value: b.gradient,
      hint: "Desvanece el trazo hacia abajo (modificador de Alchemy). Tecla G.",
      onChange: (v) => editor.setBrush({ gradient: v }),
    });
    this.controls.gradient = gradient as Control<never>;

    const pullFamily = select<PullFamily | "random">({
      label: "Familia",
      options: (Object.keys(PULL_LABELS) as (PullFamily | "random")[]).map((k) => ({
        value: k,
        label: PULL_LABELS[k],
      })),
      value: editor.pullFamily,
      onChange: (v) => editor.setPullFamily(v),
    });
    this.controls.pullFamily = pullFamily as Control<never>;
    this.pullGroup = el("div", { class: "ctrl-group" }, [
      pullFamily.el,
      fieldLabel("Arrastra para estirar una forma entre los dos puntos."),
    ]);

    this.sections.brush = section("Pincel", [
      mode.el,
      this.brushPreview,
      size.el,
      opacity.el,
      this.pullGroup,
      dynamics.el,
      this.dynamicsHint,
      minRatio.el,
      this.pressureGroup,
      this.velocityGroup,
      row([taperIn.el, taperOut.el]),
      jitter.el,
      el("div", { class: "ctrl-group" }, [splat.el, gradient.el]),
    ]);

    this.sections.stabilize = section("Respuesta del lapiz", [
      smoothing.el,
      streamline.el,
      fieldLabel(
        "El suavizado corrige el temblor y el estabilizador la direccion. Si notas la punta lenta, baja el estabilizador antes que el suavizado.",
      ),
    ]);

    // -------------------------------------------------------------- forma
    const shapeKind = segmented<ShapeKind>({
      options: (Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => ({
        value: k,
        label: SHAPE_LABELS[k],
      })),
      value: editor.doc.shape.kind,
      onChange: (v) => editor.setShape({ kind: v }),
    });
    this.controls.shapeKind = shapeKind as Control<never>;

    const shapeSize = slider({
      label: "Tamano",
      min: 4,
      max: 300,
      step: 1,
      gamma: 1.6,
      value: editor.doc.shape.size,
      unit: "px",
      onInput: (v) => editor.setShape({ size: v }),
    });
    this.controls.shapeSize = shapeSize as Control<never>;

    const shapeAspect = slider({
      label: "Proporcion",
      min: 0.25,
      max: 4,
      step: 0.05,
      decimals: 2,
      value: editor.doc.shape.aspect,
      onInput: (v) => editor.setShape({ aspect: v }),
    });
    this.controls.shapeAspect = shapeAspect as Control<never>;

    const shapeSides = slider({
      label: "Lados",
      min: 3,
      max: 12,
      step: 1,
      value: editor.doc.shape.sides,
      onInput: (v) => editor.setShape({ sides: v }),
    });
    this.controls.shapeSides = shapeSides as Control<never>;

    const shapeInner = slider({
      label: "Radio interior",
      min: 0.15,
      max: 0.9,
      step: 0.01,
      decimals: 2,
      value: editor.doc.shape.inner,
      onInput: (v) => editor.setShape({ inner: v }),
    });
    this.controls.shapeInner = shapeInner as Control<never>;

    const shapeRound = slider({
      label: "Redondeo",
      min: 0,
      max: 60,
      step: 0.5,
      decimals: 1,
      value: editor.doc.shape.round,
      unit: "px",
      onInput: (v) => editor.setShape({ round: v }),
    });
    this.controls.shapeRound = shapeRound as Control<never>;

    this.sections.shape = section("Forma", [
      shapeKind.el,
      shapeSize.el,
      shapeAspect.el,
      shapeSides.el,
      shapeInner.el,
      shapeRound.el,
      fieldLabel("Arrastra en el lienzo para colocarla y girarla antes de soltarla."),
    ]);

    // ----------------------------------------------------------- simetria
    const symMode = segmented<SymmetryMode>({
      options: (Object.keys(SYMMETRY_LABELS) as SymmetryMode[]).map((k) => ({
        value: k,
        label: SYMMETRY_LABELS[k],
      })),
      value: editor.doc.symmetry.mode,
      onChange: (v) => editor.setSymmetry({ mode: v }),
    });
    this.controls.symMode = symMode as Control<never>;

    const symCount = slider({
      label: "Sectores",
      min: 2,
      max: 64,
      step: 1,
      gamma: 1.4,
      value: editor.doc.symmetry.count,
      onInput: (v) => editor.setSymmetry({ count: Math.round(v) }),
    });
    this.controls.symCount = symCount as Control<never>;

    const symAngle = slider({
      label: "Angulo",
      min: -180,
      max: 180,
      step: 1,
      value: (editor.doc.symmetry.angle * 180) / Math.PI,
      unit: "deg",
      onInput: (v) => editor.setSymmetry({ angle: (v * Math.PI) / 180 }),
    });
    this.controls.symAngle = symAngle as Control<never>;

    const symVisible = toggle({
      label: "Mostrar guia",
      value: editor.doc.symmetry.visible,
      onChange: (v) => editor.setSymmetry({ visible: v }),
    });
    this.controls.symVisible = symVisible as Control<never>;

    const symLocked = toggle({
      label: "Bloquear",
      value: editor.doc.symmetry.locked,
      hint: "Evita mover el eje sin querer mientras dibujas.",
      onChange: (v) => editor.setSymmetry({ locked: v }),
    });
    this.controls.symLocked = symLocked as Control<never>;

    this.symmetryCount = fieldLabel("1 copia");

    this.sections.symmetry = section("Simetria", [
      symMode.el,
      symCount.el,
      symAngle.el,
      el("div", { class: "ctrl-group" }, [symVisible.el, symLocked.el]),
      row([
        button({
          label: "Centrar",
          title: "Lleva el eje al centro de la vista",
          onClick: () =>
            editor.setSymmetry({ x: editor.camera.x, y: editor.camera.y }),
        }).el,
        button({
          label: "Enderezar",
          title: "Pone el eje vertical",
          onClick: () => editor.setSymmetry({ angle: 0 }),
        }).el,
      ]),
      this.symmetryCount,
      fieldLabel("Con la herramienta de simetria (S) puedes arrastrar el eje a cualquier punto del lienzo."),
    ]);

    // ------------------------------------------------------------ fisica
    const gravityY = slider({
      label: "Gravedad",
      min: -2000,
      max: 2000,
      step: 10,
      value: editor.doc.physics.settings.gravity.y,
      onInput: (v) =>
        editor.setWorld({ gravity: { x: editor.doc.physics.settings.gravity.x, y: v } }),
    });
    this.controls.gravityY = gravityY as Control<never>;

    const gravityX = slider({
      label: "Gravedad lateral",
      min: -2000,
      max: 2000,
      step: 10,
      value: editor.doc.physics.settings.gravity.x,
      onInput: (v) =>
        editor.setWorld({ gravity: { x: v, y: editor.doc.physics.settings.gravity.y } }),
    });
    this.controls.gravityX = gravityX as Control<never>;

    const cohesion = slider({
      label: "Cohesion",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: editor.doc.physics.settings.cohesion,
      hint: "Atraccion mutua: las formas se buscan y se funden entre si.",
      onInput: (v) => editor.setWorld({ cohesion: v }),
    });
    this.controls.cohesion = cohesion as Control<never>;

    const damping = slider({
      label: "Rozamiento del aire",
      min: 0,
      max: 3,
      step: 0.01,
      decimals: 2,
      value: editor.doc.physics.settings.damping,
      onInput: (v) => editor.setWorld({ damping: v }),
    });
    this.controls.damping = damping as Control<never>;

    const restitution = slider({
      label: "Rebote",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: editor.doc.physics.settings.restitution,
      onInput: (v) => editor.setWorld({ restitution: v }),
    });
    this.controls.restitution = restitution as Control<never>;

    const friction = slider({
      label: "Friccion",
      min: 0,
      max: 1.5,
      step: 0.01,
      decimals: 2,
      value: editor.doc.physics.settings.friction,
      onInput: (v) => editor.setWorld({ friction: v }),
    });
    this.controls.friction = friction as Control<never>;

    const iterations = slider({
      label: "Precision",
      min: 1,
      max: 24,
      step: 1,
      value: editor.doc.physics.settings.iterations,
      hint: "Iteraciones del solver: mas alto agarra mejor las pilas, cuesta mas.",
      onInput: (v) => editor.setWorld({ iterations: Math.round(v) }),
    });
    this.controls.iterations = iterations as Control<never>;

    const timeScale = slider({
      label: "Velocidad del tiempo",
      min: 0.05,
      max: 3,
      step: 0.05,
      decimals: 2,
      value: editor.doc.physics.settings.timeScale,
      onInput: (v) => editor.setWorld({ timeScale: v }),
    });
    this.controls.timeScale = timeScale as Control<never>;

    const sleeping = toggle({
      label: "Dormir en reposo",
      value: editor.doc.physics.settings.sleeping,
      hint: "Los cuerpos quietos dejan de calcularse hasta que algo los toca.",
      onChange: (v) => editor.setWorld({ sleeping: v }),
    });
    this.controls.sleeping = sleeping as Control<never>;

    const walls = toggle({
      label: "Paredes",
      value: editor.showWalls,
      onChange: () => editor.toggleWalls(),
    });
    this.controls.walls = walls as Control<never>;

    const colliders = toggle({
      label: "Ver colisionadores",
      value: editor.debugColliders,
      hint: "Dibuja la forma real con la que choca cada cuerpo.",
      onChange: () => editor.toggleColliders(),
    });
    this.controls.colliders = colliders as Control<never>;

    this.sections.physics = section("Fisica", [
      gravityY.el,
      gravityX.el,
      cohesion.el,
      damping.el,
      row([restitution.el, friction.el]),
      iterations.el,
      timeScale.el,
      el("div", { class: "ctrl-group" }, [sleeping.el, walls.el, colliders.el]),
      row([
        button({ label: "Cero G", title: "Quita la gravedad", onClick: () => editor.setWorld({ gravity: { x: 0, y: 0 } }) }).el,
        button({ label: "Limpiar materia", variant: "danger", onClick: () => editor.clearMatter() }).el,
      ]),
    ]);

    // ------------------------------------------------------------- campo
    const blend = slider({
      label: "Fusion",
      min: 0,
      max: 160,
      step: 1,
      gamma: 1.5,
      value: editor.doc.field.blend,
      unit: "px",
      hint: "Radio de mezcla: a mas alto, las formas se funden antes de tocarse.",
      onInput: (v) => {
        editor.setField({ blend: v });
        editor.setWorld({ blend: v });
      },
    });
    this.controls.blend = blend as Control<never>;

    const outline = slider({
      label: "Contorno",
      min: 0,
      max: 12,
      step: 0.5,
      decimals: 1,
      value: editor.doc.field.outline,
      unit: "px",
      onInput: (v) => editor.setField({ outline: v }),
    });
    this.controls.outline = outline as Control<never>;

    const shade = slider({
      label: "Volumen",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: editor.doc.field.shade,
      onInput: (v) => editor.setField({ shade: v }),
    });
    this.controls.shade = shade as Control<never>;

    const gloss = slider({
      label: "Brillo",
      min: 0,
      max: 1.5,
      step: 0.01,
      decimals: 2,
      value: editor.doc.field.gloss,
      onInput: (v) => editor.setField({ gloss: v }),
    });
    this.controls.gloss = gloss as Control<never>;

    const depth = slider({
      label: "Profundidad",
      min: 4,
      max: 160,
      step: 1,
      gamma: 1.4,
      value: editor.doc.field.depth,
      unit: "px",
      hint: "Grosor aparente de la cupula de cada masa.",
      onInput: (v) => editor.setField({ depth: v }),
    });
    this.controls.depth = depth as Control<never>;

    const fieldAlpha = slider({
      label: "Opacidad",
      min: 0.05,
      max: 1,
      step: 0.01,
      decimals: 2,
      value: editor.doc.field.alpha,
      onInput: (v) => editor.setField({ alpha: v }),
    });
    this.controls.fieldAlpha = fieldAlpha as Control<never>;

    this.sections.field = section("Materia", [
      blend.el,
      outline.el,
      shade.el,
      gloss.el,
      depth.el,
      fieldAlpha.el,
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
    this.pages.shape = el("div", { class: "dock-page" }, [this.sections.shape]);
    this.pages.symmetry = el("div", { class: "dock-page" }, [this.sections.symmetry]);
    this.pages.matter = el("div", { class: "dock-page" }, [this.sections.field, this.sections.physics]);

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
    const content = el("div", { class: "dock-content" }, [head, scroll]);
    this.drawer = el("div", { class: "dock-drawer" }, [this.edge.el, content]);

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
      // Abrir o cambiar de categoría: intercambiar páginas normalmente.
      this.renderState();
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

    // ------ color
    this.colorPicker.set(state.color);
    this.recentSwatches.set({ colors: state.recentColors, value: state.color });
    this.paletteTabs.set(String(state.paletteIndex));
    this.paletteWells.set({ colors: state.palette.colors, value: state.color });

    // ------ pincel
    const b = state.brush;
    const usesPressure = b.dynamics === "pressure" || b.dynamics === "pressure-velocity";
    const usesVelocity = b.dynamics === "velocity" || b.dynamics === "pressure-velocity";

    (this.controls.mode as Control<BrushMode>).set(b.mode);
    (this.controls.dynamics as Control<StrokeDynamics>).set(b.dynamics);
    this.dynamicsHint.textContent = DYNAMICS_INFO[b.dynamics].hint;
    (this.controls.size as Control<number>).set(b.size);
    (this.controls.minRatio as Control<number>).set(b.minRatio);
    (this.controls.opacity as Control<number>).set(b.opacity);
    (this.controls.smoothing as Control<number>).set(b.smoothing);
    (this.controls.streamline as Control<number>).set(b.streamline);
    (this.controls.pressureCurve as Control<number>).set(b.pressureCurve);
    (this.controls.velocityScale as Control<number>).set(b.velocityScale);
    (this.controls.velocityInvert as Control<boolean>).set(b.velocityInvert);
    (this.controls.taperIn as Control<number>).set(b.taperIn);
    (this.controls.taperOut as Control<number>).set(b.taperOut);
    (this.controls.jitter as Control<number>).set(b.jitter);
    (this.controls.splat as Control<boolean>).set(b.splat);
    (this.controls.gradient as Control<boolean>).set(b.gradient);
    (this.controls.pullFamily as Control<PullFamily | "random">).set(state.pullFamily);

    setClass(this.pressureGroup, "is-dim", !usesPressure);
    setClass(this.velocityGroup, "is-dim", !usesVelocity);
    setClass(this.pullGroup, "is-hidden", b.mode !== "pull");

    // ------ forma
    const s = state.shape;
    (this.controls.shapeKind as Control<ShapeKind>).set(s.kind);
    (this.controls.shapeSize as Control<number>).set(s.size);
    (this.controls.shapeAspect as Control<number>).set(s.aspect);
    (this.controls.shapeSides as Control<number>).set(s.sides);
    (this.controls.shapeInner as Control<number>).set(s.inner);
    (this.controls.shapeRound as Control<number>).set(s.round);
    setClass(this.controls.shapeAspect.el, "is-hidden", s.kind !== "box" && s.kind !== "capsule");
    setClass(this.controls.shapeSides.el, "is-hidden", s.kind !== "ngon" && s.kind !== "star");
    setClass(this.controls.shapeInner.el, "is-hidden", s.kind !== "star");
    setClass(this.controls.shapeRound.el, "is-hidden", s.kind !== "box" && s.kind !== "ngon");

    // ------ simetria
    const sym = state.symmetry;
    (this.controls.symMode as Control<SymmetryMode>).set(sym.mode);
    (this.controls.symCount as Control<number>).set(sym.count);
    (this.controls.symAngle as Control<number>).set((sym.angle * 180) / Math.PI);
    (this.controls.symVisible as Control<boolean>).set(sym.visible);
    (this.controls.symLocked as Control<boolean>).set(sym.locked);
    const copies = symmetryCopies(sym);
    this.symmetryCount.textContent = copies === 1 ? "1 copia" : `${copies} copias por trazo`;
    setClass(this.controls.symCount.el, "is-hidden", sym.mode !== "radial" && sym.mode !== "kaleido");
    setClass(this.controls.symAngle.el, "is-hidden", sym.mode === "none");

    // ------ fisica
    const w = state.world;
    (this.controls.gravityY as Control<number>).set(w.gravity.y);
    (this.controls.gravityX as Control<number>).set(w.gravity.x);
    (this.controls.cohesion as Control<number>).set(w.cohesion);
    (this.controls.damping as Control<number>).set(w.damping);
    (this.controls.restitution as Control<number>).set(w.restitution);
    (this.controls.friction as Control<number>).set(w.friction);
    (this.controls.iterations as Control<number>).set(w.iterations);
    (this.controls.timeScale as Control<number>).set(w.timeScale);
    (this.controls.sleeping as Control<boolean>).set(w.sleeping);
    (this.controls.walls as Control<boolean>).set(state.showWalls);
    (this.controls.colliders as Control<boolean>).set(state.debugColliders);

    // ------ campo
    const f = state.field;
    (this.controls.blend as Control<number>).set(f.blend);
    (this.controls.outline as Control<number>).set(f.outline);
    (this.controls.shade as Control<number>).set(f.shade);
    (this.controls.gloss as Control<number>).set(f.gloss);
    (this.controls.depth as Control<number>).set(f.depth);
    (this.controls.fieldAlpha as Control<number>).set(f.alpha);

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
