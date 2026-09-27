import type { Editor, EditorState } from "../../app/editor";
import { DEFAULT_PALETTES } from "../../core/color";
import { SHAPE_LABELS, type ShapeKind } from "../../physics/shapes";
import { DYNAMICS_INFO, type BrushMode, type StrokeDynamics } from "../../stroke/types";
import { SYMMETRY_LABELS, type SymmetryMode } from "../../symmetry/symmetry";
import { PULL_LABELS, type PullFamily } from "../../tools/pull-shapes";

/**
 * Modelo declarativo del hotbox.
 *
 * El menu radial no se dibuja a mano: se describe como un arbol de nodos y el
 * motor (hotbox.ts) lo despliega en sectores concentricos. Anadir una opcion es
 * anadir un objeto a este arbol; nunca se toca el render ni la interaccion.
 *
 * Lo que abre un panel (color, rueda, archivo...) no vive aqui: son acciones que
 * llaman a `hooks`, y es la app quien decide como presentarlo (panel flotante
 * con pin, dialogo, etc.). Asi el menu solo declara intencion y el sistema de
 * paneles queda desacoplado y ampliable.
 */

interface NodeBase {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  /** Color de acento del sector (muestras de color, categorias destacadas). */
  accent?: string;
  active?: boolean;
  disabled?: boolean;
}

export interface ActionNode extends NodeBase {
  kind: "action";
  run: () => void;
  /** No cerrar el hotbox tras ejecutar (toggles, ajustes rapidos). */
  keepOpen?: boolean;
  /** Permite abrir este item como panel flotante con pin. */
  canFloat?: boolean;
  /** Función para construir el contenido del panel flotante. */
  buildPanel?: (host: HTMLElement) => (() => void) | void;
}

export interface SubmenuNode extends NodeBase {
  kind: "submenu";
  children: HotNode[];
  /**
   * Efecto al SELECCIONAR (tap) el submenú, además de expandirlo. Sirve para
   * grupos que también son una elección: p. ej. cada modo de pincel activa ese
   * modo (y la herramienta) al tocarlo, y al expandirse muestra sus opciones.
   * Se dispara en el pointerup (como las acciones), no al pasar el cursor.
   */
  onSelect?: () => void;
}

export interface DialNode extends NodeBase {
  kind: "dial";
  min: number;
  max: number;
  step?: number;
  gamma?: number;
  unit?: string;
  value: number;
  onInput: (v: number) => void;
}

export type HotNode = ActionNode | SubmenuNode | DialNode;

/** Puertos de alto nivel que la app implementa; el menu solo los invoca. */
export interface MenuHooks {
  toggleWheel(): void;
  help(): void;
  newDoc(): void;
  openFile(): void;
  save(): void;
  exportPng(): void;
  exportSvg(): void;
}

const MODE_LABELS: Record<BrushMode, string> = {
  stroke: "Trazo",
  fill: "Relleno",
  pull: "Arrastre",
};

const MODE_ICONS: Record<BrushMode, string> = {
  stroke: "brush",
  fill: "droplet",
  pull: "matter",
};

// ------------------------------------------------------------ pincel por modos

/**
 * Opciones de un modo de pincel, iguales a las que el dock muestra según el modo
 * activo. Tamaño/opacidad/dinámica/respuesta/perfil/degradado/splat son comunes a
 * los tres modos; solo "Arrastre" (pull) añade la Familia de formas —igual que en
 * el dock, donde el grupo Familia solo aparece en modo Arrastre—.
 */
