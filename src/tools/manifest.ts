/**
 * Manifiesto de herramientas: fuente unica.
 *
 * Cada herramienta se declara UNA sola vez aqui: su etiqueta canonica, su icono,
 * su atajo, su fila en la ayuda, la pestana del dock que resalta y su accion en
 * el menu radial. Los consumidores derivan de este manifiesto en vez de repetir
 * la lista — el editor (instancias y teclado), el dock lateral, la barra de
 * estado, el esquema de la interfaz y el panel de ayuda.
 *
 * Antes de esto la misma herramienta se declaraba en cinco listas paralelas y
 * varias parciales, y solo una tenia garantia del compilador. La deriva ya habia
 * ocurrido: `bridge` faltaba en tres listas y `select` en el rail.
 *
 * REGLA DE IMPORTS: una herramienta debe importar `ToolId` SIEMPRE con
 * `import type`. Un import de valor desde una herramienta crearia un ciclo
 * (manifest -> herramienta -> manifest) y `TOOLS` se evaluaria en orden
 * indeterminado — que es un fallo en produccion y no en desarrollo.
 *
 * Este modulo no conoce `Editor`, `EditorState` ni `SurfaceId`: eso vive en los
 * adaptadores de la interfaz. El manifiesto dice QUE ES una herramienta; el
 * esquema dice COMO se pinta en su arbol.
 */

import type { Tool } from "./types";

import { BrushTool } from "./brush-tool";
import { BridgeTool } from "./bridge-tool";
import { MatterTool } from "./matter-tool";
import { HandTool, PickerTool } from "./picker-tool";
import { SelectTool } from "./select-tool";
import { ShapeTool } from "./shape-tool";
import { SymmetryTool } from "./symmetry-tool";

export interface ToolSpec {
  readonly id: string;
  /** Nombre canonico: barra de estado y avisos de `status()`. */
  readonly label: string;
  /** Clave de `ICONS`, no SVG. `bridge` usa "layers": no tiene icono propio. */
  readonly icon: string;
  /** Atajo que CAMBIA de herramienta. */
  readonly shortcut?: string;
  /** El atajo exige Shift. Solo la simetria, porque `S` a secas alterna. */
  readonly shortcutShift?: boolean;
  /** Tecla sostenida que presta la herramienta sin cambiar de modo. */
  readonly tempOn?: "space";
  /** Fila del panel de ayuda. Ausente = la herramienta no aparece alli. */
  readonly help?: { readonly keys: string; readonly text: string };
  /** Pestana del dock que se resalta. Ausente = ninguna (picker, hand). */
  readonly dockTab?: string;
  /** Accion del menu radial. Ausente = sin accion propia (el pincel). */
  readonly radial?: {
    readonly domain: string;
    /** Id del nodo generado. Es CONTRATO: los chips lo persisten. */
    readonly nodeId: string;
    /** Etiqueta propia del radial; difiere de `label` (materia -> "Mover"). */
    readonly label: string;
    /** Sobreescribe el icono. Sin el, se usa `icon`. */
    readonly icon?: string;
    /** Superficies donde aparece. Ausente = ambas. */
    readonly surfaces?: readonly ("dock" | "radial")[];
  };
  readonly create: () => Tool;
}

export const TOOLS = [
  {
    id: "select",
    label: "Selección",
    icon: "select",
    shortcut: "v",
    help: { keys: "V", text: "Selección" },
    dockTab: "select",
    radial: { domain: "select", nodeId: "tool-select", label: "Flecha (V)" },
    create: () => new SelectTool(),
  },
  {
    id: "brush",
    label: "Pincel",
    icon: "brush",
    shortcut: "b",
    help: { keys: "B", text: "Pincel" },
    dockTab: "brush",
    create: () => new BrushTool(),
  },
  {
    id: "shape",
    label: "Forma",
    icon: "shape",
    shortcut: "f",
    help: { keys: "F", text: "Forma fisica" },
    dockTab: "matter-cfg",
    radial: {
      domain: "matter-cfg",
      nodeId: "tool-shape",
      label: "Crear",
      surfaces: ["radial"],
    },
    create: () => new ShapeTool(),
  },
  {
    id: "matter",
    label: "Materia",
    icon: "matter",
    shortcut: "m",
    help: { keys: "M", text: "Mover materia" },
    dockTab: "matter-cfg",
    radial: {
      domain: "matter-cfg",
      nodeId: "tool-matter",
      label: "Mover",
      surfaces: ["radial"],
    },
    create: () => new MatterTool(),
  },
  {
    id: "bridge",
    label: "Puente",
    icon: "layers",
    shortcut: "p",
    help: { keys: "P", text: "Puente" },
    radial: {
      domain: "matter-cfg",
      nodeId: "tool-bridge",
      label: "Puente",
      surfaces: ["radial"],
    },
    create: () => new BridgeTool(),
  },
  {
    id: "symmetry",
    label: "Simetria",
    icon: "symmetry",
    shortcut: "s",
    shortcutShift: true,
    help: { keys: "S", text: "Eje de simetria" },
    dockTab: "symmetry",
    radial: {
      domain: "symmetry",
      nodeId: "tool-symmetry",
      label: "Mover eje",
      surfaces: ["radial"],
    },
    create: () => new SymmetryTool(),
  },
  {
    id: "picker",
    label: "Cuentagotas",
    icon: "picker",
    shortcut: "i",
    help: { keys: "I", text: "Cuentagotas" },
    radial: {
      domain: "color",
      nodeId: "tool-picker",
      label: "Cuentagotas",
      surfaces: ["radial"],
    },
    create: () => new PickerTool(),
  },
  {
    id: "hand",
    label: "Mano",
    icon: "hand",
    shortcut: "h",
    tempOn: "space",
    help: { keys: "H / Espacio", text: "Mano" },
    radial: {
      domain: "view",
      nodeId: "tool-hand",
      label: "Mano",
      surfaces: ["radial"],
    },
    create: () => new HandTool(),
  },
] as const satisfies readonly ToolSpec[];

