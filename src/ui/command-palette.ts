import type { Editor } from "../app/editor";
import type { ToolId } from "../tools/types";
import { el, setClass } from "./dom";
import { MateriaEdge } from "./fx/materia-edge";
import { MateriaFx, prefersReducedMotion } from "./fx/materia";
import { icon } from "./icons";
import type { MenuHooks } from "./hotbox/menu";

/** Una orden invocable del paletón: una herramienta o una acción. */
interface Command {
  id: string;
  label: string;
  /** Categoría mostrada a la derecha (Herramienta, Archivo, Vista...). */
  group: string;
  icon?: string;
  /** Términos extra para la búsqueda (sinónimos, nombres en inglés, etc.). */
  keywords?: string;
  run: () => void;
}

// -------------------------------------------------------------- búsqueda difusa

/**
 * Pliega un texto a minúsculas y SIN acentos conservando la longitud (un
 * carácter de entrada → uno de salida). Así los índices que devuelve `fuzzy`
 * siguen señalando las letras correctas del texto original al resaltarlas, y
 * escribir "simetria" encuentra "Simetría".
 */
function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const f = ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    out += f.length ? f[0] : ch.toLowerCase();
  }
  return out;
}

/**
 * Coincidencia por subsecuencia (estilo VSCode/Sublime): las letras de la
 * consulta aparecen en orden dentro del texto, no necesariamente juntas.
 * Devuelve una puntuación (mayor = mejor) y las posiciones acertadas para
 * resaltarlas, o null si no encaja. Premia el inicio de palabra y las letras
 * seguidas; penaliza levemente los textos largos para desempatar.
 */
function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const q = fold(query);
  const t = fold(text);
  if (!q) return { score: 0, hits: [] };
  const hits: number[] = [];
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    hits.push(ti);
    score += prev === ti - 1 ? 6 : 1; // letras consecutivas
    if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "-") score += 9; // inicio de palabra
    prev = ti;
    qi++;
  }
  if (qi < q.length) return null;
  if (t.startsWith(q)) score += 16;
  score -= t.length * 0.05;
  return { score, hits };
}

/**
 * Lista de órdenes, reconstruida en cada apertura para que las etiquetas y los
 * estados reflejen el momento (p. ej. "Pausar" vs "Reanudar"). Las herramientas
 * van primero: el paletón nació para elegirlas escribiendo.
 */
function buildCommands(editor: Editor, hooks: MenuHooks): Command[] {
  const s = editor.state;
  const tool = (id: ToolId, label: string, ic: string, keywords: string): Command => ({
    id: `tool-${id}`,
    label,
    group: "Herramienta",
    icon: ic,
    keywords,
    run: () => editor.setTool(id),
  });

  return [
    tool("brush", "Pincel", "brush", "dibujar trazo pen brush"),
    tool("shape", "Crear forma", "shape", "figura materia crear shape"),
    tool("matter", "Mover materia", "matter", "fisica arrastrar matter mover"),
    tool("symmetry", "Eje de simetria", "symmetry", "espejo mirror symmetry"),
    tool("picker", "Cuentagotas", "picker", "color eyedropper picker muestrear"),
    tool("hand", "Mano", "hand", "desplazar pan mover vista"),

    { id: "color-wheel", label: "Rueda de color", group: "Color", icon: "wheel", keywords: "color paleta wheel picker", run: () => hooks.toggleWheel() },

    { id: "run", label: s.running ? "Pausar simulacion" : "Reanudar simulacion", group: "Materia", icon: s.running ? "pause" : "play", keywords: "fisica play pausa simular", run: () => editor.setRunning(!editor.state.running) },
    { id: "seed", label: "Sembrar materia", group: "Materia", icon: "seed", keywords: "crear cuerpos seed", run: () => editor.seedMatter(8) },
    { id: "bake", label: "Hornear materia", group: "Materia", icon: "bake", keywords: "fijar bake congelar", run: () => editor.bakeMatter() },
    { id: "walls", label: "Paredes", group: "Materia", icon: "grid", keywords: "limites bordes walls", run: () => editor.toggleWalls() },
    { id: "clear-matter", label: "Vaciar materia", group: "Materia", icon: "trash", keywords: "borrar limpiar clear", run: () => editor.clearMatter() },

    { id: "undo", label: "Deshacer", group: "Editar", icon: "undo", keywords: "undo atras", run: () => editor.undo() },
    { id: "redo", label: "Rehacer", group: "Editar", icon: "redo", keywords: "redo adelante", run: () => editor.redo() },

    { id: "zoom-in", label: "Acercar", group: "Vista", icon: "zoomIn", keywords: "zoom in acercar", run: () => editor.zoomBy(1.25) },
    { id: "zoom-out", label: "Alejar", group: "Vista", icon: "zoomOut", keywords: "zoom out alejar", run: () => editor.zoomBy(1 / 1.25) },
    { id: "fit", label: "Encajar en pantalla", group: "Vista", icon: "fit", keywords: "fit encajar ajustar", run: () => editor.fitView() },
    { id: "reset-view", label: "Reiniciar vista", group: "Vista", icon: "grid", keywords: "reset centrar vista", run: () => editor.resetView() },

    { id: "new", label: "Nuevo documento", group: "Archivo", icon: "trash", keywords: "new nuevo limpiar", run: () => hooks.newDoc() },
    { id: "open", label: "Abrir", group: "Archivo", icon: "folder", keywords: "open abrir cargar", run: () => hooks.openFile() },
    { id: "save", label: "Guardar", group: "Archivo", icon: "save", keywords: "save guardar", run: () => hooks.save() },
    { id: "png", label: "Exportar PNG", group: "Archivo", icon: "download", keywords: "export png imagen", run: () => hooks.exportPng() },
    { id: "svg", label: "Exportar SVG", group: "Archivo", icon: "download", keywords: "export svg vector", run: () => hooks.exportSvg() },
    { id: "help", label: "Atajos y ayuda", group: "Archivo", icon: "info", keywords: "help ayuda atajos", run: () => hooks.help() },
  ];
}