function brushOptions(editor: Editor, state: EditorState, forMode: BrushMode): HotNode[] {
  const b = state.brush;

  // La misma condición que atenúa (is-dim) los grupos de presión/velocidad en el
  // dock. Aquí, en vez de atenuar, podamos: la dinámica activa decide qué diales
  // entran, para no ofrecer ajustes inertes (mismo criterio que shapeConfigNode).
  const usesPressure = b.dynamics === "pressure" || b.dynamics === "pressure-velocity";
  const usesVelocity = b.dynamics === "velocity" || b.dynamics === "pressure-velocity";

  // "Respuesta del lápiz": cómo el filtro y la dinámica moldean el ancho. Reúne lo
  // que el dock reparte entre la sección "Respuesta del lapiz" (suavizado,
  // estabilizador) y los grupos de ancho mínimo / presión / velocidad.
  const responseChildren: HotNode[] = [
    { kind: "dial", id: "smoothing", label: "Suavizado", icon: "spark", min: 0, max: 1, step: 0.01, value: b.smoothing, onInput: (v) => editor.setBrush({ smoothing: v }) },
    { kind: "dial", id: "streamline", label: "Estabilizador", icon: "spark", min: 0, max: 0.95, step: 0.01, value: b.streamline, onInput: (v) => editor.setBrush({ streamline: v }) },
    { kind: "dial", id: "min-ratio", label: "Ancho minimo", min: 0, max: 1, step: 0.01, value: b.minRatio, onInput: (v) => editor.setBrush({ minRatio: v }) },
  ];
  if (usesPressure) {
    responseChildren.push({ kind: "dial", id: "pressure-curve", label: "Curva de presion", min: -1, max: 1, step: 0.05, value: b.pressureCurve, onInput: (v) => editor.setBrush({ pressureCurve: v }) });
  }
  if (usesVelocity) {
    responseChildren.push(
      { kind: "dial", id: "velocity-scale", label: "Escala velocidad", min: 0.2, max: 6, step: 0.05, unit: "px/ms", value: b.velocityScale, onInput: (v) => editor.setBrush({ velocityScale: v }) },
      { kind: "action", id: "velocity-invert", label: "Rapido = grueso", icon: "spark", active: b.velocityInvert, keepOpen: true, run: () => editor.setBrush({ velocityInvert: !b.velocityInvert }) },
    );
  }

  const opts: HotNode[] = [
    { kind: "dial", id: "size", label: "Tamano", icon: "plus", min: 0.5, max: 400, step: 0.5, gamma: 2.2, unit: "px", value: b.size, onInput: (v) => editor.setBrush({ size: v }) },
    { kind: "dial", id: "opacity", label: "Opacidad", icon: "droplet", min: 0.02, max: 1, step: 0.01, value: b.opacity, onInput: (v) => editor.setBrush({ opacity: v }) },
    {
      kind: "submenu",
      id: "dynamics",
      label: "Dinamica",
      icon: "tune",
      hint: DYNAMICS_INFO[b.dynamics].hint,
      children: (Object.keys(DYNAMICS_INFO) as StrokeDynamics[]).map((k) => ({
        kind: "action" as const,
        id: `dyn-${k}`,
        label: DYNAMICS_INFO[k].label,
        active: b.dynamics === k,
        run: () => editor.setBrush({ dynamics: k }),
      })),
    },
    { kind: "submenu", id: "response", label: "Respuesta", icon: "tune", hint: "Cómo el lápiz responde a presión y velocidad", children: responseChildren },
    {
      kind: "submenu",
      id: "profile",
      label: "Perfil",
      icon: "brush",
      hint: "Afilado de los extremos y textura del trazo",
      children: [
        { kind: "dial", id: "taper-in", label: "Afilado inicial", min: 0, max: 0.5, step: 0.01, value: b.taperIn, onInput: (v) => editor.setBrush({ taperIn: v }) },
        { kind: "dial", id: "taper-out", label: "Afilado final", min: 0, max: 0.5, step: 0.01, value: b.taperOut, onInput: (v) => editor.setBrush({ taperOut: v }) },
        { kind: "dial", id: "jitter", label: "Temblor", min: 0, max: 1, step: 0.01, value: b.jitter, onInput: (v) => editor.setBrush({ jitter: v }) },
      ],
    },
    { kind: "action", id: "gradient", label: "Degradado", icon: "layers", active: b.gradient, keepOpen: true, run: () => editor.setBrush({ gradient: !b.gradient }) },
    { kind: "action", id: "splat", label: "Splat", icon: "droplet", active: b.splat, keepOpen: true, run: () => editor.setBrush({ splat: !b.splat }) },
  ];

  // Solo Arrastre añade la Familia de formas, igual que el dock oculta el grupo
  // Familia salvo en modo Arrastre.
  if (forMode === "pull") {
    opts.push({
      kind: "submenu",
      id: "pull-family",
      label: "Familia",
      icon: "matter",
      children: (Object.keys(PULL_LABELS) as (PullFamily | "random")[]).map((k) => ({
        kind: "action" as const,
        id: `pull-${k}`,
        label: PULL_LABELS[k],
        active: state.pullFamily === k,
        run: () => editor.setPullFamily(k),
      })),
    });
  }
  return opts;
}

