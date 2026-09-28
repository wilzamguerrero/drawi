import type { Editor, EditorState } from "../../app/editor";
import { buildRoot, type HotNode, type MenuHooks } from "../hotbox/menu";
import { DOCK_TAB_DOMAINS } from "../side-dock";
import { buildSchema, isGroup, val, type ChoiceOption, type Field, type SchemaNode } from "./schema";

/**
 * Adaptador esquema → paletón de órdenes (Tab / Ctrl+K).
 *
 * Tercera superficie que se alimenta del MISMO esquema único (`schema.ts`) que
 * el dock y el menú radial. Editar el esquema actualiza también el paletón, sin
 * tocar este archivo ni la lista de órdenes. Aquí NO se poda por `visible`: el
 * paletón enseña TODAS las opciones para que se puedan buscar aunque el modo
 * activo no las muestre (por eso conviven las dos "Opacidad" —la del pincel y la
 * de Materia→Acabado—, cada una con su ruta para distinguirlas).
 *
 * Cada orden lleva además dos destinos, que el paletón ofrece como botones:
 * - `dockTab`: la pestaña del dock que contiene la opción (si su campo vive en
 *   el dock). Sirve para "llevar" al usuario al panel donde ajustarla.
 * - `radialPath`: el camino de índices hacia el nodo en el árbol del radial (si
 *   la opción es alcanzable ahí ahora mismo). Sirve para nacer un chip en el
 *   lienzo, igual que el desgarro del radial.
 */
/**
 * Control editable EN LÍNEA de una orden: el paletón lo pinta en la propia fila
 * para ajustar el valor sin ir al panel. Lleva cierres a los `get`/`set` reales
 * del esquema (los mismos que usa el dock), así editar aquí mueve el editor y se
 * refleja en todas las superficies. Solo número/interruptor/elección son
 * editables en línea; el resto (acciones, modos) no trae `edit`.
 */
export type CommandEdit =
  | {
      kind: "number";
      min: number;
      max: number;
      step: number;
      decimals: number;
      /** Curva de respuesta del deslizador (>1 da más resolución abajo). */
      gamma: number;
      unit: string;
      get: () => number;
      set: (v: number) => void;
    }
  | { kind: "toggle"; get: () => boolean; set: (v: boolean) => void }
  | { kind: "choice"; options: ChoiceOption[]; get: () => string; set: (v: string) => void };

export interface Command {
  id: string;
  label: string;
  icon?: string;
  /** Texto extra para la búsqueda difusa (pistas, etiquetas de opciones). */
  keywords: string;
  /** Ruta de ancestros (dominio › grupo…) para desambiguar etiquetas repetidas. */
  trail: string[];
  kind: Field["kind"] | "mode";
  /** Acción intrínseca (solo acciones, toggles y modos de pincel la tienen). */
  run: (() => void) | null;
  /** Control editable en línea (número/interruptor/elección), o null. */
  edit: CommandEdit | null;
  /** Pestaña del dock que abre esta opción, o null si no vive en el dock. */
  dockTab: string | null;
  /** Camino en el árbol radial para nacer un chip, o null si no es alcanzable. */
  radialPath: number[] | null;
  /** Estado "encendido": toggle activo, herramienta/modo en uso. */
  on: boolean;
  disabled: boolean;
}

/** ¿El nodo (dominio, grupo o campo) aparece en el dock? */
function inDock(n: SchemaNode): boolean {
  return !n.surfaces || n.surfaces.includes("dock");
}

/**
 * Índice `id → primer camino` sobre el árbol del radial actual. El primer camino
 * basta: un chip se re-resuelve por (camino, id) en cada sync. Solo los ids que
 * están HOY en el árbol (no podados por `visible`) quedan indexados; el resto no
 * podrá nacer chip —igual que en el radial no se puede desgarrar lo que no se ve.
 */
