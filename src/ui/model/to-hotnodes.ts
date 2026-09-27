import type { Editor, EditorState } from "../../app/editor";
import type { HotNode } from "../hotbox/menu";
import { isGroup, val, type Domain, type Field, type Group, type SchemaNode, type SurfaceId } from "./schema";

/**
 * Adaptador radial: proyecta el esquema declarativo al árbol `HotNode` que el
 * motor del hotbox despliega en sectores.
 *
 * Reglas de proyección:
 * - `number` → dial; `toggle`/`action` → acción (los toggles quedan `keepOpen`
 *   y marcan `active`); `choice` → submenú de acciones; `group` → submenú.
 * - El radial SIEMPRE poda: si `visible(s)` es falso, el nodo se omite (nunca
 *   atenúa). Así reproduce la poda por forma, por dinámica y por modo de hoy.
 * - `custom` usa `renderRadial` si existe; si no, se omite.
 * - `layout: "brush-by-mode"` envuelve las opciones del pincel en tres submenús
 *   de modo que activan herramienta + modo al tocarlos, mostrando las opciones
 *   de ese modo (la navegación por modo que el usuario quiso conservar).
 */
export function toHotNodes(domains: Domain[], state: EditorState, editor: Editor): HotNode[] {
  const inRadial = (surfaces?: SurfaceId[]): boolean => !surfaces || surfaces.includes("radial");

  const nodesToHot = (nodes: SchemaNode[], s: EditorState): HotNode[] => {
    const out: HotNode[] = [];
    for (const n of nodes) {
      if (!inRadial(n.surfaces)) continue;
      if (n.visible && !n.visible(s)) continue; // poda: el radial nunca atenúa
      const hot = isGroup(n) ? groupToHot(n, s) : fieldToHot(n, s);
      if (Array.isArray(hot)) out.push(...hot);
      else if (hot) out.push(hot);
    }
    return out;
  };

  const groupToHot = (g: Group, s: EditorState): HotNode => {
    let children: HotNode[];
    if (g.layout === "brush-by-mode" && g.brushByMode) {
      const bm = g.brushByMode;
      children = bm.modes.map((m) => ({
        kind: "submenu" as const,
        id: `mode-${m.value}`,
        label: m.label,
        icon: m.icon,
        active: bm.isToolActive(s) && bm.current(s) === m.value,
        onSelect: () => bm.activate(m.value),
        // El estado se ajusta al modo del submenú para que la poda por modo
        // (p. ej. "Familia" solo en Arrastre) se evalúe como corresponde.
        children: nodesToHot(g.children, { ...s, brush: { ...s.brush, mode: m.value } }),
      }));
    } else {
      children = nodesToHot(g.children, s);
    }
    const node: HotNode = { kind: "submenu", id: g.id, label: val(g.label ?? "", s), children };
    if (g.icon) node.icon = val(g.icon, s);
    if (g.hint) node.hint = val(g.hint, s);
    if (g.accent) node.accent = val(g.accent, s);
    return node;
  };
  const fieldToHot = (f: Field, s: EditorState): HotNode | HotNode[] | null => {
    switch (f.kind) {
      case "custom":
        return f.renderRadial ? f.renderRadial(s) : null;

      case "number": {
        const node: HotNode = {
          kind: "dial",
          id: f.id,
          label: val(f.label, s),
          min: f.min,
          max: f.max,
          value: f.get(s),
          onInput: (v) => f.set(v),
        };
        if (f.icon) node.icon = val(f.icon, s);
        if (f.hint) node.hint = val(f.hint, s);
        if (f.step !== undefined) node.step = f.step;
        if (f.gamma !== undefined) node.gamma = f.gamma;
        if (f.unit !== undefined) node.unit = f.unit;
        if (f.disabled) node.disabled = f.disabled(s);
        return node;
      }

      case "toggle": {
        const node: HotNode = {
          kind: "action",
          id: f.id,
          label: val(f.label, s),
          keepOpen: true,
          active: f.get(s),
          // Se lee el valor vivo al pulsar para invertirlo (el submenú sigue abierto).
          run: () => f.set(!f.get(editor.state)),
        };
        if (f.icon) node.icon = val(f.icon, s);
        if (f.hint) node.hint = val(f.hint, s);
        if (f.disabled) node.disabled = f.disabled(s);
        return node;
      }

      case "action": {
        const node: HotNode = { kind: "action", id: f.id, label: val(f.label, s), run: f.run };
        if (f.icon) node.icon = val(f.icon, s);
        if (f.hint) node.hint = val(f.hint, s);
        if (f.accent) node.accent = val(f.accent, s);
        if (f.keepOpen) node.keepOpen = true;
        if (f.toggled) node.active = f.toggled(s);
        if (f.disabled) node.disabled = f.disabled(s);
        return node;
      }

      case "choice": {
        const node: HotNode = {
          kind: "submenu",
          id: f.id,
          label: val(f.label, s),
          children: f.options.map((o) => {
            const a: HotNode = {
              kind: "action",
              id: o.id,
              label: o.label,
              active: f.get(s) === o.value,
              run: () => f.set(o.value),
            };
            if (o.icon) a.icon = o.icon;
            if (o.accent) a.accent = o.accent;
            return a;
          }),
        };
        if (f.icon) node.icon = val(f.icon, s);
        if (f.hint) node.hint = val(f.hint, s);
        return node;
      }

      case "swatches":
        return f.colors(s).map((hex, i) => {
          const a: HotNode = {
            kind: "action",
            id: `${f.id}-${i}`,
            label: hex.toUpperCase(),
            accent: hex,
            keepOpen: true,
            active: hex.toLowerCase() === f.value(s).toLowerCase(),
            run: () => f.onPick(hex),
          };
          return a;
        });
    }
  };

  return nodesToHot(domains, state);
}