/**
 * Pincel: primero los 3 modos (Trazo/Relleno/Arrastre) como en el dock. Cada modo
 * es un submenú que, al TOCARLO, activa la herramienta pincel y ese modo (onSelect)
 * y, al expandirse, muestra las opciones de ese modo. Así "al seleccionar alguno ya
 * puedes usarlo, pero dentro de cada uno con las opciones que tenga".
 */
function brushSubmenu(editor: Editor, state: EditorState): SubmenuNode {
  const b = state.brush;
  const modeNode = (m: BrushMode): SubmenuNode => ({
    kind: "submenu",
    id: `mode-${m}`,
    label: MODE_LABELS[m],
    icon: MODE_ICONS[m],
    active: state.tool === "brush" && b.mode === m,
    onSelect: () => {
      editor.setTool("brush");
      editor.setBrush({ mode: m });
    },
    children: brushOptions(editor, state, m),
  });
  return {
    kind: "submenu",
    id: "brush",
    label: "Pincel",
    icon: "brush",
    children: [modeNode("stroke"), modeNode("fill"), modeNode("pull")],
  };
}

/**
 * Nodo "Forma": solo aparecen los ajustes que la pieza activa usa de verdad.
 * "Redondeo" no hace nada en una estrella ni "Lados" en una caja, asi que el
 * arbol se poda por tipo de forma para no ofrecer diales inertes. Vive dentro
 * del grupo Materia (crear formas), no como herramienta suelta.
 */
function shapeConfigNode(editor: Editor, state: EditorState): SubmenuNode {
  const s = state.shape;
  const children: HotNode[] = [
    {
      kind: "submenu",
      id: "shape-kind",
      label: "Tipo",
      children: (Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => ({
        kind: "action" as const,
        id: `shape-${k}`,
        label: SHAPE_LABELS[k],
        active: s.kind === k,
        run: () => editor.setShape({ kind: k }),
      })),
    },
    { kind: "dial", id: "shape-size", label: "Tamano", min: 4, max: 300, step: 1, gamma: 1.6, unit: "px", value: s.size, onInput: (v) => editor.setShape({ size: v }) },
  ];
  if (s.kind === "box" || s.kind === "capsule") {
    children.push({ kind: "dial", id: "shape-aspect", label: "Proporcion", min: 0.25, max: 4, step: 0.05, value: s.aspect, onInput: (v) => editor.setShape({ aspect: v }) });
  }
  if (s.kind === "ngon" || s.kind === "star") {
    children.push({ kind: "dial", id: "shape-sides", label: "Lados", min: 3, max: 12, step: 1, value: s.sides, onInput: (v) => editor.setShape({ sides: Math.round(v) }) });
  }
  if (s.kind === "star") {
    children.push({ kind: "dial", id: "shape-inner", label: "Radio interior", min: 0.15, max: 0.9, step: 0.01, value: s.inner, onInput: (v) => editor.setShape({ inner: v }) });
  }
  if (s.kind === "box" || s.kind === "ngon") {
    children.push({ kind: "dial", id: "shape-round", label: "Redondeo", min: 0, max: 60, step: 0.5, unit: "px", value: s.round, onInput: (v) => editor.setShape({ round: v }) });
  }
  return { kind: "submenu", id: "shape-cfg", label: "Forma", icon: "shape", children };
}

