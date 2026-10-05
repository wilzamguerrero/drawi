import type { Editor, EditorState, MatterOp } from "../../app/editor";
import { DEFAULT_PALETTES } from "../../core/color";
import { SHAPE_LABELS, type ShapeKind } from "../../physics/shapes";
import { DYNAMICS_INFO, ERASE_MODE_LABELS, type BrushMode, type EraseMode, type StrokeDynamics } from "../../stroke/types";
import { SYMMETRY_LABELS, type SymmetryMode } from "../../symmetry/symmetry";
import { PULL_LABELS, type PullFamily } from "../../tools/pull-shapes";
import type { BridgeStyle } from "../../render/field-gl";
import type { HotNode, MenuHooks } from "../hotbox/menu";

/**
 * Fuente única declarativa de la interfaz.
 *
 * Cada opción editable (rango, etiqueta, icono, ayuda, cómo se lee y se escribe
 * en el editor, cuándo se muestra) se declara UNA sola vez aquí. El dock lateral
 * y el menú radial son dos renderizadores de este mismo esquema: añadir o editar
 * una opción se hace en un único sitio y aparece en las dos superficies.
 *
 * Lo genuinamente propio de cada superficie —el selector HSV y la vista previa
 * del dock, la rueda y la activación de herramientas del radial— se expresa como
 * campos `custom` con "escotillas" (`renderDock`/`renderRadial`) o acotando el
 * campo a una superficie con `surfaces`.
 */

/** Valor fijo o derivado del estado (etiquetas, iconos, ayudas y acentos vivos). */
export type Dyn<T> = T | ((s: EditorState) => T);

/** Resuelve un valor `Dyn<T>` contra el estado actual. */
export function val<T>(v: Dyn<T>, s: EditorState): T {
  return typeof v === "function" ? (v as (s: EditorState) => T)(s) : v;
}

export type SurfaceId = "dock" | "radial";

export interface FieldBase {
  id: string;
  label: Dyn<string>;
  icon?: Dyn<string>;
  hint?: Dyn<string>;
  /** Color de acento del sector/control (muestras, categorías destacadas). */
  accent?: Dyn<string>;
  /** Cuándo el campo aplica. Por defecto: siempre. */
  visible?: (s: EditorState) => boolean;
  /** Radial SIEMPRE poda; el dock atenúa ("dim") u oculta ("prune"). */
  whenHidden?: "prune" | "dim";
  disabled?: (s: EditorState) => boolean;
  /** Superficies en las que aparece. Por defecto ambas. */
  surfaces?: SurfaceId[];
}
export interface NumberField extends FieldBase {
  kind: "number";
  min: number;
  max: number;
  step?: number;
  gamma?: number;
  unit?: string;
  decimals?: number;
  get: (s: EditorState) => number;
  set: (v: number) => void;
}

export interface ToggleField extends FieldBase {
  kind: "toggle";
  get: (s: EditorState) => boolean;
  set: (v: boolean) => void;
}

export interface ChoiceOption {
  value: string;
  /** Id del nodo/control generado (se preserva: `dyn-*`, `shape-*`, `sym-*`…). */
  id: string;
  label: string;
  icon?: string;
  accent?: string;
  title?: string;
}

export interface ChoiceField extends FieldBase {
  kind: "choice";
  /** Pista SOLO para el dock; el radial siempre usa un submenú de acciones. */
  chooser?: "segmented" | "select";
  options: ChoiceOption[];
  get: (s: EditorState) => string;
  set: (v: string) => void;
}

export interface ActionField extends FieldBase {
  kind: "action";
  run: () => void;
  /** No cerrar el radial tras ejecutar (toggles, ajustes rápidos). */
  keepOpen?: boolean;
  /** Estado "activo/encendido" (toggles y herramientas seleccionadas). */
  toggled?: (s: EditorState) => boolean;
  danger?: boolean;
}

export interface SwatchesField extends FieldBase {
  kind: "swatches";
  colors: (s: EditorState) => readonly string[];
  value: (s: EditorState) => string;
  onPick: (hex: string) => void;
}

export interface CustomField extends FieldBase {
  kind: "custom";
  renderDock?: (editor: Editor) => { el: HTMLElement; sync?: (s: EditorState) => void };
  renderRadial?: (s: EditorState) => HotNode | HotNode[] | null;
}

export type Field = NumberField | ToggleField | ChoiceField | ActionField | SwatchesField | CustomField;

export type Layout = "stack" | "row" | "inline" | "brush-by-mode";

/**
 * Configuración del pincel por modos: el radial la despliega como tres submenús
 * (Trazo/Relleno/Arrastre) que activan el modo y muestran sus opciones; el dock
 * la rinde como un control segmentado + las opciones planas.
 */