/**
 * Un tipo que no cierra la union colapsa a `never`.
 *
 * Si `TOOLS` se ensuciara con una anotacion ancha (`ToolSpec[]`), `ToolId`
 * pasaria a `string`, el `Record<ToolId, Tool>` del editor dejaria de forzar
 * exhaustividad y una herramienta sin instanciar compilaria sin quejarse. El
 * fallo seria MUDO; aqui rompe la compilacion.
 */
type Closed<T extends string> = string extends T ? never : T;

export type ToolId = Closed<(typeof TOOLS)[number]["id"]>;

/**
 * Vista ancha del manifiesto.
 *
 * Bajo `as const` cada entrada conserva sus literales, asi que los campos
 * opcionales de las variantes que no los llevan son ilegibles (`TOOLS.map(t =>
 * t.key)` no compila). Se ensancha una vez aqui, con anotacion y no con cast.
 *
 * El `id` se reestrecha a `ToolId`: sin eso el ensanchado lo degradaria a
 * `string` y se perderia la union.
 */
export type ToolSpecFull = ToolSpec & { readonly id: ToolId };

export const TOOL_SPECS: readonly ToolSpecFull[] = TOOLS;

/**
 * Indexa el manifiesto por id.
 *
 * El array ES la definicion del conjunto de herramientas, asi que el registro
 * sale total por construccion: la unica anotacion es el acumulador.
 */
const indexBy = <V>(pick: (t: ToolSpecFull) => V): Record<ToolId, V> => {
  const out = {} as Record<ToolId, V>;
  for (const spec of TOOL_SPECS) out[spec.id] = pick(spec);
  return out;
};

/** Etiqueta canonica por herramienta. */
export const TOOL_LABELS = indexBy((t) => t.label);

/** Ficha completa por herramienta, para los adaptadores de superficie. */
export const TOOL_BY_ID = indexBy((t) => t);

/** Pestana del dock que resalta cada herramienta. */
const tabOf = (t: ToolSpecFull): [ToolId, string][] =>
  t.dockTab ? [[t.id, t.dockTab]] : [];

export const TOOL_TABS: Partial<Record<ToolId, string>> = Object.fromEntries(
  TOOL_SPECS.flatMap(tabOf),
);

export interface ToolKey {
  readonly key: string;
  readonly shift: boolean;
  readonly id: ToolId;
}

/**
 * Atajos que cambian de herramienta.
 *
 * `shift` los separa porque la simetria usa Shift+S: la `S` a secas es un
 * INTERRUPTOR (`toggleSymmetry`), no un cambio de herramienta, asi que no
 * aparece aqui y su bloque corre antes que el despacho generico.
 */
const keysOf = (t: ToolSpecFull): ToolKey[] =>
  t.shortcut ? [{ key: t.shortcut, shift: t.shortcutShift === true, id: t.id }] : [];

export const TOOL_KEYS: readonly ToolKey[] = TOOL_SPECS.flatMap(keysOf);

/** Filas del grupo "Herramientas" del panel de ayuda. */
export const TOOL_HELP_ROWS: readonly [string, string][] = TOOL_SPECS.flatMap(
  (t) => (t.help ? [[t.help.keys, t.help.text] as [string, string]] : []),
);

/** Herramienta con la que arranca el editor. */
export const DEFAULT_TOOL: ToolId = "brush";

/** Herramienta que presta una tecla sostenida mientras se mantiene. */
export const HELD_TOOL: ToolId | null =
  TOOL_SPECS.find((t) => t.tempOn === "space")?.id ?? null;