/** Nodo "Física": el mundo completo (gravedad, roces, solver, reposo). */
function physicsConfigNode(editor: Editor, state: EditorState): SubmenuNode {
  const w = state.world;
  return {
    kind: "submenu",
    id: "physics-cfg",
    label: "Física",
    icon: "tune",
    children: [
      { kind: "dial", id: "gravity", label: "Gravedad", min: -2000, max: 2000, step: 10, value: w.gravity.y, onInput: (v) => editor.setWorld({ gravity: { x: editor.state.world.gravity.x, y: v } }) },
      { kind: "dial", id: "gravity-x", label: "Gravedad lateral", min: -2000, max: 2000, step: 10, value: w.gravity.x, onInput: (v) => editor.setWorld({ gravity: { x: v, y: editor.state.world.gravity.y } }) },
      { kind: "dial", id: "cohesion", label: "Cohesion", min: 0, max: 1, step: 0.01, value: w.cohesion, onInput: (v) => editor.setWorld({ cohesion: v }) },
      { kind: "dial", id: "damping", label: "Rozamiento", min: 0, max: 3, step: 0.01, value: w.damping, onInput: (v) => editor.setWorld({ damping: v }) },
      { kind: "dial", id: "restitution", label: "Rebote", min: 0, max: 1, step: 0.01, value: w.restitution, onInput: (v) => editor.setWorld({ restitution: v }) },
      { kind: "dial", id: "friction", label: "Friccion", min: 0, max: 1.5, step: 0.01, value: w.friction, onInput: (v) => editor.setWorld({ friction: v }) },
      { kind: "dial", id: "iterations", label: "Precision", min: 1, max: 24, step: 1, value: w.iterations, onInput: (v) => editor.setWorld({ iterations: Math.round(v) }) },
      { kind: "dial", id: "time-scale", label: "Velocidad tiempo", min: 0.05, max: 3, step: 0.05, value: w.timeScale, onInput: (v) => editor.setWorld({ timeScale: v }) },
      { kind: "action", id: "sleeping", label: "Dormir", icon: "spark", active: w.sleeping, keepOpen: true, run: () => editor.setWorld({ sleeping: !editor.state.world.sleeping }) },
      { kind: "action", id: "colliders", label: "Colisionadores", icon: "grid", active: state.debugColliders, keepOpen: true, run: () => editor.toggleColliders() },
      { kind: "action", id: "zero-g", label: "Cero G", icon: "spark", run: () => editor.setWorld({ gravity: { x: 0, y: 0 } }) },
    ],
  };
}

/** Nodo "Acabado": el estilo con el que se pinta la materia fundida. */
function fieldConfigNode(editor: Editor, state: EditorState): SubmenuNode {
  const f = state.field;
  return {
    kind: "submenu",
    id: "field-cfg",
    label: "Acabado",
    icon: "layers",
    children: [
      { kind: "dial", id: "blend", label: "Fusion", min: 0, max: 160, step: 1, gamma: 1.5, unit: "px", value: f.blend, onInput: (v) => { editor.setField({ blend: v }); editor.setWorld({ blend: v }); } },
      { kind: "dial", id: "outline", label: "Contorno", min: 0, max: 12, step: 0.5, unit: "px", value: f.outline, onInput: (v) => editor.setField({ outline: v }) },
      { kind: "dial", id: "shade", label: "Volumen", min: 0, max: 1, step: 0.01, value: f.shade, onInput: (v) => editor.setField({ shade: v }) },
      { kind: "dial", id: "gloss", label: "Brillo", min: 0, max: 1.5, step: 0.01, value: f.gloss, onInput: (v) => editor.setField({ gloss: v }) },
      { kind: "dial", id: "depth", label: "Profundidad", min: 4, max: 160, step: 1, gamma: 1.4, unit: "px", value: f.depth, onInput: (v) => editor.setField({ depth: v }) },
      { kind: "dial", id: "field-alpha", label: "Opacidad", min: 0.05, max: 1, step: 0.01, value: f.alpha, onInput: (v) => editor.setField({ alpha: v }) },
    ],
  };
}

