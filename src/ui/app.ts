import { Editor, type EditorState } from "../app/editor";
import { Diagnostics } from "../app/diagnostics";
import { el, setClass } from "./dom";
import { autosave, exportImage, exportVector, newDocument, openProject, restoreAutosave, saveProject } from "./file-actions";
import { HelpOverlay } from "./help";
import { StatusBar } from "./status-bar";
import { TopBar } from "./top-bar";
import { RadialMenu } from "./hotbox/radial-menu";
import { RadialChips } from "./hotbox/radial-chips";
import type { MenuHooks } from "./hotbox/menu";
import { CommandPalette } from "./command-palette";
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
  private radialChips: RadialChips;
  private commandPalette: CommandPalette;
  private pantone: PantoneWheel;
  private panels: Panels;
  private sideDock: SideDock;
  private diagnostics: Diagnostics;
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
    this.statusBar = new StatusBar(
      this.pinned,
      (pinned) => this.setPinned(pinned),
      () => {
        this.editor.toggleEngine();
        this.wake();
      },
    );
    this.pantone = new PantoneWheel(
      (hex) => {
        this.editor.setColor(hex);
        this.wake();
      },
      () => {
        this.editor.swapColors();
        this.editor.status("Intercambio color ⇄ secundario");
        this.wake();
      },
    );
    this.panels = new Panels();
    this.sideDock = new SideDock(this.editor, () => {
      this.pantone.open();
      this.editor.status("Rueda de color");
      this.wake();
    });
    // Panel de diagnóstico del render (Ctrl+Alt+D). También accesible desde la
    // consola como `window.__drawiDiag` para inspeccionar el pipeline en vivo.
    this.diagnostics = new Diagnostics(this.editor);
    (window as unknown as { __drawiDiag: Diagnostics }).__drawiDiag = this.diagnostics;
    // También el editor crudo, para volcar el estado del campo desde consola.
    (window as unknown as { __drawiEditor: Editor }).__drawiEditor = this.editor;
    // Puertos de alto nivel compartidos por el menú radial y el paletón: ambos
    // solo declaran intención y es la app quien la resuelve (panel, diálogo...).
    const hooks: MenuHooks = {
      toggleWheel: () => {
        this.pantone.keyToggle();
        this.editor.status(this.pantone.isShowing ? "Rueda de color" : "Rueda cerrada");
      },
      help: () => this.help.toggle(),
      newDoc: () => this.editor.status(newDocument(this.editor)),
      openFile: () => this.openFile(),
      importImage: () => void this.importImageViaPicker().then(() => this.wake()),
      save: () => this.editor.status(saveProject(this.editor)),
      exportPng: () => void exportImage(this.editor).then((m) => this.editor.status(m)),
      exportSvg: () => this.editor.status(exportVector(this.editor)),
    };
    this.hotbox = new RadialMenu(this.editor, hooks, this.panels);

    // Trozos arrancables: viven en una capa flotante propia. El menú arranca un
    // sector (long-press) → spawn; un trozo-submenú reabre el menú expandido ahí.
    this.radialChips = new RadialChips(this.editor, hooks);
    this.hotbox.onTearOff = (desc) => this.radialChips.spawn(desc);
    this.radialChips.onReopenMenu = (path, x, y) => this.hotbox.show(x, y, path);

    // El paletón se alimenta del mismo esquema que dock y radial. Sus dos verbos
    // se resuelven aquí: abrir la opción en su pestaña del dock, o hacerla nacer
    // como chip centrado en la pantalla (igual que el desgarro del radial).
    this.commandPalette = new CommandPalette(this.editor, hooks, {
      openPanel: (tab, fieldId) => this.sideDock.reveal(tab, fieldId),
      spawnChip: (path, id) => this.radialChips.spawnByPath(path, id, window.innerWidth / 2, window.innerHeight / 2),
    });

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
    this.radialChips.mount(root);
    this.commandPalette.mount(root);

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
      // Ctrl/Cmd+K: el paletón de órdenes. Va antes del filtro de INPUT/TEXTAREA
      // para poder alternarlo (abrir/cerrar) también desde su propio campo de texto.
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        this.commandPalette.toggle();
        return;
      }
      // Ctrl+Alt+D: panel de diagnóstico del render. Antes del filtro de INPUT
      // para poder alternarlo desde cualquier sitio.
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        this.diagnostics.toggle();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      // Tab abre el paletón de órdenes (buscar la herramienta escribiendo). Va tras
      // el filtro de INPUT para no robar el tabulado de un campo; dentro del propio
      // paletón su input maneja Tab para navegar la lista, así que aquí solo abre
      // cuando está cerrado. Ctrl/Cmd+K (arriba) sigue funcionando como alternativa.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !this.commandPalette.isOpen) {
        e.preventDefault();
        this.commandPalette.show();
        return;
      }
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
      // R: abre/cierra la rueda de color flotante RESPETANDO el pin: si está
      // fijada, solo contrae/expande el anillo (la bolita queda); si no, la
      // muestra/oculta entera. Mismo verbo que la acción "Rueda" del radial.
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.pantone.keyToggle();
        this.editor.status(this.pantone.isShowing ? "Rueda de color" : "Rueda cerrada");
        this.wake();
        return;
      }
      // X: intercambia el color activo ⇄ el secundario (como en Photoshop).
      if ((e.key === "x" || e.key === "X") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.editor.swapColors();
        this.editor.status(`Intercambio color ⇄ secundario`);
        this.wake();
        return;
      }
      // C: intercambia el color activo ⇄ el fondo (lo que antes hacía la X).
      if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey) {
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

    this.bindImageDropAndPaste();
    if (restoreAutosave(this.editor)) {
      this.editor.status("Sesion anterior recuperada");
    } else {
      this.editor.status("Dibuja. Clic derecho o Q para las herramientas; Tab para buscarlas.");
    }
    this.queue(this.editor.state);
    this.revealHud();
    // Restaurar los trozos guardados una vez el editor tiene su estado.
    this.radialChips.restore();
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

  private async importImageViaPicker(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/jpg,image/webp,image/gif,image/bmp,.psd,.jpc,.jp2";
    input.multiple = true;
    const picked: File[] | null = await new Promise((resolve) => {
      input.addEventListener("change", () => {
        if (!input.files || input.files.length === 0) resolve(null);
        else resolve([...input.files]);
        setTimeout(() => input.remove(), 0);
      });
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.click();
    });
    if (!picked) return;
    await this.handleImageFiles(picked);
  }

  private async handleImageFiles(files: File[]): Promise<void> {
    const { importImageFile, isImageFile } = await import("../io/image-import");
    const before = this.editor.doc.snapshot();
    const viewCenter = { x: this.editor.camera.x, y: this.editor.camera.y };
    let ok = 0;
    for (const f of files) {
      if (!isImageFile(f)) continue;
      try {
        const n = await importImageFile(f, this.editor.doc, viewCenter);
        if (n > 0) ok += n;
      } catch (e) {
        console.warn("[import]", e);
      }
    }
    if (ok > 0) {
      this.editor.history.record(ok > 1 ? `Importar ${ok} imágenes` : "Importar imagen", before);
      this.editor.invalidateAll();
      this.editor.emitState();
      this.editor.events.emit("dirty", undefined);
      this.editor.status(ok > 1 ? `${ok} imágenes importadas` : "Imagen importada");
      this.wake();
    } else {
      this.editor.status("Nada que importar");
    }
  }

  private bindImageDropAndPaste(): void {
    const host = this.stage as HTMLElement;
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer) return;
      const hasImage = [...e.dataTransfer.items].some((it) => it.kind === "file" && it.type.startsWith("image/")) || [...(e.dataTransfer.files ?? [])].some((f) => f.name.match(/\.(png|jpe?g|webp|gif|bmp|psd|jpc|jp2)$/i));
      if (hasImage) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        host.classList.add("is-drop-target");
      }
    };
    const onDragLeave = (): void => host.classList.remove("is-drop-target");
    const onDrop = async (e: DragEvent): Promise<void> => {
      host.classList.remove("is-drop-target");
      const files = [...(e.dataTransfer?.files ?? [])] as File[];
      if (files.length === 0) return;
      e.preventDefault();
      await this.handleImageFiles(files);
    };
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("dragleave", onDragLeave);
    host.addEventListener("drop", onDrop as unknown as EventListener);

    // Paste: intercept images from clipboard (Ctrl+V) — create unlocked image layer(s).
    window.addEventListener("paste", async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const items = [...(e.clipboardData?.items ?? [])];
      const imageItems = items.filter((it) => it.type.startsWith("image/"));
      if (imageItems.length === 0) {
        // Also check files
        const files = [...(e.clipboardData?.files ?? [])] as File[];
        if (files.length === 0) return;
        const imageFiles = files.filter((f) => f.type.startsWith("image/") || f.name.match(/\.(png|jpe?g|webp|gif|bmp|psd)$/i));
        if (imageFiles.length === 0) return;
        e.preventDefault();
        await this.handleImageFiles(imageFiles);
        return;
      }
      e.preventDefault();
      const files: File[] = [];
      for (const it of imageItems) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      if (files.length > 0) await this.handleImageFiles(files);
    });
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
    // La rueda de color refleja el color activo (hub) y el secundario (círculo
    // sobrepuesto) para poder intercambiarlos desde ahí igual que con la tecla X.
    this.pantone.reflect(state.color, state.secondaryColor);
    // Los trozos flotantes también reflejan el estado (un dial cambiado en otro
    // sitio repinta su arco); se salta el trozo que se esté arrastrando.
    this.radialChips.syncFromEditor();
    document.title = `${state.name} · Zence Draw`;
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
    this.radialChips.dispose();
    this.pantone.dispose();
    this.panels.dispose();
    this.editor.dispose();
  }
}