function indexRadialPaths(tree: HotNode[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const walk = (nodes: HotNode[], prefix: number[]): void => {
    nodes.forEach((n, i) => {
      const path = [...prefix, i];
      if (!map.has(n.id)) map.set(n.id, path);
      if (n.kind === "submenu") walk(n.children, path);
    });
  };
  walk(tree, []);
  return map;
}

/** Convierte un campo del esquema en una orden buscable (o null si no aplica). */
function fieldToCommand(
  f: Field,
  editor: Editor,
  s: EditorState,
  trail: string[],
  dockTab: string | null,
  radial: Map<string, number[]>,
): Command | null {
  // El cromo propio de cada superficie (selectores, notas, vistas previas) no es
  // una orden: son duplicados o piezas de UI, no ajustes buscables por sí solos.
  if (f.kind === "custom") return null;

  const label = val(f.label, s);
  const kws = [label];
  if (f.hint) kws.push(val(f.hint, s));
  if (f.kind === "choice") for (const o of f.options) kws.push(o.label);

  let run: (() => void) | null = null;
  let on = false;
  let edit: CommandEdit | null = null;
  if (f.kind === "action") {
    run = f.run;
    if (f.toggled) on = f.toggled(s);
  } else if (f.kind === "toggle") {
    on = f.get(s);
    run = () => f.set(!f.get(editor.state));
    edit = { kind: "toggle", get: () => f.get(editor.state), set: (v) => f.set(v) };
  } else if (f.kind === "number") {
    edit = {
      kind: "number",
      min: f.min,
      max: f.max,
      step: f.step ?? 1,
      decimals: f.decimals ?? 0,
      gamma: f.gamma ?? 1,
      unit: f.unit ?? "",
      get: () => f.get(editor.state),
      set: (v) => f.set(v),
    };
  } else if (f.kind === "choice") {
    edit = { kind: "choice", options: f.options, get: () => f.get(editor.state), set: (v) => f.set(v) };
  }

  return {
    id: f.id,
    label,
    icon: f.icon ? val(f.icon, s) : undefined,
    keywords: kws.join(" "),
    trail,
    kind: f.kind,
    run,
    edit,
    dockTab,
    radialPath: radial.get(f.id) ?? null,
    on,
    disabled: f.disabled ? f.disabled(s) : false,
  };
}

/**
 * Aplana los nodos de un dominio en órdenes. Desciende por los grupos apilando
 * su etiqueta en la ruta; `dockOk` se va apagando en cuanto un ancestro es
 * solo-radial (así un campo bajo un grupo `surfaces:["radial"]` no ofrece panel).
 */
function walk(
  nodes: SchemaNode[],
  editor: Editor,
  s: EditorState,
  trail: string[],
  tabId: string | null,
  dockOk: boolean,
  radial: Map<string, number[]>,
  out: Command[],
): void {
  for (const n of nodes) {
    const okHere = dockOk && inDock(n);
    if (isGroup(n)) {
      const label = val(n.label ?? "", s);
      walk(n.children, editor, s, label ? [...trail, label] : trail, tabId, okHere, radial, out);
    } else {
      const cmd = fieldToCommand(n, editor, s, trail, okHere ? tabId : null, radial);
      if (cmd) out.push(cmd);
    }
  }
}

/**
 * Construye la lista de órdenes del paletón desde el esquema único. Mismo orden
 * que el radial (dominios de `buildSchema`). El pincel emite además una orden por
 * modo (Trazo/Relleno/Arrastre/Borrador) que activa herramienta + modo.
 */
export function buildCommands(editor: Editor, state: EditorState, hooks: MenuHooks): Command[] {
  const domains = buildSchema(editor, state, hooks);
  const radial = indexRadialPaths(buildRoot(editor, state, hooks));
  const out: Command[] = [];

  for (const domain of domains) {
    const domainLabel = val(domain.label ?? domain.id, state);
    const isTab = DOCK_TAB_DOMAINS.includes(domain.id) && inDock(domain);
    const tabId = isTab ? domain.id : null;

    // Pincel por modos: cada modo es una orden que activa la herramienta y el modo.
    if (domain.layout === "brush-by-mode" && domain.brushByMode) {
      const bm = domain.brushByMode;
      for (const m of bm.modes) {
        const id = `mode-${m.value}`;
        out.push({
          id,
          label: m.label,
          icon: m.icon,
          keywords: `${m.label} ${m.title ?? ""} ${domainLabel}`,
          trail: [domainLabel],
          kind: "mode",
          run: () => bm.activate(m.value),
          edit: null,
          dockTab: tabId,
          radialPath: radial.get(id) ?? null,
          on: bm.isToolActive(state) && bm.current(state) === m.value,
          disabled: false,
        });
      }
    }

    walk(domain.children, editor, state, [domainLabel], tabId, inDock(domain), radial, out);
  }

  return out;
}