export interface BrushByMode {
  modes: { value: BrushMode; label: string; icon: string; title?: string }[];
  current: (s: EditorState) => BrushMode;
  isToolActive: (s: EditorState) => boolean;
  /** Radial: activa herramienta pincel + fija el modo. */
  activate: (m: BrushMode) => void;
  /** Dock: solo fija el modo. */
  select: (m: BrushMode) => void;
}

export interface Group {
  id: string;
  label?: Dyn<string>;
  icon?: Dyn<string>;
  hint?: Dyn<string>;
  accent?: Dyn<string>;
  visible?: (s: EditorState) => boolean;
  whenHidden?: "prune" | "dim";
  surfaces?: SurfaceId[];
  layout?: Layout;
  brushByMode?: BrushByMode;
  children: SchemaNode[];
}

export type SchemaNode = Field | Group;

/** Grupo de nivel superior: un submenú radial y una página/pestaña del dock. */
export interface Domain extends Group {
  icon: Dyn<string>;
}

/** Discrimina grupo de campo sin depender de `kind` (los grupos no lo llevan). */
export function isGroup(n: SchemaNode): n is Group {
  return (n as Group).children !== undefined;
}
const MODE_LABELS: Record<BrushMode, string> = {
  stroke: "Trazo",
  fill: "Relleno",
  pull: "Arrastre",
  erase: "Borrador",
};

const MODE_ICONS: Record<BrushMode, string> = {
  stroke: "brush",
  fill: "droplet",
  pull: "matter",
  erase: "eraser",
};

/** Numero de atajo de teclado por modo (Trazo 1 / Relleno 2 / Arrastre 3 / Borrador 4). */
const MODE_KEYS: Record<BrushMode, number> = { stroke: 1, fill: 2, pull: 3, erase: 4 };

const usesPressure = (d: StrokeDynamics): boolean => d === "pressure" || d === "pressure-velocity";
const usesVelocity = (d: StrokeDynamics): boolean => d === "velocity" || d === "pressure-velocity";

/**
 * Construye el esquema completo a partir del editor. Las lecturas (`get`,
 * `visible`, `toggled`…) se hacen sobre el `state` que cada superficie pasa al
 * renderizar; las escrituras van al editor. Las relecturas cruzadas (p. ej. la
 * otra componente de la gravedad) usan `editor.state` para tomar el valor vivo.
 */
