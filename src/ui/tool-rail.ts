import type { Editor, EditorState } from "../app/editor";
import { DEFAULT_PALETTES } from "../core/color";
import { TOOL_LABELS, type ToolId } from "../tools/types";
import { ColorPicker } from "./color-picker";
import { PantoneWheel } from "./pantone-wheel";
import { button, segmented, swatches, type Control } from "./controls";
import { blurSoon, el, setClass } from "./dom";
import { icon } from "./icons";
import { Popover } from "./popover";

const TOOL_ORDER: { id: ToolId; key: string; hint: string }[] = [
  { id: "brush", key: "B", hint: "Pinta trazos, rellenos y formas arrastradas." },
  { id: "shape", key: "F", hint: "Crea formas fisicas arrastrando desde el lienzo." },
  { id: "matter", key: "M", hint: "Mueve o borra la materia ya creada." },
  { id: "symmetry", key: "S", hint: "Coloca y gira el eje de simetria." },
  { id: "picker", key: "I", hint: "Toma un color del lienzo." },
  { id: "hand", key: "H", hint: "Desplaza la vista (o manten Espacio)." },
];

/**
 * Barra de herramientas lateral.
 *
 * Una columna fija con las seis herramientas, el pozo de color y el del fondo.
 * La barra de Webchemy mezclaba herramientas, modificadores y acciones en una
 * sola fila; aqui cada cosa vive en su sitio: herramientas a la izquierda,
 * ajustes de la herramienta activa a la derecha, acciones arriba.
 */
export class ToolRail {
  readonly el: HTMLElement;

  private buttons = new Map<ToolId, HTMLButtonElement>();
  private colorWell: HTMLButtonElement;
  private bgWell: HTMLButtonElement;
  private picker: ColorPicker;
  private bgPicker: ColorPicker;
  private pantone: PantoneWheel;
  private paletteSwatches: Control<{ colors: readonly string[]; value: string }>;
  private paletteTabs: Control<string>;
  private colorPopover: Popover;
  private bgPopover: Popover;
  private editor: Editor;

  constructor(editor: Editor) {
    this.editor = editor;

    const tools = el("div", { class: "rail-group" });
    for (const t of TOOL_ORDER) {
      const b = el(
        "button",
        {
          class: "rail-btn",
          type: "button",
          title: `${TOOL_LABELS[t.id]} (${t.key}) — ${t.hint}`,
          on: {
            click: () => {
              editor.setTool(t.id);
              blurSoon(b);
            },
          },
        },
        [
          el("span", { class: "btn-glyph", html: icon(t.id) }),
          el("span", { class: "rail-key", text: t.key }),
        ],
      );
      this.buttons.set(t.id, b);
      tools.appendChild(b);
    }

    this.picker = new ColorPicker(editor.color, (hex) => editor.setColor(hex));
    // Rueda Pantone flotante: sistema de color aparte, mismo comportamiento que
    // el del estudio de referencia. Se muestra/oculta desde el popover de color.
    this.pantone = new PantoneWheel((hex) => {
      editor.setColor(hex);
      this.picker.set(hex);
    });
    this.paletteTabs = segmented({
      options: DEFAULT_PALETTES.map((p, i) => ({ value: String(i), label: p.name })),
      value: "0",
      onChange: (v) => editor.setPalette(Number(v)),
    });
    this.paletteSwatches = swatches({
      colors: DEFAULT_PALETTES[0].colors,
      value: editor.color,
      onPick: (hex) => {
        editor.setColor(hex);
        this.picker.set(hex);
      },
    });

    const colorPanel = el("div", { class: "popover-body" }, [
      el("h3", { class: "popover-title", text: "Color" }),
      this.picker.el,
      button({
        iconName: "wheel",
        label: "Rueda Pantone",
        title: "Rueda de color flotante (sistema aparte)",
        onClick: () => this.pantone.toggle(),
      }).el,
      el("div", { class: "popover-divider" }),
      this.paletteTabs.el,
      this.paletteSwatches.el,
    ]);
    this.colorPopover = new Popover(colorPanel, "popover-color");

    this.bgPicker = new ColorPicker(editor.doc.meta.background, (hex) => editor.setBackground(hex));
    const bgPanel = el("div", { class: "popover-body" }, [
      el("h3", { class: "popover-title", text: "Fondo del lienzo" }),
      this.bgPicker.el,
      el("div", { class: "popover-divider" }),
      swatches({
        colors: ["#f4f1ea", "#ffffff", "#e8e4dc", "#1a1c22", "#0d0f14", "#101820", "#2a2320"],
        value: editor.doc.meta.background,
        onPick: (hex) => {
          editor.setBackground(hex);
          this.bgPicker.set(hex);
        },
      }).el,
    ]);
    this.bgPopover = new Popover(bgPanel, "popover-color");

    this.colorWell = el("button", {
      class: "rail-well",
      type: "button",
      title: "Color de dibujo",
      on: {
        click: () => {
          this.colorPopover.toggle(this.colorWell, "right");
          blurSoon(this.colorWell);
        },
      },
    });
    this.bgWell = el("button", {
      class: "rail-well rail-well-bg",
      type: "button",
      title: "Color del fondo",
      on: {
        click: () => {
          this.bgPopover.toggle(this.bgWell, "right");
          blurSoon(this.bgWell);
        },
      },
    });

    this.el = el("aside", { class: "rail", role: "toolbar" }, [
      tools,
      el("div", { class: "rail-sep" }),
      el("div", { class: "rail-group rail-wells" }, [
        this.colorWell,
        this.bgWell,
        button({
          iconName: "eraser",
          title: "Cambiar dibujo y fondo (X)",
          onClick: () => {
            const ink = this.editor.color;
            const bg = this.editor.doc.meta.background;
            this.editor.setColor(bg);
            this.editor.setBackground(ink);
            this.picker.set(bg);
            this.bgPicker.set(ink);
          },
        }).el,
      ]),
    ]);
  }

  update(state: EditorState): void {
    for (const [id, b] of this.buttons) setClass(b, "is-active", id === state.tool);
    this.colorWell.style.background = state.color;
    this.bgWell.style.background = state.background;
    this.paletteTabs.set(String(state.paletteIndex));
    this.paletteSwatches.set({ colors: state.palette.colors, value: state.color });
    this.picker.set(state.color);
    this.bgPicker.set(state.background);
  }

  dispose(): void {
    this.colorPopover.dispose();
    this.bgPopover.dispose();
    this.pantone.dispose();
  }
}
