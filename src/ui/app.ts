import { Editor, type EditorState } from "../app/editor";
import { el } from "./dom";
import { autosave, restoreAutosave } from "./file-actions";
import { HelpOverlay } from "./help";
import { Inspector } from "./inspector";
import { StatusBar } from "./status-bar";
import { ToolRail } from "./tool-rail";
import { TopBar } from "./top-bar";

/**
 * Montaje de la aplicacion.
 *
 * El lienzo se crea antes de cualquier panel para que el editor mida su tamano
 * real desde el primer fotograma, y la UI se actualiza en un microtask agrupado:
 * durante un trazo llegan muchos cambios de estado seguidos y no tiene sentido
 * tocar el DOM mas de una vez por fotograma.
 */
export class App {
  readonly editor: Editor;

  private topBar: TopBar;
  private rail: ToolRail;
  private inspector: Inspector;
  private statusBar: StatusBar;
  private help: HelpOverlay;
  private stage: HTMLElement;
  private pendingState: EditorState | null = null;
  private frameQueued = false;
  private autosaveTimer = 0;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement) {
    this.stage = el("div", { class: "stage" });
    const canvasHost = el("div", { class: "canvas-host" });
    this.stage.appendChild(canvasHost);

    this.editor = new Editor(canvasHost);
    this.help = new HelpOverlay();
    this.topBar = new TopBar(this.editor, () => this.help.toggle());
    this.rail = new ToolRail(this.editor);
    this.inspector = new Inspector(this.editor);
    this.statusBar = new StatusBar();

    const shell = el("div", { class: "shell" }, [
      this.topBar.el,
      el("div", { class: "workspace" }, [this.rail.el, this.stage, this.inspector.el]),
      this.statusBar.el,
    ]);
    root.appendChild(shell);
    root.appendChild(this.help.el);

    this.editor.events.on("state", (s) => this.queue(s));
    this.editor.events.on("status", (m) => this.statusBar.setMessage(m));
    this.editor.events.on("dirty", () => this.scheduleAutosave());

    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        this.help.toggle();
        return;
      }
      if (e.key === "x" && !e.ctrlKey && !e.metaKey) {
        const ink = this.editor.color;
        const bg = this.editor.doc.meta.background;
        this.editor.setColor(bg);
        this.editor.setBackground(ink);
      }
    };
    window.addEventListener("keydown", this.keyHandler);

    window.addEventListener("beforeunload", () => autosave(this.editor));

    if (restoreAutosave(this.editor)) {
      this.editor.status("Sesion anterior recuperada");
    } else {
      this.editor.status("Dibuja con el lapiz. Pulsa ? para ver los atajos.");
    }
    this.queue(this.editor.state);
  }

  /** Agrupa los cambios de estado en un solo repintado de la UI. */
  private queue(state: EditorState): void {
    this.pendingState = state;
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      const s = this.pendingState;
      this.pendingState = null;
      if (s) this.apply(s);
    });
  }

  private apply(state: EditorState): void {
    this.topBar.update(state);
    this.rail.update(state);
    this.inspector.update(state);
    this.statusBar.update(state);
    document.title = `${state.name} — drawi`;
  }

  /**
   * Autoguardado perezoso.
   *
   * Serializar la escena en cada trazo se nota al dibujar rapido, asi que se
   * espera a que haya una pausa de un segundo y medio: para cuando el usuario
   * levanta el lapiz a pensar, ya esta guardado.
   */
  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => autosave(this.editor), 1500);
  }

  /** Refresca el marcador del lapiz aunque no cambie el estado del editor. */
  startStatusPolling(): void {
    const tick = (): void => {
      this.statusBar.update(this.editor.state);
      window.setTimeout(tick, 250);
    };
    window.setTimeout(tick, 250);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.keyHandler);
    this.topBar.dispose();
    this.rail.dispose();
    this.editor.dispose();
  }
}
