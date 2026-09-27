import type { Editor, EditorState } from "../../app/editor";
import { button, segmented, select, slider, toggle, type Control } from "../controls";
import { setClass } from "../dom";
import { isGroup, val, type BrushByMode, type Domain, type Field, type SchemaNode, type SurfaceId } from "./schema";

/**
 * Adaptador del dock: construye los controles imperativos (`controls.ts`) a
 * partir del mismo esquema declarativo que alimenta el radial.
 *
 * Los controles se crean UNA vez (rango/etiqueta/ayuda/get/set salen del
 * esquema) y se registran por `id`; el dock los compone en sus páginas pidiendo
 * `el(id)`. `sync(state)` recorre todos los campos y aplica valor y visibilidad
 * (dock atenúa con `is-dim` cuando `whenHidden === "dim"`, oculta con
 * `is-hidden` en otro caso). Así el rango o la etiqueta de una opción se edita
 * en un único sitio (el esquema) y las dos superficies quedan al día.
 *
 * Escotillas: los campos `custom` (selector HSV, vista previa) y `swatches`
 * (paleta/recientes) los arma el dock a mano —son cromo propio de la superficie—
 * así que aquí se omiten; y los campos `surfaces: ["radial"]` no entran.
 */
export class DockRenderer {
  private entries = new Map<string, { field: Field; ctrl: Control<never>; el: HTMLElement }>();
  private mode?: Control<string>;
  private brushByMode?: BrushByMode;

  constructor(editor: Editor, domains: Domain[]) {
    const s0 = editor.state;
    const walk = (nodes: SchemaNode[]): void => {
      for (const n of nodes) {
        if (isGroup(n)) {
          if (n.layout === "brush-by-mode" && n.brushByMode) this.buildMode(n.brushByMode, s0);
          walk(n.children);
        } else {
          this.buildField(n, s0);
        }
      }
    };
    walk(domains);
  }

  /** Segmentado de modo del pincel (Trazo/Relleno/Arrastre), si el esquema lo trae. */
  get modeEl(): HTMLElement | undefined {
    return this.mode?.el;
  }

  /** Elemento del control con ese `id` (lanza si no existe: caza errores de cableado). */
  el(id: string): HTMLElement {
    const e = this.entries.get(id);
    if (!e) throw new Error(`DockRenderer: no hay control "${id}"`);
    return e.el;
  }
  /** Recorre todos los controles: aplica valor de `state` y visibilidad. */
  sync(state: EditorState): void {
    if (this.mode && this.brushByMode) this.mode.set(this.brushByMode.current(state));
    for (const { field, ctrl, el } of this.entries.values()) {
      if (field.kind === "number") (ctrl as unknown as Control<number>).set(field.get(state));
      else if (field.kind === "toggle") (ctrl as unknown as Control<boolean>).set(field.get(state));
      else if (field.kind === "choice") (ctrl as unknown as Control<string>).set(field.get(state));
      else if (field.kind === "action" && field.disabled) (ctrl as unknown as Control<boolean>).set(!field.disabled(state));

      if (field.visible) {
        const vis = field.visible(state);
        if (field.whenHidden === "dim") {
          setClass(el, "is-dim", !vis);
          setClass(el, "is-hidden", false);
        } else {
          setClass(el, "is-hidden", !vis);
          setClass(el, "is-dim", false);
        }
      }
    }
  }

  private inDock(f: { surfaces?: SurfaceId[] }): boolean {
    return !f.surfaces || f.surfaces.includes("dock");
  }

  private buildMode(bm: BrushByMode, s0: EditorState): void {
    this.brushByMode = bm;
    this.mode = segmented({
      options: bm.modes.map((m) => ({ value: m.value, label: m.label, title: m.title })),
      value: bm.current(s0),
      onChange: (v) => bm.select(v),
    });
  }

  private buildField(f: Field, s0: EditorState): void {
    if (!this.inDock(f)) return;
    const hint = f.hint ? val(f.hint, s0) : undefined;
    let ctrl: Control<unknown> | null = null;

    switch (f.kind) {
      case "number":
        ctrl = slider({
          label: val(f.label, s0),
          min: f.min,
          max: f.max,
          step: f.step,
          decimals: f.decimals,
          gamma: f.gamma,
          unit: f.unit,
          hint,
          value: f.get(s0),
          onInput: (v) => f.set(v),
        });
        break;

      case "toggle":
        ctrl = toggle({ label: val(f.label, s0), value: f.get(s0), hint, onChange: (v) => f.set(v) });
        break;

      case "choice":
        // El dock rinde `choice` como segmentado (sin etiqueta, cromo compacto) o
        // como desplegable con etiqueta, según la pista `chooser` del esquema.
        ctrl =
          f.chooser === "segmented"
            ? segmented({
                options: f.options.map((o) => ({ value: o.value, label: o.label, iconName: o.icon, title: o.title })),
                value: f.get(s0),
                onChange: (v) => f.set(v),
              })
            : select({
                label: val(f.label, s0),
                options: f.options.map((o) => ({ value: o.value, label: o.label })),
                value: f.get(s0),
                hint,
                onChange: (v) => f.set(v),
              });
        break;

      case "action":
        ctrl = button({
          label: val(f.label, s0),
          iconName: f.icon ? val(f.icon, s0) : undefined,
          title: hint ?? val(f.label, s0),
          variant: f.danger ? "danger" : "ghost",
          onClick: () => f.run(),
        });
        break;

      default:
        return; // custom / swatches → los arma el dock a mano (color, vista previa)
    }

    this.entries.set(f.id, { field: f, ctrl: ctrl as Control<never>, el: ctrl.el });
  }
}
