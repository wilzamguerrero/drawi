import type { Editor, EditorState } from "../app/editor";
import { DEFAULT_EXPORT, type ExportOptions } from "../io/export";
import { button, row, segmented, slider, toggle } from "./controls";
import { blurSoon, el, num } from "./dom";
import { icon } from "./icons";
import { Popover } from "./popover";
import { exportImage, exportVector, newDocument, openProject, saveProject } from "./file-actions";

/**
 * Barra superior: documento, historial, vista, simulacion y archivo.
 *
 * Las acciones destructivas piden confirmacion solo cuando hay algo que perder;
 * confirmar sobre un lienzo vacio es ruido.
 */
export class TopBar {
  readonly el: HTMLElement;

  private editor: Editor;
  private nameInput: HTMLInputElement;
  private undoBtn: ReturnType<typeof button>;
  private redoBtn: ReturnType<typeof button>;
  private runBtn: ReturnType<typeof button>;
  private wallsBtn: ReturnType<typeof button>;
  private zoomLabel: HTMLButtonElement;
  private exportPopover: Popover;
  private exportBtn: HTMLButtonElement;
  private exportOptions: ExportOptions = { ...DEFAULT_EXPORT };
  private onHelp: () => void;

  constructor(editor: Editor, onHelp: () => void) {
    this.editor = editor;
    this.onHelp = onHelp;

    this.nameInput = el("input", {
      class: "doc-name",
      type: "text",
      value: editor.doc.meta.name,
      title: "Nombre del documento",
    });
    this.nameInput.addEventListener("change", () => editor.setName(this.nameInput.value));
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.nameInput.blur();
    });

    this.undoBtn = button({
      iconName: "undo",
      title: "Deshacer (Ctrl+Z)",
      onClick: () => editor.undo(),
    });
    this.redoBtn = button({
      iconName: "redo",
      title: "Rehacer (Ctrl+Shift+Z)",
      onClick: () => editor.redo(),
    });

    this.zoomLabel = el("button", {
      class: "zoom-label",
      title: "Restablecer la vista (0)",
      text: "100%",
    });
    this.zoomLabel.addEventListener("click", () => {
      editor.resetView();
      blurSoon(this.zoomLabel);
    });

    this.runBtn = button({
      iconName: "pause",
      title: "Pausar o reanudar la simulacion",
      onClick: () => editor.setRunning(!editor.running),
    });
    this.wallsBtn = button({
      iconName: "grid",
      title: "Paredes del contenedor: la materia rebota en el borde de la vista",
      onClick: () => editor.toggleWalls(),
    });

    this.exportBtn = el(
      "button",
      { class: "btn btn-ghost", type: "button", title: "Exportar imagen" },
      [
        el("span", { class: "btn-glyph", html: icon("download") }),
        el("span", { class: "btn-label", text: "Exportar" }),
      ],
    );
    this.exportBtn.addEventListener("click", () => {
      this.exportPopover.toggle(this.exportBtn, "bottom");
      blurSoon(this.exportBtn);
    });
    this.exportPopover = new Popover(this.buildExportPanel(), "popover-export");

    this.el = el("header", { class: "topbar" }, [
      el("div", { class: "topbar-group topbar-brand" }, [
        el("span", { class: "brand-mark", text: "drawi" }),
        this.nameInput,
      ]),
      el("div", { class: "topbar-sep" }),
      el("div", { class: "topbar-group" }, [this.undoBtn.el, this.redoBtn.el]),
      el("div", { class: "topbar-sep" }),
      el("div", { class: "topbar-group" }, [
        button({ iconName: "zoomOut", title: "Alejar", onClick: () => editor.zoomBy(1 / 1.25) }).el,
        this.zoomLabel,
        button({ iconName: "zoomIn", title: "Acercar", onClick: () => editor.zoomBy(1.25) }).el,
        button({ iconName: "fit", title: "Encajar el contenido", onClick: () => editor.fitView() }).el,
      ]),
      el("div", { class: "topbar-sep" }),
      el("div", { class: "topbar-group" }, [
        this.runBtn.el,
        button({
          iconName: "seed",
          title: "Sembrar formas al azar en la vista",
          onClick: () => editor.seedMatter(8),
        }).el,
        button({
          iconName: "bake",
          title: "Hornear: convierte la materia fundida en tinta editable",
          onClick: () => editor.bakeMatter(),
        }).el,
        this.wallsBtn.el,
      ]),
      el("div", { class: "topbar-spacer" }),
      el("div", { class: "topbar-group" }, [
        button({
          iconName: "trash",
          title: "Lienzo nuevo",
          onClick: () => {
            if (!editor.doc.isEmpty && !confirm("Empezar un lienzo nuevo? Se perdera lo que hay.")) return;
            editor.status(newDocument(editor));
          },
        }).el,
        button({ iconName: "folder", title: "Abrir proyecto .drawi", onClick: () => void this.open() }).el,
        button({
          iconName: "save",
          title: "Guardar proyecto .drawi",
          onClick: () => editor.status(saveProject(editor)),
        }).el,
        this.exportBtn,
        button({ iconName: "info", title: "Atajos y ayuda", onClick: () => this.onHelp() }).el,
      ]),
    ]);
  }

  private async open(): Promise<void> {
    this.editor.status(await openProject(this.editor));
  }

  private buildExportPanel(): HTMLElement {
    const scale = segmented<string>({
      label: "Resolucion",
      options: [
        { value: "1", label: "1x" },
        { value: "2", label: "2x" },
        { value: "3", label: "3x" },
        { value: "4", label: "4x" },
      ],
      value: String(this.exportOptions.scale),
      onChange: (v) => {
        this.exportOptions.scale = Number(v);
      },
    });

    return el("div", { class: "popover-body" }, [
      el("h3", { class: "popover-title", text: "Exportar" }),
      scale.el,
      slider({
        label: "Margen",
        min: 0,
        max: 200,
        step: 1,
        value: this.exportOptions.margin,
        unit: "px",
        onInput: (v) => {
          this.exportOptions.margin = v;
        },
      }).el,
      toggle({
        label: "Fondo",
        value: this.exportOptions.background,
        hint: "Sin fondo el PNG sale con transparencia.",
        onChange: (v) => {
          this.exportOptions.background = v;
        },
      }).el,
      toggle({
        label: "Incluir materia",
        value: this.exportOptions.matter,
        onChange: (v) => {
          this.exportOptions.matter = v;
        },
      }).el,
      slider({
        label: "Detalle del campo",
        min: 1,
        max: 8,
        step: 0.5,
        decimals: 1,
        value: this.exportOptions.fieldCell,
        gamma: 1.5,
        hint: "Tamano de celda del contorno: mas bajo es mas fiel y mas lento.",
        onInput: (v) => {
          this.exportOptions.fieldCell = v;
        },
      }).el,
      el("div", { class: "popover-divider" }),
      row([
        button({
          label: "PNG",
          iconName: "download",
          variant: "solid",
          onClick: () => {
            void exportImage(this.editor, this.exportOptions).then((m) => this.editor.status(m));
            this.exportPopover.hide();
          },
        }).el,
        button({
          label: "SVG",
          iconName: "download",
          variant: "solid",
          onClick: () => {
            this.editor.status(exportVector(this.editor, this.exportOptions));
            this.exportPopover.hide();
          },
        }).el,
      ]),
      el("p", {
        class: "field-note",
        text: "El SVG sale vectorial: cada copia de simetria reutiliza el mismo trazado.",
      }),
    ]);
  }

  update(state: EditorState): void {
    if (document.activeElement !== this.nameInput && this.nameInput.value !== state.name) {
      this.nameInput.value = state.name;
    }
    this.undoBtn.set(state.history.canUndo);
    this.redoBtn.set(state.history.canRedo);
    this.undoBtn.el.title = state.history.undoLabel
      ? `Deshacer ${state.history.undoLabel} (Ctrl+Z)`
      : "Deshacer (Ctrl+Z)";
    this.redoBtn.el.title = state.history.redoLabel
      ? `Rehacer ${state.history.redoLabel} (Ctrl+Shift+Z)`
      : "Rehacer (Ctrl+Shift+Z)";
    this.runBtn.el.innerHTML = `<span class="btn-glyph">${icon(state.running ? "pause" : "play")}</span>`;
    this.runBtn.setActive(!state.running);
    this.wallsBtn.setActive(state.showWalls);
    this.zoomLabel.textContent = `${num(state.zoom * 100, 0)}%`;
  }

  dispose(): void {
    this.exportPopover.dispose();
  }
}
