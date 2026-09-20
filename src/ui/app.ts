import { Editor, type EditorState } from "../app/editor";
import { DEFAULT_PALETTES } from "../core/color";
import { el, setClass } from "./dom";
import { autosave, exportImage, exportVector, newDocument, openProject, restoreAutosave, saveProject } from "./file-actions";
import { HelpOverlay } from "./help";
import { StatusBar } from "./status-bar";
import { TopBar } from "./top-bar";
import { ColorPicker } from "./color-picker";
import { segmented, swatches } from "./controls";
import { RadialMenu } from "./hotbox/radial-menu";
import { PantoneWheel } from "./pantone-wheel";
import { Panels } from "./panels";

/**
 * Montaje de la aplicacion — lienzo vivo.
 *
 * Aqui no hay barra de herramientas ni panel lateral permanentes: el lienzo
 * ocupa todo y las herramientas emergen bajo el cursor a traves del hotbox
 * (clic derecho, tecla Q, boton del lapiz). La barra superior y la de estado
 * flotan translucidas y se esconden mientras dibujas, para que al abrir la app
 * lo unico que invita a hacer algo sea el lienzo.
 */
export class App {
  readonly editor: Editor;

  private topBar: TopBar;
  private statusBar: StatusBar;
  private help: HelpOverlay;
  private hotbox: RadialMenu;
  private pantone: PantoneWheel;
  private panels: Panels;
  private stage: HTMLElement;
  private chrome: HTMLElement;

  private pendingState: EditorState | null = null;
  private frameQueued = false;
  private autosaveTimer = 0;
  private idleTimer = 0;
  private lastPointer = { x: 0, y: 0 };
  private keyHandler: (e: KeyboardEvent) => void;
  private pointerHandler: (e: PointerEvent) => void;

  constructor(root: HTMLElement) {
    this.stage = el("div", { class: "stage" });
    const canvasHost = el("div", { class: "canvas-host" });
    this.stage.appendChild(canvasHost);

    this.editor = new Editor(canvasHost);
    this.help = new HelpOverlay();
    this.topBar = new TopBar(this.editor, () => this.help.toggle());
    this.statusBar = new StatusBar();
    this.pantone = new PantoneWheel((hex) => {
      this.editor.setColor(hex);
      this.wake();
    });
    this.panels = new Panels();
    this.hotbox = new RadialMenu(this.editor, {
      openColor: () => this.openColorPanel(),
      toggleWheel: () => this.pantone.toggle(),
      help: () => this.help.toggle(),
      newDoc: () => this.editor.status(newDocument(this.editor)),
      openFile: () => this.openFile(),
      save: () => this.editor.status(saveProject(this.editor)),
      exportPng: () => void exportImage(this.editor).then((m) => this.editor.status(m)),
      exportSvg: () => this.editor.status(exportVector(this.editor)),
    }, this.panels);

    // HUD superior derecho: barra de acciones + información de estado. La
    // legibilidad sobre cualquier fondo la da mix-blend-mode: difference en el
    // CSS (invierte cada píxel del texto contra el color del lienzo debajo);
    // por eso .chrome no lleva z-index, para no aislar el HUD del lienzo.
    const hud = el("div", { class: "hud" }, [this.topBar.el, this.statusBar.el]);
    this.chrome = el("div", { class: "chrome" }, [hud]);
    root.appendChild(this.pantone.el);

    const shell = el("div", { class: "shell" }, [this.stage, this.chrome]);
    root.appendChild(shell);
    root.appendChild(this.help.el);
    this.panels.mount(root);
    this.hotbox.mount(root);

    this.editor.events.on("state", (s) => this.queue(s));
    this.editor.events.on("status", (m) => this.statusBar.setMessage(m));
    this.editor.events.on("dirty", () => this.scheduleAutosave());

    // ------- invocaciones del hotbox
    this.stage.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.hotbox.show(e.clientX, e.clientY);
    });
    this.pointerHandler = (e: PointerEvent) => {
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.wake();
    };
    window.addEventListener("pointermove", this.pointerHandler, { passive: true });

    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        this.help.toggle();
        return;
      }
      // Q: el hotbox donde este el cursor. Es el atajo de teclado del pie menu.
      if (e.key === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const p = this.lastPointer;
        this.hotbox.show(p.x || window.innerWidth / 2, p.y || window.innerHeight / 2);
        return;
      }
      if ((e.key === "x" || e.key === "X") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const ink = this.editor.color;
        const bg = this.editor.doc.meta.background;
        this.editor.setColor(bg);
        this.editor.setBackground(ink);
        this.editor.status(`Intercambio color ⇄ fondo`);
        this.wake();
        return;
      }
    };
    window.addEventListener("keydown", this.keyHandler);
    window.addEventListener("beforeunload", () => autosave(this.editor));

    if (restoreAutosave(this.editor)) {
      this.editor.status("Sesion anterior recuperada");
    } else {
      this.editor.status("Dibuja. Clic derecho o Q para las herramientas.");
    }
    this.queue(this.editor.state);
    this.wake();
  }

  private async openFile(): Promise<void> {
    this.editor.status(await openProject(this.editor));
    this.wake();
  }

  private openColorPanel(): void {
    const p = this.lastPointer;
    this.panels.open({
      id: "color",
      title: "Color",
      build: (host) => this.mountColor(host),
    }, p.x || window.innerWidth / 2, p.y || window.innerHeight / 2);
    this.wake();
  }

  /**
   * Panel de color: selector, rueda Pantone y muestras de la paleta activa.
   */
  private mountColor(host: HTMLElement): () => void {
    const picker = new ColorPicker(this.editor.color, (hex) => this.editor.setColor(hex));
    const paletteTabs = segmented({
      options: DEFAULT_PALETTES.map((p, i) => ({ value: String(i), label: p.name })),
      value: String(this.editor.paletteIndex),
      onChange: (v) => {
        this.editor.setPalette(Number(v));
        wells.set({ colors: this.editor.palette.colors, value: this.editor.color });
      },
    });
    const wells = swatches({
      colors: this.editor.palette.colors,
      value: this.editor.color,
      onPick: (hex) => {
        this.editor.setColor(hex);
        picker.set(hex);
      },
    });
    const panel = el("div", { class: "hot-color" }, [
      el("h3", { class: "hot-color-title", text: "Color" }),
      picker.el,
      paletteTabs.el,
      wells.el,
    ]);
    host.appendChild(panel);
    return () => panel.remove();
  }

  /** Despierta la interfaz translucida; se esconde de nuevo tras la inactividad. */
  private wake(): void {
    setClass(this.chrome, "is-awake", true);
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (!this.hotbox.isOpen) setClass(this.chrome, "is-awake", false);
    }, 2600);
  }

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
    this.statusBar.update(state);
    document.title = `${state.name} — drawi`;
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => autosave(this.editor), 1500);
  }

  startStatusPolling(): void {
    const tick = (): void => {
      this.statusBar.update(this.editor.state);
      window.setTimeout(tick, 250);
    };
    window.setTimeout(tick, 250);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("pointermove", this.pointerHandler);
    this.topBar.dispose();
    this.hotbox.dispose();
    this.pantone.dispose();
    this.panels.dispose();
    this.editor.dispose();
  }
}