/**
 * Paletón de órdenes.
 *
 * Se abre con Ctrl/Cmd+K: un cuadro flotante donde escribes y la herramienta (o
 * acción) más cercana se filtra y se selecciona sin buscarla en el menú radial.
 * Enter la ejecuta, ↑/↓ mueven el resaltado, Esc cierra.
 *
 * Comparte el lenguaje visual del resto y, en concreto, la entrada/salida del
 * panel de ayuda: las mismas partículas (MateriaFx) forman y deshacen el cuadro,
 * y su piel es un borde vivo ondulante (MateriaEdge, sus cuatro lados porque el
 * cuadro flota) igual que el de los paneles laterales. Así toda la interfaz se
 * siente hecha de la misma materia.
 */
export class CommandPalette {
  readonly el: HTMLElement;
  private open = false;

  private editor: Editor;
  private hooks: MenuHooks;

  private dialog: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  private edge: MateriaEdge;
  /** Partículas (metaball) que forman/deshacen el cuadro. Sistema compartido. */
  private fx: MateriaFx;
  private fxTimer = 0;
  /** Segundo tiempo: revela el buscador una vez la caja está llena. */
  private revealTimer = 0;
  /** Temporizador de la cascada fila a fila (solo al abrir). */
  private rowCascadeTimer = 0;

  private commands: Command[] = [];
  /** Órdenes visibles tras el filtrado, en el orden mostrado. */
  private filtered: Command[] = [];
  private rows: HTMLElement[] = [];
  private activeIndex = -1;
  private query = "";

