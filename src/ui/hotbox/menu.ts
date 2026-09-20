import type { Editor, EditorState } from "../../app/editor";
import { SHAPE_LABELS, type ShapeKind } from "../../physics/shapes";
import { DYNAMICS_INFO, type BrushMode, type StrokeDynamics } from "../../stroke/types";
import { SYMMETRY_LABELS, type SymmetryMode } from "../../symmetry/symmetry";
import { PULL_LABELS, type PullFamily } from "../../tools/pull-shapes";
import { TOOL_LABELS, type ToolId } from "../../tools/types";

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
  buildPanel?: (host: HTMLElement) => () => void;
}

export interface SubmenuNode extends NodeBase {
  kind: "submenu";
  children: HotNode[];
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
  openColor(): void;
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

// ------------------------------------------------------------ submenus por herramienta

function toolNode(editor: Editor, state: EditorState, id: ToolId, ic: string): ActionNode {
  return {
    kind: "action",
    id: `tool-${id}`,
    label: TOOL_LABELS[id],
    icon: ic,
    active: state.tool === id,
    run: () => editor.setTool(id),
  };
}

function toolsSubmenu(editor: Editor, state: EditorState): SubmenuNode {
  return {
    kind: "submenu",
    id: "tools",
    label: "Dibujar",
    icon: "brush",
    hint: "Elige con que actuas sobre el lienzo",
    children: [
      toolNode(editor, state, "brush", "brush"),
      toolNode(editor, state, "shape", "shape"),
      toolNode(editor, state, "matter", "matter"),
      toolNode(editor, state, "symmetry", "symmetry"),
      toolNode(editor, state, "picker", "picker"),
      toolNode(editor, state, "hand", "hand"),
    ],
  };
}

function brushSubmenu(editor: Editor, state: EditorState): SubmenuNode {
  const b = state.brush;
  const mode = (m: BrushMode): ActionNode => ({
    kind: "action",
    id: `mode-${m}`,
    label: MODE_LABELS[m],
    active: b.mode === m,
    keepOpen: true,
    run: () => editor.setBrush({ mode: m }),
  });
  const children: HotNode[] = [
    { kind: "submenu", id: "mode", label: "Modo", icon: "spark", children: [mode("stroke"), mode("fill"), mode("pull")] },
    {
      kind: "dial",
      id: "size",
      label: "Tamano",
      icon: "plus",
      min: 0.5,
      max: 400,
      step: 0.5,
      gamma: 2.2,
      unit: "px",
      value: b.size,
      onInput: (v) => editor.setBrush({ size: v }),
    },
    {
      kind: "dial",
      id: "opacity",
      label: "Opacidad",
      min: 0.02,
      max: 1,
      step: 0.01,
      value: b.opacity,
      onInput: (v) => editor.setBrush({ opacity: v }),
    },
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
    {
      kind: "dial",
      id: "smoothing",
      label: "Suavizado",
      min: 0,
      max: 1,
      step: 0.01,
      value: b.smoothing,
      onInput: (v) => editor.setBrush({ smoothing: v }),
    },
    { kind: "action", id: "gradient", label: "Degradado", active: b.gradient, keepOpen: true, run: () => editor.setBrush({ gradient: !b.gradient }) },
    { kind: "action", id: "splat", label: "Splat", active: b.splat, keepOpen: true, run: () => editor.setBrush({ splat: !b.splat }) },
  ];
  if (b.mode === "pull") {
    children.push({
      kind: "submenu",
      id: "pull-family",
      label: "Familia",
      children: (Object.keys(PULL_LABELS) as (PullFamily | "random")[]).map((k) => ({
        kind: "action" as const,
        id: `pull-${k}`,
        label: PULL_LABELS[k],
        active: state.pullFamily === k,
        run: () => editor.setPullFamily(k),
      })),
    });
  }
  return { kind: "submenu", id: "brush", label: "Pincel", icon: "tune", children };
}

/**
 * Submenu de forma: solo aparecen los ajustes que la pieza activa usa de verdad.
 * "Redondeo" no hace nada en una estrella ni "Lados" en una caja, asi que el
 * arbol se poda por tipo de forma para no ofrecer diales inertes.
 */
function shapeSubmenu(editor: Editor, state: EditorState): SubmenuNode {
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

function symmetrySubmenu(editor: Editor, state: EditorState): SubmenuNode {
  const sym = state.symmetry;
  return {
    kind: "submenu",
    id: "symmetry",
    label: "Simetria",
    icon: "symmetry",
    children: [
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
      { kind: "action", id: "sym-visible", label: "Guia", active: sym.visible, keepOpen: true, run: () => editor.setSymmetry({ visible: !sym.visible }) },
    ],
  };
}

function matterSubmenu(editor: Editor, state: EditorState): SubmenuNode {
  const w = state.world;
  const f = state.field;
  return {
    kind: "submenu",
    id: "matter-cfg",
    label: "Materia",
    icon: "matter",
    children: [
      { kind: "action", id: "run", label: state.running ? "Pausar" : "Reanudar", icon: state.running ? "pause" : "play", active: state.running, keepOpen: true, run: () => editor.setRunning(!state.running) },
      { kind: "action", id: "seed", label: "Sembrar", icon: "seed", run: () => editor.seedMatter(8) },
      { kind: "action", id: "bake", label: "Hornear", icon: "bake", run: () => editor.bakeMatter() },
      { kind: "dial", id: "gravity", label: "Gravedad", min: -2000, max: 2000, step: 10, value: w.gravity.y, onInput: (v) => editor.setWorld({ gravity: { x: w.gravity.x, y: v } }) },
      { kind: "dial", id: "cohesion", label: "Cohesion", min: 0, max: 1, step: 0.01, value: w.cohesion, onInput: (v) => editor.setWorld({ cohesion: v }) },
      { kind: "dial", id: "blend", label: "Fusion", min: 0, max: 160, step: 1, gamma: 1.5, unit: "px", value: f.blend, onInput: (v) => { editor.setField({ blend: v }); editor.setWorld({ blend: v }); } },
      { kind: "action", id: "walls", label: "Paredes", icon: "grid", active: state.showWalls, keepOpen: true, run: () => editor.toggleWalls() },
      { kind: "action", id: "clear-matter", label: "Vaciar", icon: "trash", accent: "#ff5f6d", run: () => editor.clearMatter() },
    ],
  };
}

function viewSubmenu(editor: Editor): SubmenuNode {
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
      { kind: "action", id: "color-panel", label: "Selector", icon: "droplet", accent: state.color, run: () => hooks.openColor() },
      { kind: "action", id: "wheel", label: "Rueda", icon: "wheel", run: () => hooks.toggleWheel() },
      ...state.palette.colors.map((hex, i) => ({
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
 * El orden importa: el primer elemento aterriza arriba (norte) y el resto gira
 * en el sentido del reloj. Por eso el ajuste de la herramienta activa va primero
 * —es el sector que el gesto alcanza sin mirar—, y simetria/materia solo entran
 * cuando aportan al contexto.
 */
export function buildRoot(editor: Editor, state: EditorState, hooks: MenuHooks): HotNode[] {
  const tool = state.tool;
  const nodes: HotNode[] = [];

  if (tool === "brush" || tool === "picker" || tool === "hand") nodes.push(brushSubmenu(editor, state));
  else if (tool === "shape") nodes.push(shapeSubmenu(editor, state));
  else if (tool === "symmetry") nodes.push(symmetrySubmenu(editor, state));
  else if (tool === "matter") nodes.push(matterSubmenu(editor, state));

  nodes.push(toolsSubmenu(editor, state));
  nodes.push(colorSubmenu(editor, state, hooks));

  if (tool !== "symmetry") nodes.push(symmetrySubmenu(editor, state));
  if (tool !== "matter" && (state.bodies > 0 || tool === "shape")) nodes.push(matterSubmenu(editor, state));

  nodes.push(viewSubmenu(editor));
  nodes.push(fileSubmenu(editor, state, hooks));

  return nodes;
}