function symmetrySubmenu(editor: Editor, state: EditorState): SubmenuNode {
  const sym = state.symmetry;
  return {
    kind: "submenu",
    id: "symmetry",
    label: "Simetria",
    icon: "symmetry",
    children: [
      // Activa la herramienta de simetría (mover el eje en el lienzo). Antes
      // vivía en "Dibujar"; ahora está donde se controla la simetría.
      {
        kind: "action",
        id: "tool-symmetry",
        label: "Mover eje",
        icon: "symmetry",
        active: state.tool === "symmetry",
        run: () => editor.setTool("symmetry"),
      },
      {
        kind: "submenu",
        id: "sym-mode",
        label: "Modo",
        children: (Object.keys(SYMMETRY_LABELS) as SymmetryMode[]).map((k) => ({
          kind: "action" as const,
          id: `sym-${k}`,
          label: SYMMETRY_LABELS[k],
          active: sym.mode === k,
          run: () => editor.setSymmetry({ mode: k }),
        })),
      },
      { kind: "dial", id: "sym-count", label: "Sectores", min: 2, max: 64, step: 1, gamma: 1.4, value: sym.count, onInput: (v) => editor.setSymmetry({ count: Math.round(v) }) },
      { kind: "dial", id: "sym-angle", label: "Angulo", min: -180, max: 180, step: 1, unit: "deg", value: (sym.angle * 180) / Math.PI, onInput: (v) => editor.setSymmetry({ angle: (v * Math.PI) / 180 }) },
      { kind: "action", id: "sym-center", label: "Centrar", run: () => editor.setSymmetry({ x: editor.camera.x, y: editor.camera.y }) },
      { kind: "action", id: "sym-straighten", label: "Enderezar", run: () => editor.setSymmetry({ angle: 0 }) },
      { kind: "action", id: "sym-visible", label: "Guia", active: sym.visible, keepOpen: true, run: () => editor.setSymmetry({ visible: !sym.visible }) },
      { kind: "action", id: "sym-locked", label: "Bloquear", active: sym.locked, keepOpen: true, run: () => editor.setSymmetry({ locked: !sym.locked }) },
    ],
  };
}

/**
 * Grupo unificado "Materia": reúne crear formas y moverlas como materia física.
 * Antes eran dos herramientas sueltas (Forma y Materia); ahora es un solo lugar
 * con dos botones —Crear y Mover— y, debajo, todo lo que faltaba: play/pausa,
 * sembrar, hornear, y los ajustes de forma, física y acabado en subgrupos.
 */
function matterSubmenu(editor: Editor, state: EditorState): SubmenuNode {
  return {
    kind: "submenu",
    id: "matter-cfg",
    label: "Materia",
    icon: "matter",
    children: [
      // Los dos modos de la materia: crear piezas o moverlas.
      { kind: "action", id: "tool-shape", label: "Crear", icon: "shape", active: state.tool === "shape", run: () => editor.setTool("shape") },
      { kind: "action", id: "tool-matter", label: "Mover", icon: "matter", active: state.tool === "matter", run: () => editor.setTool("matter") },
      // Controles de simulación.
      { kind: "action", id: "run", label: state.running ? "Pausar" : "Reanudar", icon: state.running ? "pause" : "play", active: state.running, keepOpen: true, run: () => editor.setRunning(!state.running) },
      { kind: "action", id: "seed", label: "Sembrar", icon: "seed", run: () => editor.seedMatter(8) },
      { kind: "action", id: "bake", label: "Hornear", icon: "bake", run: () => editor.bakeMatter() },
      // Ajustes agrupados: forma de las piezas, física del mundo y acabado.
      shapeConfigNode(editor, state),
      physicsConfigNode(editor, state),
      fieldConfigNode(editor, state),
      { kind: "action", id: "walls", label: "Paredes", icon: "grid", active: state.showWalls, keepOpen: true, run: () => editor.toggleWalls() },
      { kind: "action", id: "clear-matter", label: "Vaciar", icon: "trash", accent: "#ff5f6d", run: () => editor.clearMatter() },
    ],
  };
}

function viewSubmenu(editor: Editor, state: EditorState): SubmenuNode {
  return {
    kind: "submenu",
    id: "view",
    label: "Explorar",
    icon: "compass",
    children: [
      { kind: "action", id: "zoom-in", label: "Acercar", icon: "zoomIn", keepOpen: true, run: () => editor.zoomBy(1.25) },
      { kind: "action", id: "zoom-out", label: "Alejar", icon: "zoomOut", keepOpen: true, run: () => editor.zoomBy(1 / 1.25) },
      { kind: "action", id: "fit", label: "Encajar", icon: "fit", run: () => editor.fitView() },
      { kind: "action", id: "reset-view", label: "Reiniciar", icon: "grid", run: () => editor.resetView() },
      // La mano (desplazar el lienzo) es explorar la vista: vive aquí en vez de en
      // un grupo de herramientas suelto.
      { kind: "action", id: "tool-hand", label: "Mano", icon: "hand", active: state.tool === "hand", run: () => editor.setTool("hand") },
    ],
  };
}

