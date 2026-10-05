import type { Editor, EditorState } from "../../app/editor";
import { buildSchema } from "../model/schema";
import { toHotNodes } from "../model/to-hotnodes";

/**
 * Modelo declarativo del hotbox.
 *
 * El menu radial no se dibuja a mano: se describe como un arbol de nodos y el
 * motor (hotbox.ts) lo despliega en sectores concentricos.
 *
 * Desde la unificacion de superficies, el arbol NO se construye aqui a mano: es
 * la proyeccion radial del esquema unico (`src/ui/model/schema.ts`), que declara
 * cada opcion UNA vez para el dock y el radial. `buildRoot` conserva su firma y
 * su forma de salida (mismos ids/labels/orden/poda) para no romper a sus
 * consumidores (hotbox, radial-menu, radial-chips, smoke-ui); el esquema queda
 * detras de esta API estable. Los tipos `HotNode`/`MenuHooks` siguen viviendo
 * aqui porque son el contrato de esos consumidores.
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
  importImage(): void;
  save(): void;
  exportPng(): void;
  exportSvg(): void;
}

/**
 * Raiz del hotbox: la proyeccion radial del esquema unico. Mantiene el orden de
 * dominios [Archivo, Pincel, Color, Materia, Simetria, Explorar] y todos los
 * ids/labels/poda que consumen radial-chips y smoke-ui.
 */
export function buildRoot(editor: Editor, state: EditorState, hooks: MenuHooks): HotNode[] {
  return toHotNodes(buildSchema(editor, state, hooks), state, editor);
}
