import type { Editor } from "../app/editor";
import { el, setClass } from "./dom";
import { MateriaEdge } from "./fx/materia-edge";
import { MateriaFx, prefersReducedMotion } from "./fx/materia";
import { icon } from "./icons";
import type { MenuHooks } from "./hotbox/menu";
import { buildCommands, type Command } from "./model/to-commands";

/**
 * Puertos del paletón hacia el resto de la app: abrir la opción en su panel del
 * dock, o hacerla nacer como chip en el lienzo. Los cablea `app.ts` (dock y
 * chips radiales); el paletón no conoce esas piezas, solo estos dos verbos.
 */
export interface PalettePorts {
  /** Abre la pestaña del dock indicada y resalta el campo. */
  openPanel(dockTab: string, fieldId: string): void;
  /** Nace un chip en el lienzo para el nodo del camino radial dado. */
  spawnChip(path: number[], id: string): void;
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
 * Paletón de órdenes.
 *
 * Se abre con Ctrl/Cmd+K o Tab: un cuadro flotante donde escribes y la opción
 * más cercana se filtra y se selecciona. Se alimenta del MISMO esquema único que
 * el dock y el radial (`buildCommands`), así que actualizar el esquema lo
 * actualiza sin tocar aquí. Cada fila muestra su RUTA (dominio › grupo) para
 * distinguir etiquetas repetidas (las dos "Opacidad"), y a la derecha dos
 * botones: abrir la opción en su panel del dock, y hacerla nacer como chip en el
 * lienzo (igual que el desgarro del radial). Enter aplica la acción primaria,
 * ↑/↓ mueven el resaltado, Esc cierra.
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
  private ports: PalettePorts;

  private dialog: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  private edge: MateriaEdge;
  /** Partículas (metaball) que forman/deshacen el cuadro. Sistema compartido. */
  private fx: MateriaFx;
  private fxTimer = 0;
  /** Tiempo de la expansión (círculo → cuadro con más partículas). */
  private bloomTimer = 0;
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

  constructor(editor: Editor, hooks: MenuHooks, ports: PalettePorts) {
    this.editor = editor;
    this.hooks = hooks;
    this.ports = ports;

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

    // Emblema en la esquina superior derecha: tres círculos de la misma materia
    // negra del menú radial. El grande lleva el logo y ondula como el núcleo del
    // radial (.materia-blob) mientras deriva suave y "al azar"; los dos pequeños lo
    // acompañan con su propia deriva. Decorativo (aria-hidden); el logo es un icono
    // de relleno que el usuario sustituirá por el suyo. Como el logo va DENTRO del
    // círculo grande, hereda su deriva y se mantiene centrado y nítido.
    const brand = el("div", { class: "cmd-brand", aria: { hidden: "true" } }, [
      el("span", { class: "cmd-brand-dot cmd-brand-a" }),
      el("span", { class: "cmd-brand-dot cmd-brand-b" }),
      el("span", { class: "cmd-brand-core" }, [
        el("span", { class: "cmd-brand-logo", html: icon("shape") }),
      ]),
    ]);

    this.dialog = el("div", { class: "cmd-dialog", role: "dialog", aria: { label: "Paleta de ordenes" } }, [
      this.edge.el,
      content,
      brand,
    ]);

    // Capa de partículas: hermana del diálogo, para que la opacidad del cuadro al
    // abrir/cerrar no la afecte. Núcleo REDONDO y pequeño en el centro, como el
    // menú radial: la masa "aparece desde el centro". Mismos parámetros que el menú
    // radial (coreSize 112, reach 96, 8 gotas) para que el arranque se vea igual:
    // varias gotas VIAJAN desde fuera hacia el centro y ahí cuaja el círculo (el
    // `reach` mayor que el radio del núcleo es lo que hace visible ese viaje; con un
    // reach pegado al borde las gotas no se movían y solo "aparecía" un blob). Luego
    // el cuadro, al crecer (bloom), rebasa este círculo hasta llenar los bordes.
    this.fx = new MateriaFx({ coreSize: 112, reach: 96, dots: 8, solidCore: true, gatherMs: 420, scatterMs: 300 });

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

    // Órdenes al día (etiquetas y estados frescos) y filtro en limpio. Se derivan
    // del esquema único, con el estado del momento para la ruta y los estados.
    this.commands = buildCommands(this.editor, this.editor.state, this.hooks);
    this.query = "";
    this.input.value = "";
    this.renderResults();

    window.clearTimeout(this.fxTimer);
    window.clearTimeout(this.bloomTimer);
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

    // Medir el cuadro a tamaño real (sin el scale de .is-forming) para centrar la
    // masa y para saber hasta dónde debe expandirse en la fase de bloom.
    const r = this.dialog.getBoundingClientRect();
    const cx = r.width > 0 ? r.left + r.width / 2 : window.innerWidth / 2;
    const cy = r.height > 0 ? r.top + r.height / 2 : window.innerHeight / 2;
    const rw = r.width > 0 ? r.width : 560;
    const rh = r.height > 0 ? r.height : 340;
    this.fx.center(cx, cy);

    // Secuencia, como pidió el usuario: un solo gesto continuo, sin que el círculo
    // llegue a "descansar" formado en medio.
    //  1) GATHER como el menú radial: varias gotas viajan desde fuera hacia el
    //     centro. Su curva es ease-out fuerte, así que a ~0.6 de la duración las
    //     gotas ya están prácticamente juntas.
    //  2) En ese punto —sin pausa— disparamos el BLOOM: el mismo impulso que las
    //     juntó las abre hacia la forma del cuadro. Al solaparse con la cola del
    //     gather no se percibe un círculo en reposo ni un corte entre fases.
    //  3) SIN esperar a que el bloom acabe: en cuanto las gotas ya casi cubren el
    //     cuadro (~0.55 de bloomMs; su curva ease-out ya las llevó a su sitio) la
    //     caja empieza su crossfade y la masa su fadeOut A LA VEZ, y el contenido
    //     se revela enseguida (revealMs corto). Así el relevo partículas→buscador
    //     es ágil y directo, no una espera tras la masa: dinámico, de producción.
    this.dialog.classList.add("is-forming");
    this.fx.gather();

    this.fxTimer = window.setTimeout(() => {
      if (!this.open) return;
      this.fx.bloom(rw, rh, 22); // el impulso sigue hacia afuera y cubre el cuadro
      this.bloomTimer = window.setTimeout(() => {
        if (!this.open) return;
        this.dialog.classList.remove("is-forming"); // la caja aparece sobre la masa
        this.fx.fadeOut();
        this.revealTimer = window.setTimeout(() => {
          if (!this.open) return;
          this.setRevealed(true); // ...y con ella, el buscador
          this.playRowCascade();
          this.focusInput();
        }, 120);
      }, Math.round(this.fx.bloomMs * 0.55));
    }, Math.round(this.fx.gatherMs * 0.6));
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;

    window.clearTimeout(this.fxTimer);
    window.clearTimeout(this.bloomTimer);
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
      // Sin consulta: todas, en el orden del esquema (mismo que el radial).
      picked = this.commands.map((cmd) => ({ cmd, hits: [] }));
    } else {
      const scored: Array<{ cmd: Command; hits: number[]; score: number }> = [];
      for (const cmd of this.commands) {
        // Se puntúa contra la etiqueta (con resaltado) y, si falla, contra la ruta +
        // sinónimos (sin resaltar, y con menos peso) para que "espejo" o "acabado"
        // encuentren la opción sin ensuciar el resaltado de la etiqueta.
        const label = fuzzy(q, cmd.label);
        if (label) {
          scored.push({ cmd, hits: label.hits, score: label.score });
          continue;
        }
        const alt = fuzzy(q, `${cmd.trail.join(" ")} ${cmd.keywords}`);
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
        this.renderMain(cmd, hits),
        this.renderActions(cmd),
      ]);
      setClass(row, "is-on", cmd.on);
      setClass(row, "is-disabled", cmd.disabled);
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