function fileSubmenu(editor: Editor, state: EditorState, hooks: MenuHooks): SubmenuNode {
  return {
    kind: "submenu",
    id: "file",
    label: "Archivo",
    icon: "file",
    children: [
      { kind: "action", id: "undo", label: "Deshacer", icon: "undo", disabled: !state.history.canUndo, run: () => editor.undo() },
      { kind: "action", id: "redo", label: "Rehacer", icon: "redo", disabled: !state.history.canRedo, run: () => editor.redo() },
      { kind: "action", id: "new", label: "Nuevo", icon: "trash", run: () => hooks.newDoc() },
      { kind: "action", id: "open", label: "Abrir", icon: "folder", run: () => hooks.openFile() },
      { kind: "action", id: "save", label: "Guardar", icon: "save", run: () => hooks.save() },
      { kind: "action", id: "png", label: "PNG", icon: "download", run: () => hooks.exportPng() },
      { kind: "action", id: "svg", label: "SVG", icon: "download", run: () => hooks.exportSvg() },
      { kind: "action", id: "help", label: "Atajos", icon: "info", run: () => hooks.help() },
    ],
  };
}

function colorSubmenu(editor: Editor, state: EditorState, hooks: MenuHooks): SubmenuNode {
  return {
    kind: "submenu",
    id: "color",
    label: "Color",
    icon: "droplet",
    accent: state.color,
    children: [
      { kind: "action", id: "wheel", label: "Rueda", icon: "wheel", run: () => hooks.toggleWheel() },
      // Cuentagotas: tomar un color del lienzo. Es una acción sobre el color, así
      // que vive en el grupo Color en vez de en un grupo de herramientas suelto.
      { kind: "action", id: "tool-picker", label: "Cuentagotas", icon: "picker", active: state.tool === "picker", run: () => editor.setTool("picker") },
      // Paletas fijas: cada una es un subgrupo con sus colores. Elegir un color
      // marca esa paleta como activa (setPalette) y aplica el color (setColor),
      // igual que las pestañas + pozos de color del dock.
      {
        kind: "submenu",
        id: "palette",
        label: "Paleta",
        icon: "palette",
        children: DEFAULT_PALETTES.map((p, i) => ({
          kind: "submenu" as const,
          id: `palette-${i}`,
          label: p.name,
          active: state.paletteIndex === i,
          children: p.colors.map((hex, j) => ({
            kind: "action" as const,
            id: `palette-${i}-${j}`,
            label: hex.toUpperCase(),
            accent: hex,
            active: hex.toLowerCase() === state.color.toLowerCase(),
            keepOpen: true,
            run: () => {
              editor.setPalette(i);
              editor.setColor(hex);
            },
          })),
        })),
      },
      // Últimos colores usados (no la paleta fija): lo que de verdad has tocado.
      ...state.recentColors.map((hex, i) => ({
        kind: "action" as const,
        id: `swatch-${i}`,
        label: hex.toUpperCase(),
        accent: hex,
        active: hex.toLowerCase() === state.color.toLowerCase(),
        keepOpen: true,
        run: () => editor.setColor(hex),
      })),
    ],
  };
}

/**
 * Raiz del hotbox, reconstruida a partir del estado.
 *
 * El orden importa: el primer elemento aterriza arriba (norte) y el resto gira en
 * el sentido del reloj. Los grupos principales están SIEMPRE presentes y en un
 * orden fijo —igual que las pestañas del dock izquierdo, que no cambian con la
 * herramienta activa— para que las mismas opciones se alcancen siempre desde el
 * mismo sitio. Empieza por Archivo (la hoja) y sigue por Pincel, tal como pidió el
 * usuario; la herramienta activa se marca (active) pero no reordena.
 */
export function buildRoot(editor: Editor, state: EditorState, hooks: MenuHooks): HotNode[] {
  return [
    fileSubmenu(editor, state, hooks),
    brushSubmenu(editor, state),
    colorSubmenu(editor, state, hooks),
    matterSubmenu(editor, state),
    symmetrySubmenu(editor, state),
    viewSubmenu(editor, state),
  ];
}