  constructor(editor: Editor, hooks: MenuHooks) {
    this.editor = editor;
    this.hooks = hooks;

    this.input = el("input", {
      class: "cmd-input",
      type: "text",
      placeholder: "Buscar herramienta o accion…",
      aria: { label: "Buscar herramienta o accion" },
    }) as HTMLInputElement;
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.renderResults();
    });

    const head = el("div", { class: "cmd-head cmd-rise" }, [
      el("span", { class: "cmd-search-ico", html: icon("search") }),
      this.input,
      el("span", { class: "cmd-hint", html: `Enter ${icon("enter")}` }),
    ]);

    this.results = el("ul", { class: "cmd-results cmd-rise", role: "listbox" });
    (this.results.style as CSSStyleDeclaration).setProperty("--i", "1");

    const content = el("div", { class: "cmd-content" }, [head, this.results]);

    // Piel: relleno del cuadro como SVG vectorial con los cuatro bordes vivos,
    // igual que la del panel de ayuda. Mismo negro (#161619) que el dock, los
    // paneles laterales y el menú radial.
    this.edge = new MateriaEdge({ fill: "#161619", radius: 22, amplitude: 9, inset: 16, full: true });
    this.edge.el.classList.add("cmd-skin");

    this.dialog = el("div", { class: "cmd-dialog", role: "dialog", aria: { label: "Paleta de ordenes" } }, [
      this.edge.el,
      content,
    ]);

    // Capa de partículas: hermana del diálogo, para que la opacidad del cuadro al
    // abrir/cerrar no la afecte. Núcleo REDONDO y pequeño en el centro, como el
    // menú radial: la masa "aparece desde el centro". Nada de gotas repartidas por
    // el perímetro (eso daba el remolino que da la vuelta); solo un blob central
    // que luego el cuadro, al crecer, rebasa hasta llenar los bordes.
    this.fx = new MateriaFx({ coreSize: 120, reach: 86, dots: 16, solidCore: true, gatherMs: 340, scatterMs: 300 });

    this.el = el("div", { class: "cmd-overlay" }, [this.fx.el, this.dialog]);
    this.el.hidden = true;

    // Clic fuera del cuadro: cerrar.
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.hide();
    });
    // Teclado del paletón (burbujea desde el input): navegar, ejecutar, cerrar.
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.el.hidden = false;
    this.open = true;

    // Órdenes al día (etiquetas y estados frescos) y filtro en limpio.
    this.commands = buildCommands(this.editor, this.hooks);
    this.query = "";
    this.input.value = "";
    this.renderResults();

    window.clearTimeout(this.fxTimer);
    window.clearTimeout(this.revealTimer);
    window.clearTimeout(this.rowCascadeTimer);
    this.results.classList.remove("is-entering");
    this.dialog.classList.remove("is-closing", "is-forming");
    this.setRevealed(false);
    this.edge.start();

    if (prefersReducedMotion()) {
      // Sin movimiento: aparición directa, sin partículas ni cascada.
      this.el.classList.add("is-visible");
      this.setRevealed(true);
      this.fx.clear();
      this.focusInput();
      return;
    }

    // El fondo entra con su propia transición; un reflow fija el estado oculto
    // antes de marcar .is-visible para que el navegador anime el fundido.
    void this.el.offsetWidth;
    this.el.classList.add("is-visible");

    // Centrar el núcleo en el centro del cuadro (a tamaño real) para que la masa
    // aparezca justo donde nacerá el buscador.
    this.syncFxToDialog();

    // Secuencia en tres tiempos, como pidió el usuario:
    //  1) La masa se forma en el CENTRO (núcleo redondo, como el menú radial): la
    //     caja espera diminuta ahí (.is-forming = scale minúsculo).
    //  2) Hecha la masa, la caja CRECE desde el centro hasta llenar los bordes
    //     (quitar .is-forming: el diálogo se escala hasta 1 con un rebote suave) y
    //     el núcleo se funde con ella (fadeOut) —relevo continuo—.
    //  3) Cuando la caja ya está llena, APARECE el buscador: el contenido entra en
    //     cascada y la lista cuaja fila a fila.
    this.dialog.classList.add("is-forming");
    this.fx.gather();

    this.fxTimer = window.setTimeout(() => {
      if (!this.open) return;
      this.dialog.classList.remove("is-forming"); // la caja crece hasta los bordes
      this.fx.fadeOut();
      this.revealTimer = window.setTimeout(() => {
        if (!this.open) return;
        this.setRevealed(true);
        this.playRowCascade();
        this.focusInput();
      }, 400);
    }, this.fx.gatherMs);
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;

    window.clearTimeout(this.fxTimer);
    window.clearTimeout(this.revealTimer);
    window.clearTimeout(this.rowCascadeTimer);
    this.results.classList.remove("is-entering");
    this.dialog.classList.remove("is-forming");
    this.input.blur();
    // El contenido se recoge de inmediato para que el cuadro quede "vacío" antes
    // de desintegrarse: primero se va el texto, luego la masa.
    this.setRevealed(false);
    this.edge.collapse();

    if (prefersReducedMotion()) {
      this.el.classList.remove("is-visible");
      this.el.hidden = true;
      this.dialog.classList.remove("is-closing");
      return;
    }

    this.el.classList.remove("is-visible");

    // El cuadro se desintegra en partículas al irse: sale como entró. Se mide
    // aún a tamaño real (no se le ha aplicado el scale de salida).
    this.syncFxToDialog();
    this.dialog.classList.add("is-closing");
    this.fx.scatter();

    this.fxTimer = window.setTimeout(() => {
      if (this.open) return;
      this.el.hidden = true;
      this.dialog.classList.remove("is-closing");
      this.fx.clear();
    }, this.fx.scatterMs);
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.setActive(this.activeIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.setActive(this.activeIndex - 1);
        break;
      case "Tab":
        e.preventDefault();
        this.setActive(this.activeIndex + (e.shiftKey ? -1 : 1));
        break;
      case "Enter":
        e.preventDefault();
        this.runActive();
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        break;
      default:
        break;
    }
  }

  private focusInput(): void {
    // Enfocar sin desplazar el cuadro recién formado.
    this.input.focus({ preventScroll: true });
  }

  /** Filtra las órdenes por la consulta y repinta la lista. */
  private renderResults(): void {
    const q = this.query.trim();
    let picked: Array<{ cmd: Command; hits: number[] }>;

    if (!q) {
      // Sin consulta: todas, en el orden declarado (herramientas primero).
      picked = this.commands.map((cmd) => ({ cmd, hits: [] }));
    } else {
      const scored: Array<{ cmd: Command; hits: number[]; score: number }> = [];
      for (const cmd of this.commands) {
        // Se puntúa contra la etiqueta (con resaltado) y, si falla, contra grupo +
        // sinónimos (sin resaltar, y con menos peso) para que "espejo" o "mirror"
        // encuentren Simetría sin ensuciar el resaltado de la etiqueta.
        const label = fuzzy(q, cmd.label);
        if (label) {
          scored.push({ cmd, hits: label.hits, score: label.score });
          continue;
        }
        const alt = fuzzy(q, `${cmd.group} ${cmd.keywords ?? ""}`);
        if (alt) scored.push({ cmd, hits: [], score: alt.score - 8 });
      }
      scored.sort((a, b) => b.score - a.score);
      picked = scored;
    }

    this.filtered = picked.map((p) => p.cmd);
    this.rows = [];
    this.results.innerHTML = "";
    // Escribir cancela la cascada de apertura: los resultados filtrados aparecen al
    // instante, no fila a fila (eso solo pasa al abrir, vía playRowCascade).
    window.clearTimeout(this.rowCascadeTimer);
    this.results.classList.remove("is-entering");

    if (picked.length === 0) {
      this.results.appendChild(el("li", { class: "cmd-empty", text: "Sin resultados" }));
      this.activeIndex = -1;
      return;
    }

    picked.forEach(({ cmd, hits }, k) => {
      const row = el("li", { class: "cmd-row", role: "option" }, [
        el("span", { class: "cmd-ico", html: cmd.icon ? icon(cmd.icon) : "" }),
        this.renderLabel(cmd.label, hits),
        el("span", { class: "cmd-group", text: cmd.group }),
      ]);
      // Índice para escalonar la entrada fila a fila al abrir (--row).
      row.style.setProperty("--row", String(k));
      row.addEventListener("pointermove", () => this.setActive(k));
      row.addEventListener("click", () => {
        this.setActive(k);
        this.runActive();
      });
      this.rows.push(row);
      this.results.appendChild(row);
    });

    this.setActive(0);
  }

  /** Etiqueta con las letras acertadas envueltas en &lt;mark&gt; para resaltarlas. */
  private renderLabel(label: string, hits: number[]): HTMLElement {
    const span = el("span", { class: "cmd-label" });
    if (hits.length === 0) {
      span.textContent = label;
      return span;
    }
    const set = new Set(hits);
    [...label].forEach((ch, i) => {
      if (set.has(i)) span.appendChild(el("mark", { class: "cmd-hit", text: ch }));
      else span.appendChild(document.createTextNode(ch));
    });
    return span;
  }

  private setActive(i: number): void {
    const n = this.filtered.length;
    if (n === 0) {
      this.activeIndex = -1;
      return;
    }
    this.activeIndex = ((i % n) + n) % n; // envuelve arriba/abajo
    this.rows.forEach((r, idx) => setClass(r, "is-active", idx === this.activeIndex));
    this.rows[this.activeIndex]?.scrollIntoView({ block: "nearest" });
  }

  private runActive(): void {
    const cmd = this.filtered[this.activeIndex];
    if (!cmd) return;
    // Cerrar primero (arranca la salida por partículas) y luego ejecutar: si la
    // orden abre otro panel o diálogo, el paletón ya está saliendo de escena.
    this.hide();
    cmd.run();
  }

  /** Activa/desactiva la cascada del contenido (clase en el contenedor raíz). */
  private setRevealed(on: boolean): void {
    this.dialog.classList.toggle("is-revealed", on);
  }

  /**
   * Escalona la entrada de las filas al abrir: cada una sube y aparece con un
   * pequeño retardo (--row) mientras el cuadro se forma, para que la lista "cuaje"
   * de arriba abajo en vez de plantarse entera. Solo al abrir; escribir la cancela
   * (renderResults quita la clase) para que el filtrado sea instantáneo.
   */
  private playRowCascade(): void {
    window.clearTimeout(this.rowCascadeTimer);
    this.results.classList.add("is-entering");
    const last = this.rows.length - 1;
    const ms = 360 + Math.min(last, 10) * 26;
    this.rowCascadeTimer = window.setTimeout(() => {
      this.results.classList.remove("is-entering");
    }, ms);
  }

  /**
   * Centra las partículas en el diálogo. El núcleo es REDONDO (no rectangular): la
   * masa nace como un blob en el centro, igual que el menú radial, y es el cuadro
   * el que al crecer llena los bordes. Por eso NO se le pasa `setRect`: un
   * rectángulo con gotas por el perímetro daba el remolino que el usuario no quería.
   */
  private syncFxToDialog(): void {
    const r = this.dialog.getBoundingClientRect();
    if (r.width > 0) {
      this.fx.center(r.left + r.width / 2, r.top + r.height / 2);
    } else {
      this.fx.center(window.innerWidth / 2, window.innerHeight / 2);
    }
  }


}