  /** Bloque central de una fila: etiqueta (con resaltado) + ruta (dominio › grupo). */
  private renderMain(cmd: Command, hits: number[]): HTMLElement {
    const kids = [this.renderLabel(cmd.label, hits)];
    if (cmd.trail.length) {
      kids.push(el("span", { class: "cmd-trail", text: cmd.trail.join(" › ") }));
    }
    return el("span", { class: "cmd-main" }, kids);
  }

  /**
   * Botones a la derecha de la fila. "Abrir en panel" aparece si la opción vive
   * en el dock; "Crear chip" si es alcanzable en el radial ahora mismo. Detienen
   * la propagación para no disparar la acción primaria de la fila.
   */
  private renderActions(cmd: Command): HTMLElement {
    const acts = el("span", { class: "cmd-actions" });
    if (cmd.dockTab) {
      acts.appendChild(this.actionBtn("panel", "Abrir en el panel", () => {
        this.hide();
        this.ports.openPanel(cmd.dockTab!, cmd.id);
      }));
    }
    if (cmd.radialPath) {
      acts.appendChild(this.actionBtn("pin", "Crear chip en el lienzo", () => {
        this.hide();
        this.ports.spawnChip(cmd.radialPath!, cmd.id);
      }));
    }
    return acts;
  }

  /** Un botón de acción de fila (icono + tooltip) que no propaga el clic. */
  private actionBtn(iconName: string, title: string, onClick: () => void): HTMLElement {
    const btn = el("button", { class: "cmd-act", type: "button", title, html: icon(iconName) });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
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
    if (!cmd || cmd.disabled) return;
    // Cerrar primero (arranca la salida por partículas) y luego actuar: si la
    // orden abre otro panel o diálogo, el paletón ya está saliendo de escena.
    this.hide();
    this.activatePrimary(cmd);
  }

  /**
   * Acción primaria de una orden (Enter o clic en la fila): si tiene acción
   * propia (herramienta, toggle, modo, comando), se ejecuta; si no, se abre en su
   * panel del dock; y si tampoco, nace como chip. Así Enter siempre "hace algo"
   * sensato con la opción elegida.
   */
  private activatePrimary(cmd: Command): void {
    if (cmd.run) cmd.run();
    else if (cmd.dockTab) this.ports.openPanel(cmd.dockTab, cmd.id);
    else if (cmd.radialPath) this.ports.spawnChip(cmd.radialPath, cmd.id);
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
