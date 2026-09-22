import { Editor, type EditorState } from "../app/editor";
import { el, setClass } from "./dom";
import { autosave, exportImage, exportVector, newDocument, openProject, restoreAutosave, saveProject } from "./file-actions";
import { HelpOverlay } from "./help";
import { StatusBar } from "./status-bar";
import { TopBar } from "./top-bar";
import { RadialMenu } from "./hotbox/radial-menu";
import { PantoneWheel } from "./pantone-wheel";
import { Panels } from "./panels";
import { SideDock } from "./side-dock";

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
  private static readonly PIN_KEY = "drawi.hud.pinned";

  readonly editor: Editor;

  private topBar: TopBar;
  private statusBar: StatusBar;
  private help: HelpOverlay;
  private hotbox: RadialMenu;
  private pantone: PantoneWheel;
  private panels: Panels;
  private sideDock: SideDock;
  private stage: HTMLElement;
  private chrome: HTMLElement;

  private pendingState: EditorState | null = null;
  private frameQueued = false;
  private autosaveTimer = 0;
  private idleTimer = 0;
  private pinned = false;
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
    // El pin se recuerda entre sesiones. Por defecto viene activo (fijado).
    this.pinned = this.readPinnedPref();
    this.statusBar = new StatusBar(this.pinned, (pinned) => this.setPinned(pinned));
    this.pantone = new PantoneWheel((hex) => {
      this.editor.setColor(hex);
      this.wake();
    });
    this.panels = new Panels();
    this.sideDock = new SideDock(this.editor);
    this.hotbox = new RadialMenu(this.editor, {
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
    const hud = el("div", { class: "hud" }, [this.topBar.el, this.statusBar.el, this.statusBar.pinEl, this.topBar.helpBtn]);
    this.chrome = el("div", { class: "chrome" }, [hud]);
    root.appendChild(this.pantone.el);

    const shell = el("div", { class: "shell" }, [this.stage, this.chrome]);
    root.appendChild(shell);
    root.appendChild(this.help.el);
    this.panels.mount(root);
    this.sideDock.mount(root);
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
    this.revealHud();
  }

  /**
   * Entrada del HUD al cargar. Doble rAF a proposito: dejamos que pinte primero
   * oculto (opacity 0) y en el siguiente frame lo despertamos, asi la aparicion
   * se anima de verdad en vez de salir ya puesta. Si venia fijado de sesiones
   * anteriores (o por defecto), se marca is-pinned y wake() no programa el
   * ocultado: entra suave y se queda.
   */
  private revealHud(): void {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (this.pinned) setClass(this.chrome, "is-pinned", true);
        this.wake();
      }),
    );
  }

  private async openFile(): Promise<void> {
    this.editor.status(await openProject(this.editor));
    this.wake();
  }

  /** Despierta la interfaz translucida; se esconde de nuevo tras la inactividad. */
  private wake(): void {
    setClass(this.chrome, "is-awake", true);
    window.clearTimeout(this.idleTimer);
    // Fijado: se queda a la vista, no programamos el ocultado.
    if (this.pinned) return;
    this.idleTimer = window.setTimeout(() => {
      if (!this.hotbox.isOpen) setClass(this.chrome, "is-awake", false);
    }, 2600);
  }

  /** Fija o suelta el HUD. Fijado = siempre visible; suelto = vuelve a aparecer
      y esconderse solo con la inactividad (como al cargar la pagina). */
  private setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.writePinnedPref(pinned);
    setClass(this.chrome, "is-pinned", pinned);
    if (pinned) {
      window.clearTimeout(this.idleTimer);
      setClass(this.chrome, "is-awake", true);
    } else {
      this.wake(); // reanuda el conteo de inactividad
    }
  }

  /** Preferencia del pin persistida. Por defecto activo (fijado) si no hay nada
      guardado. El try/catch cubre el modo privado, donde localStorage lanza. */
  private readPinnedPref(): boolean {
    try {
      const v = window.localStorage.getItem(App.PIN_KEY);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  }

  private writePinnedPref(pinned: boolean): void {
    try {
      window.localStorage.setItem(App.PIN_KEY, pinned ? "1" : "0");
    } catch {
      // Sin almacenamiento (modo privado): el pin sigue funcionando en la sesion.
    }
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
    this.sideDock.update(state);
    document.title = `${state.name} — Zence Draw`;
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