export function buildSchema(editor: Editor, _state: EditorState, hooks: MenuHooks): Domain[] {
  // ------------------------------------------------------------- Pincel
  // Opciones comunes a los tres modos. El radial las clona bajo cada modo; el
  // dock las muestra una vez. "Familia" solo aplica en Arrastre (pull).
  const brushOptions: SchemaNode[] = [
    { kind: "number", id: "size", label: "Tamano", icon: "plus", min: 0.5, max: 400, step: 0.5, gamma: 2.2, unit: "px", decimals: 1, hint: "Diametro base ([ y ] lo cambian sin soltar el lapiz).", get: (s) => s.brush.size, set: (v) => editor.setBrush({ size: v }) },
    { kind: "number", id: "opacity", label: "Opacidad", icon: "droplet", min: 0.02, max: 1, step: 0.01, decimals: 2, get: (s) => s.brush.opacity, set: (v) => editor.setBrush({ opacity: v }) },
    // Vista previa del trazo: cromo propio del dock (el radial no la muestra).
    // El adaptador del dock la renderiza por id; aquí solo se declara su lugar.
    { kind: "custom", id: "brush-preview", label: "Vista previa", surfaces: ["dock"], visible: (s) => s.brush.mode !== "erase" },
    {
      kind: "choice",
      id: "dynamics",
      label: "Dinamica",
      icon: "tune",
      chooser: "select",
      visible: (s) => s.brush.mode !== "erase",
      hint: (s) => DYNAMICS_INFO[s.brush.dynamics].hint,
      options: (Object.keys(DYNAMICS_INFO) as StrokeDynamics[]).map((k) => ({ value: k, id: `dyn-${k}`, label: DYNAMICS_INFO[k].label })),
      get: (s) => s.brush.dynamics,
      set: (v) => editor.setBrush({ dynamics: v as StrokeDynamics }),
    },
    // Nota viva bajo el selector de dinámica (solo dock): su texto sigue al estado.
    { kind: "custom", id: "brush-dyn-hint", label: "Dinamica", surfaces: ["dock"], visible: (s) => s.brush.mode !== "erase" },
    {
      id: "response",
      label: "Respuesta",
      icon: "tune",
      hint: "Cómo el lápiz responde a presión y velocidad",
      visible: (s) => s.brush.mode !== "erase",
      children: [
        { kind: "number", id: "smoothing", label: "Suavizado", icon: "spark", min: 0, max: 1, step: 0.01, decimals: 2, hint: "Filtro One-Euro: quita el temblor sin anadir retraso a velocidad alta.", get: (s) => s.brush.smoothing, set: (v) => editor.setBrush({ smoothing: v }) },
        { kind: "number", id: "streamline", label: "Estabilizador", icon: "spark", min: 0, max: 0.95, step: 0.01, decimals: 2, hint: "La punta persigue al cursor. Alto da curvas limpias, pero se nota el arrastre.", get: (s) => s.brush.streamline, set: (v) => editor.setBrush({ streamline: v }) },
        { kind: "number", id: "min-ratio", label: "Ancho minimo", min: 0, max: 1, step: 0.01, decimals: 2, hint: "Fraccion del diametro a la que puede llegar la dinamica.", get: (s) => s.brush.minRatio, set: (v) => editor.setBrush({ minRatio: v }) },
        { kind: "number", id: "pressure-curve", label: "Curva de presion", min: -1, max: 1, step: 0.05, decimals: 2, hint: "Negativo: responde antes con poca fuerza. Positivo: exige apretar mas.", visible: (s) => usesPressure(s.brush.dynamics), whenHidden: "dim", get: (s) => s.brush.pressureCurve, set: (v) => editor.setBrush({ pressureCurve: v }) },
        { kind: "number", id: "velocity-scale", label: "Escala de velocidad", min: 0.2, max: 6, step: 0.05, decimals: 2, unit: "px/ms", hint: "Velocidad de referencia: por encima de ella el trazo llega a su extremo.", visible: (s) => usesVelocity(s.brush.dynamics), whenHidden: "dim", get: (s) => s.brush.velocityScale, set: (v) => editor.setBrush({ velocityScale: v }) },
        { kind: "toggle", id: "velocity-invert", label: "Rapido = grueso", icon: "spark", hint: "Apagado imita la tinta (rapido afina). Encendido imita el pincel seco.", visible: (s) => usesVelocity(s.brush.dynamics), whenHidden: "dim", get: (s) => s.brush.velocityInvert, set: (v) => editor.setBrush({ velocityInvert: v }) },
        { kind: "custom", id: "note-stabilize", label: "Nota", surfaces: ["dock"], hint: "El suavizado corrige el temblor y el estabilizador la direccion. Si notas la punta lenta, baja el estabilizador antes que el suavizado." },
      ],
    },
    {
      id: "profile",
      label: "Perfil",
      icon: "brush",
      hint: "Afilado de los extremos y textura del trazo",
      visible: (s) => s.brush.mode !== "erase",
      children: [
        { kind: "number", id: "taper-in", label: "Afilado inicial", min: 0, max: 0.5, step: 0.01, decimals: 2, get: (s) => s.brush.taperIn, set: (v) => editor.setBrush({ taperIn: v }) },
        { kind: "number", id: "taper-out", label: "Afilado final", min: 0, max: 0.5, step: 0.01, decimals: 2, get: (s) => s.brush.taperOut, set: (v) => editor.setBrush({ taperOut: v }) },
        { kind: "number", id: "jitter", label: "Temblor", min: 0, max: 1, step: 0.01, decimals: 2, hint: "Ruido de ancho: da textura de carboncillo.", get: (s) => s.brush.jitter, set: (v) => editor.setBrush({ jitter: v }) },
      ],
    },
    { kind: "toggle", id: "gradient", label: "Degradado", icon: "layers", hint: "Desvanece el trazo hacia abajo (modificador de Alchemy). Tecla G.", visible: (s) => s.brush.mode !== "erase", get: (s) => s.brush.gradient, set: (v) => editor.setBrush({ gradient: v }) },
    { kind: "toggle", id: "splat", label: "Splat", icon: "droplet", hint: "Contorno anguloso en vez de suave (modificador de Alchemy). Tecla P.", visible: (s) => s.brush.mode !== "erase", get: (s) => s.brush.splat, set: (v) => editor.setBrush({ splat: v }) },
    { kind: "toggle", id: "as-matter", label: "Hacer materia", icon: "matter", hint: "Convierte el trazo, relleno o arrastre en materia sin cambiar de modo del pincel. Tecla 5.", visible: (s) => s.brush.mode !== "erase", get: (s) => s.brush.asMatter, set: (v) => editor.setBrush({ asMatter: v }) },
    { kind: "toggle", id: "invert-erase", label: "Usar como borrador", icon: "eraser", hint: "Invierte el trazo, relleno o arrastre a borrado: el mismo gesto recorta la tinta. Tecla Alt.", visible: (s) => s.brush.mode !== "erase" && !s.brush.asMatter, get: (s) => s.brush.invertErase, set: (v) => editor.setBrush({ invertErase: v }) },
    // ---- Opciones exclusivas del Borrador (visibles solo en modo "erase"). ----
    {
      kind: "choice",
      id: "erase-mode",
      label: "Borrado",
      icon: "eraser",
      chooser: "segmented",
      hint: "Pincel recorta a mano; Forma usa la forma activa; Objeto borra el trazo tocado; Color borra todos los de ese color.",
      visible: (s) => s.brush.mode === "erase",
      options: (Object.keys(ERASE_MODE_LABELS) as EraseMode[]).map((k) => ({ value: k, id: `erase-${k}`, label: ERASE_MODE_LABELS[k] })),
      get: (s) => s.brush.eraseMode,
      set: (v) => editor.setBrush({ eraseMode: v as EraseMode }),
    },
    { kind: "toggle", id: "erase-fade", label: "Difuminar", icon: "spark", hint: "En vez de borrar del todo, aclara segun la opacidad (borrado suave).", visible: (s) => s.brush.mode === "erase", get: (s) => s.brush.eraseFade, set: (v) => editor.setBrush({ eraseFade: v }) },
    { kind: "toggle", id: "erase-matter", label: "Incluir materia", icon: "matter", hint: "El mismo gesto elimina tambien los cuerpos de materia que toque.", visible: (s) => s.brush.mode === "erase", get: (s) => s.brush.eraseMatter, set: (v) => editor.setBrush({ eraseMatter: v }) },
    {
      kind: "choice",
      id: "pull-family",
      label: "Familia",
      icon: "matter",
      chooser: "select",
      hint: "Arrastra para estirar una forma entre los dos puntos.",
      visible: (s) => s.brush.mode === "pull",
      options: (Object.keys(PULL_LABELS) as (PullFamily | "random")[]).map((k) => ({ value: k, id: `pull-${k}`, label: PULL_LABELS[k] })),
      get: (s) => s.pullFamily,
      set: (v) => editor.setPullFamily(v as PullFamily | "random"),
    },
  ];

  const brush: Domain = {
    id: "brush",
    label: "Pincel",
    icon: "brush",
    layout: "brush-by-mode",
    brushByMode: {
      modes: (["stroke", "fill", "pull", "erase"] as BrushMode[]).map((m) => ({ value: m, label: MODE_LABELS[m], icon: MODE_ICONS[m], title: `${MODE_LABELS[m]} (${MODE_KEYS[m]})` })),
      current: (s) => s.brush.mode,
      isToolActive: (s) => s.tool === "brush",
      activate: (m) => { editor.setTool("brush"); editor.setBrush({ mode: m }); },
      select: (m) => editor.setBrush({ mode: m }),
    },
    children: brushOptions,
  };
  // -------------------------------------------------------------- Color
  const color: Domain = {
    id: "color",
    label: "Color",
    icon: "droplet",
    accent: (s) => s.color,
    children: [
      // Selector HSV: exclusivo del dock. La rueda del radial cumple ese papel.
      {
        kind: "custom",
        id: "color-picker",
        label: "Color",
        surfaces: ["dock"],
        // renderDock se cablea en el adaptador del dock (necesita cruzar su
        // sincronía con las muestras); aquí solo se declara su lugar.
      },
      { kind: "action", id: "wheel", label: "Rueda", icon: "wheel", surfaces: ["radial"], run: () => hooks.toggleWheel() },
      { kind: "action", id: "tool-picker", label: "Cuentagotas", icon: "picker", surfaces: ["radial"], toggled: (s) => s.tool === "picker", run: () => editor.setTool("picker") },
      // Paletas fijas: submenú de paletas → colores en el radial; pestañas +
      // pozos en el dock. Elegir un color marca la paleta y aplica el color.
      {
        kind: "custom",
        id: "palette",
        label: "Paleta",
        icon: "palette",
        renderRadial: (s): HotNode => ({
          kind: "submenu",
          id: "palette",
          label: "Paleta",
          icon: "palette",
          children: DEFAULT_PALETTES.map((p, i) => ({
            kind: "submenu" as const,
            id: `palette-${i}`,
            label: p.name,
            active: s.paletteIndex === i,
            children: p.colors.map((hex, j) => ({
              kind: "action" as const,
              id: `palette-${i}-${j}`,
              label: hex.toUpperCase(),
              accent: hex,
              active: hex.toLowerCase() === s.color.toLowerCase(),
              keepOpen: true,
              run: () => { editor.setPalette(i); editor.setColor(hex); },
            })),
          })),
        }),
      },
      // Últimos colores usados: acciones sueltas en el radial; muestras en el dock.
      {
        kind: "custom",
        id: "recents",
        label: "Recientes",
        renderRadial: (s): HotNode[] => s.recentColors.map((hex, i) => ({
          kind: "action" as const,
          id: `swatch-${i}`,
          label: hex.toUpperCase(),
          accent: hex,
          active: hex.toLowerCase() === s.color.toLowerCase(),
          keepOpen: true,
          run: () => editor.setColor(hex),
        })),
      },
    ],
  };
  // ------------------------------------------------------------ Materia
  // Ajustes de la forma activa: solo entran los diales que esa forma usa de
  // verdad (poda por tipo). El submenú `shape-cfg` y esta poda los verifica
  // `scripts/smoke-ui.ts`, así que ids, etiquetas y criterio se conservan.
  const shapeCfg: Group = {
    id: "shape-cfg",
    label: "Forma",
    icon: "shape",
    children: [
      {
        kind: "choice",
        id: "shape-kind",
        label: "Tipo",
        chooser: "segmented",
        options: (Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => ({ value: k, id: `shape-${k}`, label: SHAPE_LABELS[k] })),
        get: (s) => s.shape.kind,
        set: (v) => editor.setShape({ kind: v as ShapeKind }),
      },
      { kind: "number", id: "shape-size", label: "Tamano", min: 4, max: 300, step: 1, gamma: 1.6, unit: "px", get: (s) => s.shape.size, set: (v) => editor.setShape({ size: v }) },
      { kind: "number", id: "shape-aspect", label: "Proporcion", min: 0.25, max: 4, step: 0.05, decimals: 2, visible: (s) => s.shape.kind === "box" || s.shape.kind === "capsule", get: (s) => s.shape.aspect, set: (v) => editor.setShape({ aspect: v }) },
      { kind: "number", id: "shape-sides", label: "Lados", min: 3, max: 12, step: 1, visible: (s) => s.shape.kind === "ngon" || s.shape.kind === "star", get: (s) => s.shape.sides, set: (v) => editor.setShape({ sides: Math.round(v) }) },
      { kind: "number", id: "shape-inner", label: "Radio interior", min: 0.15, max: 0.9, step: 0.01, decimals: 2, visible: (s) => s.shape.kind === "star", get: (s) => s.shape.inner, set: (v) => editor.setShape({ inner: v }) },
      { kind: "number", id: "shape-round", label: "Redondeo", min: 0, max: 60, step: 0.5, decimals: 1, unit: "px", visible: (s) => s.shape.kind === "box" || s.shape.kind === "ngon", get: (s) => s.shape.round, set: (v) => editor.setShape({ round: v }) },
      { kind: "custom", id: "note-shape", label: "Nota", surfaces: ["dock"], hint: "Arrastra en el lienzo para colocarla y girarla antes de soltarla." },
    ],
  };

  const physicsCfg: Group = {
    id: "physics-cfg",
    label: "Física",
    icon: "tune",
    children: [
      { kind: "action", id: "sim-toggle", label: (s) => (s.running ? "Pausar" : "Reanudar"), icon: (s) => (s.running ? "pause" : "play"), hint: (s) => (s.running ? "Pausar toda la simulación (física y puentes orgánicos)" : "Reanudar la simulación"), run: () => editor.setRunning(!editor.state.running), toggled: (s) => s.running },
      { kind: "number", id: "gravity", label: "Gravedad", min: -2000, max: 2000, step: 10, get: (s) => s.world.gravity.y, set: (v) => editor.setWorld({ gravity: { x: editor.state.world.gravity.x, y: v } }) },
      { kind: "number", id: "gravity-x", label: "Gravedad lateral", min: -2000, max: 2000, step: 10, get: (s) => s.world.gravity.x, set: (v) => editor.setWorld({ gravity: { x: v, y: editor.state.world.gravity.y } }) },
      { kind: "number", id: "cohesion", label: "Cohesion", min: 0, max: 1, step: 0.01, decimals: 2, hint: "Atraccion mutua: las formas se buscan y se funden entre si.", get: (s) => s.world.cohesion, set: (v) => editor.setWorld({ cohesion: v }) },
      { kind: "number", id: "cohesion-distance", label: "Alcance de conexion", min: 0, max: 600, step: 5, gamma: 1.5, unit: "px", hint: "Distancia maxima de la atraccion entre cuerpos. 0 = automatico segun sus radios.", get: (s) => s.world.cohesionDistance, set: (v) => editor.setWorld({ cohesionDistance: v }) },
      { kind: "number", id: "damping", label: "Rozamiento del aire", min: 0, max: 3, step: 0.01, decimals: 2, get: (s) => s.world.damping, set: (v) => editor.setWorld({ damping: v }) },
      { kind: "number", id: "restitution", label: "Rebote", min: 0, max: 1, step: 0.01, decimals: 2, get: (s) => s.world.restitution, set: (v) => editor.setWorld({ restitution: v }) },
      { kind: "number", id: "friction", label: "Friccion", min: 0, max: 1.5, step: 0.01, decimals: 2, get: (s) => s.world.friction, set: (v) => editor.setWorld({ friction: v }) },
      { kind: "number", id: "iterations", label: "Precision", min: 1, max: 24, step: 1, hint: "Iteraciones del solver: mas alto agarra mejor las pilas, cuesta mas.", get: (s) => s.world.iterations, set: (v) => editor.setWorld({ iterations: Math.round(v) }) },
      { kind: "number", id: "time-scale", label: "Velocidad del tiempo", min: 0.05, max: 3, step: 0.05, decimals: 2, get: (s) => s.world.timeScale, set: (v) => editor.setWorld({ timeScale: v }) },
      { kind: "toggle", id: "sleeping", label: "Dormir en reposo", icon: "spark", hint: "Los cuerpos quietos dejan de calcularse hasta que algo los toca.", get: (s) => s.world.sleeping, set: (v) => editor.setWorld({ sleeping: v }) },
      { kind: "toggle", id: "colliders", label: "Ver colisionadores", icon: "grid", hint: "Dibuja la forma real con la que choca cada cuerpo.", get: (s) => s.debugColliders, set: () => editor.toggleColliders() },
      { kind: "toggle", id: "bridge-reach-view", label: "Ver alcance de puentes", icon: "grid", hint: "Dibuja el radio hasta donde cada cuerpo tiende puentes (verde = propio, azul = global).", get: (s) => s.showBridgeReach, set: () => editor.toggleBridgeReach() },
      { kind: "action", id: "zero-g", label: "Cero G", icon: "spark", run: () => editor.setWorld({ gravity: { x: 0, y: 0 } }) },
    ],
  };

  const fieldCfg: Group = {
    id: "field-cfg",
    label: "Acabado",
    icon: "layers",
    children: [
      { kind: "number", id: "blend", label: "Fusion", min: 0, max: 160, step: 1, gamma: 1.5, unit: "px", hint: "Radio de mezcla: a mas alto, las formas se funden antes de tocarse.", get: (s) => s.field.blend, set: (v) => editor.setField({ blend: v }) },
      { kind: "number", id: "bridge-reach", label: "Puentes", min: 0, max: 600, step: 5, gamma: 1.5, unit: "px", hint: "Alcance global de los puentes entre formas. No atrae los cuerpos: solo tiende cuellos entre vecinos dentro de ese radio. Con la herramienta Puente (P) se ajusta cuerpo a cuerpo.", get: (s) => s.field.bridgeReach, set: (v) => editor.setField({ bridgeReach: v }) },
      { kind: "choice", id: "bridge-style", label: "Forma del puente", chooser: "segmented", hint: "Recto: cuello limpio. Desgarrado: puente discontinuo, como roto. Organico: ondula y se mueve.", options: [
        { value: "direct", id: "bridge-direct", label: "Recto" },
        { value: "torn", id: "bridge-torn", label: "Desgarrado" },
        { value: "organic", id: "bridge-organic", label: "Organico" },
      ], visible: (s) => s.field.bridgeReach > 0, get: (s) => s.field.bridgeStyle, set: (v) => editor.setField({ bridgeStyle: v as BridgeStyle }) },
      { kind: "number", id: "bridge-threads", label: "Hilos", min: 1, max: 6, step: 1, hint: "Talla cortes finos en la union, de modo que el puente se vea separado en hebras justo donde se conecta con cada cuerpo.", visible: (s) => s.field.bridgeReach > 0, get: (s) => s.field.bridgeThreads, set: (v) => editor.setField({ bridgeThreads: Math.round(v) }) },
      { kind: "number", id: "bridge-thread-reach", label: "Alcance hilos", min: 0.05, max: 1, step: 0.01, decimals: 2, hint: "Hasta donde llegan los cortes desde la conexion: bajo = solo al principio y se funden pronto hacia el centro; alto = casi todo el puente.", visible: (s) => s.field.bridgeReach > 0 && s.field.bridgeThreads > 1, get: (s) => s.field.bridgeThreadReach, set: (v) => editor.setField({ bridgeThreadReach: v }) },
      { kind: "number", id: "bridge-flare", label: "Conexion", min: 0, max: 1, step: 0.01, decimals: 2, hint: "Ensancha el puente donde se conecta con los cuerpos (entradas y salidas mas gruesas que el centro).", visible: (s) => s.field.bridgeReach > 0, get: (s) => s.field.bridgeFlare, set: (v) => editor.setField({ bridgeFlare: v }) },
      { kind: "toggle", id: "bridge-fade", label: "Difuminar por alcance", icon: "layers", hint: "Atenua la opacidad del puente hasta el borde del area de alcance: tenue de lejos, mas opaco al acercarse. Apagado = puentes solidos y completos.", visible: (s) => s.field.bridgeReach > 0, get: (s) => s.field.bridgeFade, set: () => editor.setField({ bridgeFade: !editor.state.field.bridgeFade }) },
      { kind: "number", id: "outline", label: "Contorno", min: 0, max: 12, step: 0.5, decimals: 1, unit: "px", get: (s) => s.field.outline, set: (v) => editor.setField({ outline: v }) },
      { kind: "number", id: "shade", label: "Volumen", min: 0, max: 1, step: 0.01, decimals: 2, get: (s) => s.field.shade, set: (v) => editor.setField({ shade: v }) },
      { kind: "number", id: "gloss", label: "Brillo", min: 0, max: 1.5, step: 0.01, decimals: 2, get: (s) => s.field.gloss, set: (v) => editor.setField({ gloss: v }) },
      { kind: "number", id: "depth", label: "Profundidad", min: 4, max: 160, step: 1, gamma: 1.4, unit: "px", hint: "Grosor aparente de la cupula de cada masa.", get: (s) => s.field.depth, set: (v) => editor.setField({ depth: v }) },
      { kind: "number", id: "field-alpha", label: "Opacidad", min: 0.05, max: 1, step: 0.01, decimals: 2, get: (s) => s.field.alpha, set: (v) => editor.setField({ alpha: v }) },
    ],
  };

  const matter: Domain = {
    id: "matter-cfg",
    label: "Materia",
    icon: "matter",
    children: [
      { kind: "action", id: "tool-shape", label: "Crear", icon: "shape", surfaces: ["radial"], toggled: (s) => s.tool === "shape", run: () => editor.setTool("shape") },
      { kind: "action", id: "tool-matter", label: "Mover", icon: "matter", surfaces: ["radial"], toggled: (s) => s.tool === "matter", run: () => editor.setTool("matter") },
      {
        kind: "choice",
        id: "matter-op",
        label: "Transformar",
        icon: "move",
        chooser: "segmented",
        hint: "Mover: arrastra el cuerpo o el trazo entero. Rotar: gira alrededor del pivote. Escalar: aleja o acerca al pivote. Pivote: coloca a mano el punto de giro/escala; se mantiene coherente al transformar y con la física.",
        visible: (s) => s.tool === "matter",
        options: [
          { value: "move", id: "matter-op-move", label: "Mover" },
          { value: "rotate", id: "matter-op-rotate", label: "Rotar" },
          { value: "scale", id: "matter-op-scale", label: "Escalar" },
          { value: "pivot", id: "matter-op-pivot", label: "Pivote" },
        ],
        get: (s) => s.matterOp,
        set: (v) => editor.setMatterOp(v as MatterOp),
      },
      { kind: "action", id: "tool-bridge", label: "Puente", icon: "layers", surfaces: ["radial"], toggled: (s) => s.tool === "bridge", run: () => editor.setTool("bridge") },
      { kind: "action", id: "run", label: (s) => (s.running ? "Pausar" : "Reanudar"), icon: (s) => (s.running ? "pause" : "play"), surfaces: ["radial"], keepOpen: true, toggled: (s) => s.running, run: () => editor.setRunning(!editor.state.running) },
      { kind: "action", id: "seed", label: "Sembrar", icon: "seed", surfaces: ["radial"], run: () => editor.seedMatter(8) },
      { kind: "action", id: "bake", label: "Hornear", icon: "bake", surfaces: ["radial"], run: () => editor.bakeMatter() },
      { kind: "action", id: "ink-to-matter", label: "Tinta a materia", icon: "matter", disabled: (s) => {
        const layer = s.layers.find((l) => l.id === s.activeLayerId);
        return layer?.kind !== "ink" || !editor.doc.layerItems(s.activeLayerId).some((item) => !item.erase);
      }, run: () => editor.convertInkToMatter() },
      shapeCfg,
      physicsCfg,
      fieldCfg,
      // La conversión se activa directamente desde el modo Materia del pincel.
      { kind: "toggle", id: "walls", label: "Paredes", icon: "grid", get: (s) => s.showWalls, set: () => editor.toggleWalls() },
      { kind: "action", id: "clear-matter", label: "Vaciar", icon: "trash", accent: "#ff5f6d", danger: true, run: () => editor.clearMatter() },
    ],
  };
  // ------------------------------------------------------------ Archivo
  const file: Domain = {
    id: "file",
    label: "Archivo",
    icon: "file",
    surfaces: ["radial"],
    children: [
      { kind: "action", id: "undo", label: "Deshacer", icon: "undo", disabled: (s) => !s.history.canUndo, run: () => editor.undo() },
      { kind: "action", id: "redo", label: "Rehacer", icon: "redo", disabled: (s) => !s.history.canRedo, run: () => editor.redo() },
      { kind: "action", id: "new", label: "Nuevo", icon: "trash", run: () => hooks.newDoc() },
      { kind: "action", id: "open", label: "Abrir", icon: "folder", run: () => hooks.openFile() },
      { kind: "action", id: "import", label: "Importar imagen", icon: "image", hint: "Importa JPG, PNG, WebP o PSD por capas. También puedes arrastrar o pegar (Ctrl+V).", run: () => hooks.importImage() },
      { kind: "action", id: "save", label: "Guardar", icon: "save", run: () => hooks.save() },
      { kind: "action", id: "png", label: "PNG", icon: "download", run: () => hooks.exportPng() },
      { kind: "action", id: "svg", label: "SVG", icon: "download", run: () => hooks.exportSvg() },
      { kind: "action", id: "help", label: "Atajos", icon: "info", run: () => hooks.help() },
    ],
  };

  // ----------------------------------------------------------- Simetria
  const symmetry: Domain = {
    id: "symmetry",
    label: "Simetria",
    icon: "symmetry",
    children: [
      { kind: "action", id: "tool-symmetry", label: "Mover eje", icon: "symmetry", surfaces: ["radial"], toggled: (s) => s.tool === "symmetry", run: () => editor.setTool("symmetry") },
      {
        kind: "choice",
        id: "sym-mode",
        label: "Modo",
        chooser: "segmented",
        options: (Object.keys(SYMMETRY_LABELS) as SymmetryMode[]).map((k) => ({ value: k, id: `sym-${k}`, label: SYMMETRY_LABELS[k] })),
        get: (s) => s.symmetry.mode,
        set: (v) => editor.setSymmetry({ mode: v as SymmetryMode }),
      },
      { kind: "number", id: "sym-count", label: "Sectores", min: 2, max: 64, step: 1, gamma: 1.4, visible: (s) => s.symmetry.mode === "radial" || s.symmetry.mode === "kaleido", get: (s) => s.symmetry.count, set: (v) => editor.setSymmetry({ count: Math.round(v) }) },
      { kind: "number", id: "sym-angle", label: "Angulo", min: -180, max: 180, step: 1, unit: "deg", visible: (s) => s.symmetry.mode !== "none", get: (s) => (s.symmetry.angle * 180) / Math.PI, set: (v) => editor.setSymmetry({ angle: (v * Math.PI) / 180 }) },
      { kind: "action", id: "sym-center", label: "Centrar", run: () => editor.setSymmetry({ x: editor.camera.x, y: editor.camera.y }) },
      { kind: "action", id: "sym-straighten", label: "Enderezar", run: () => editor.setSymmetry({ angle: 0 }) },
      { kind: "toggle", id: "sym-visible", label: "Guia", get: (s) => s.symmetry.visible, set: (v) => editor.setSymmetry({ visible: v }) },
      { kind: "toggle", id: "sym-locked", label: "Bloquear", hint: "Evita mover el eje sin querer mientras dibujas.", get: (s) => s.symmetry.locked, set: (v) => editor.setSymmetry({ locked: v }) },
      { kind: "custom", id: "sym-copies", label: "Copias", surfaces: ["dock"] },
      { kind: "custom", id: "note-symmetry", label: "Nota", surfaces: ["dock"], hint: "Con la herramienta de simetria (S) puedes arrastrar el eje a cualquier punto del lienzo." },
    ],
  };

  // ----------------------------------------------------------- Explorar
  const view: Domain = {
    id: "view",
    label: "Explorar",
    icon: "compass",
    surfaces: ["radial"],
    children: [
      { kind: "action", id: "zoom-in", label: "Acercar", icon: "zoomIn", keepOpen: true, run: () => editor.zoomBy(1.25) },
      { kind: "action", id: "zoom-out", label: "Alejar", icon: "zoomOut", keepOpen: true, run: () => editor.zoomBy(1 / 1.25) },
      { kind: "action", id: "fit", label: "Encajar", icon: "fit", run: () => editor.fitView() },
      { kind: "action", id: "reset-view", label: "Reiniciar", icon: "grid", run: () => editor.resetView() },
      { kind: "action", id: "tool-hand", label: "Mano", icon: "hand", surfaces: ["radial"], toggled: (s) => s.tool === "hand", run: () => editor.setTool("hand") },
    ],
  };

  // ------------------------------------------------------------- Capas
  // Panel de capas estilo Photoshop: solo dock. Es un único campo `custom` cuyo
  // adaptador (que monta `LayersPanel`) se cablea en `buildCustoms` del dock;
  // aquí solo se declara su lugar, como con el selector de color.
  const layers: Domain = {
    id: "layers",
    label: "Capas",
    icon: "layers",
    surfaces: ["dock"],
    children: [
      { kind: "custom", id: "layers-panel", label: "Capas", surfaces: ["dock"] },
    ],
  };

  // Orden de la raíz = orden del radial (Archivo arriba, luego en el sentido del
  // reloj). El dock elige su subconjunto y disposición desde estos mismos datos.
  return [file, brush, color, layers, matter, symmetry, view];
}
