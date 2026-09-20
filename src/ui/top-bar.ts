import type { Editor, EditorState } from "../app/editor";
import { button } from "./controls";
import { blurSoon, el, num } from "./dom";

/**
 * Barra superior: documento, historial, vista, simulacion y archivo.
 *
 * Las acciones destructivas piden confirmacion solo cuando hay algo que perder;
 * confirmar sobre un lienzo vacio es ruido.
 */
export class TopBar {
  readonly el: HTMLElement;

  private nameInput: HTMLInputElement;
  private undoBtn: ReturnType<typeof button>;
  private redoBtn: ReturnType<typeof button>;
  private zoomLabel: HTMLButtonElement;
  private onHelp: () => void;

  constructor(editor: Editor, onHelp: () => void) {
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

    this.el = el("header", { class: "topbar" }, [
      el("div", { class: "topbar-group topbar-brand" }, [
        el("span", { class: "brand-mark", text: "drawi" }),
        this.nameInput,
      ]),
      el("div", { class: "topbar-group" }, [this.undoBtn.el, this.redoBtn.el]),
      el("div", { class: "topbar-group" }, [
        this.zoomLabel,
        button({ iconName: "help", title: "Atajos y ayuda", onClick: () => this.onHelp() }).el,
      ]),
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
    this.zoomLabel.textContent = `${num(state.zoom * 100, 0)}%`;
  }

  dispose(): void {
    // Limpieza si es necesaria
  }
}
