import { el } from "./dom";
import { MateriaEdge } from "./fx/materia-edge";
import { MateriaFx, prefersReducedMotion } from "./fx/materia";
import { icon } from "./icons";

/* ==========================================================================
   Panel de ayuda.

   Reúne en un solo sitio TRES cosas: la referencia de comandos (atajos de
   teclado y ratón), unas notas de cómo funciona la materia, y el historial de
   versiones (change log). Todo se declara como DATOS al principio del archivo
   —COMMAND_GROUPS, NOTES, CHANGELOG—, así añadir una función nueva o anotar una
   versión es editar una lista, sin tocar la vista de abajo.

   Comparte el lenguaje visual y la animación del buscador (paletón): mismo negro
   (#161619), piel ondulante (MateriaEdge) y entrada/salida por partículas
   (MateriaFx) con el MISMO gesto continuo —las gotas se juntan en el centro, la
   masa se expande (bloom) hasta cubrir el cuadro y la caja aparece encima con un
   crossfade—, para que abrir la ayuda se sienta igual que abrir el buscador.
   ========================================================================== */

/** Versión actual. Súbela en cada release y añade su entrada ARRIBA del CHANGELOG. */
const APP_VERSION = "1.0.0";

/** Quién desarrolló la app (crédito "DEV" al pie, igual que el splash). */
const AUTHOR = "wilzamguerrero";

/* ------------------------------------------------------------ datos editables */

/**
 * Referencia de comandos: cada grupo lleva su icono y sus filas [tecla, qué hace].
 * Añadir un atajo = añadir una fila; añadir una familia = añadir un grupo.
 *
 * La TECLA va a la derecha como pastilla (estilo hoja de atajos): si lleva varias
 * separadas por " / " se pintan como pastillas sueltas. La descripción va corta a
 * la izquierda —una sola línea— para que se lea de un vistazo.
 */
const COMMAND_GROUPS: { title: string; icon: string; rows: [string, string][] }[] = [
  {
    title: "Herramientas",
    icon: "compass",
    rows: [
      ["Tab", "Buscar (paleton)"],
      ["B", "Pincel"],
      ["F", "Forma fisica"],
      ["M", "Mover materia"],
      ["S", "Eje de simetria"],
      ["I", "Cuentagotas"],
      ["H / Espacio", "Mano"],
    ],
  },
  {
    title: "Pincel",
    icon: "brush",
    rows: [
      ["1 / 2 / 3", "Trazo, relleno, arrastre"],
      ["[ / ]", "Tamano -/+"],
      ["G", "Degradado"],
      ["P", "Splat"],
      ["Boton lateral", "Borrar materia"],
      ["Punta de goma", "Pintar con el fondo"],
    ],
  },
  {
    title: "Vista e historial",
    icon: "fit",
    rows: [
      ["Rueda", "Desplazar (Ctrl: zoom)"],
      ["Dos dedos", "Zoom y desplazar"],
      ["0", "Restablecer vista"],
      ["Ctrl+Z", "Deshacer"],
      ["Ctrl+Shift+Z", "Rehacer"],
      ["Shift+Supr", "Limpiar todo"],
      ["Esc", "Cancelar gesto"],
    ],
  },
];

/**
 * Historial de versiones (change log). NUEVA versión = nueva entrada ARRIBA de la
 * lista: se pinta en orden, así lo más reciente queda primero. Cada entrada lleva
 * versión, fecha, un título corto y sus mejoras como viñetas.
 */
const CHANGELOG: { version: string; date: string; title: string; changes: string[] }[] = [
  {
    version: "1.0.0",
    date: "28 sep 2026",
    title: "Primer lanzamiento",
    changes: [
      "Buscador de ordenes (Tab / Ctrl+K): busca cualquier ajuste, lo edita en linea y recuerda donde lo dejaste.",
      "Un unico esquema alimenta el dock, el menu radial y el buscador: cada funcion nueva aparece en las tres superficies a la vez.",
      "Materia que se funde con campos de distancia y simetria movible que replica el trazo en vivo.",
      "Lapiz con filtro One-Euro y eventos coalescidos: trazo limpio, sin temblor ni retraso.",
      "Interfaz de materia viva: paneles, menus y buscador nacen y se deshacen con la misma animacion de particulas.",
    ],
  },
];

export class HelpOverlay {
  readonly el: HTMLElement;
  private open = false;

  private dialog: HTMLElement;
  private edge: MateriaEdge;
  /** Partículas (metaball) que forman/deshacen el cuadro. Sistema compartido. */
  private fx: MateriaFx;
  private fxTimer = 0;
  /** Tiempo de la expansión (círculo → cuadro con más partículas). */
  private bloomTimer = 0;
  /** Segundo tiempo: revela el contenido una vez la caja está llena. */
  private revealTimer = 0;

  /** Bloque plegable de atajos: arranca colapsado y se abre al pulsar la cabecera. */
  private cmdCollapse: HTMLElement;

  constructor() {
    // --- referencia de comandos: un grupo por columna, cada uno con su icono.
    // Cada fila es "descripción · pastilla(s) de tecla" (estilo hoja de atajos):
    // la tecla va a la derecha y, si trae varias (" / "), como pastillas sueltas. ---
    const columns = COMMAND_GROUPS.map((g) =>
      el("div", { class: "help-group" }, [
        el("h4", { class: "help-group-title" }, [
          el("span", { class: "help-group-ico", html: icon(g.icon) }),
          el("span", { text: g.title }),
        ]),
        el(
          "div",
          { class: "help-cmds" },
          g.rows.map(([k, v]) =>
            el("div", { class: "help-cmd" }, [
              el("span", { class: "help-cmd-label", text: v }),
              el(
                "span",
                { class: "help-cmd-keys" },
                k.split(" / ").map((key) => el("kbd", { class: "help-kbd", text: key })),
              ),
            ]),
          ),
        ),
      ]),
    );

    // Bloque plegable: una cabecera pulsable ("Atajos de teclado") y, debajo, las
    // tres columnas. Arranca COLAPSADO —el panel abre mostrando notas e historial—
    // y al pulsar la cabecera se despliega la rejilla de atajos.
    const collapseInner = el("div", { class: "help-collapse-inner" }, [
      el("div", { class: "help-columns" }, columns),
    ]);
    const collapseHead = el("button", { class: "help-collapse-head", type: "button" }, [
      el("span", { class: "help-collapse-ico", html: icon("compass") }),
      el("span", { class: "help-collapse-title", text: "Atajos de teclado" }),
      el("span", { class: "help-collapse-chevron", html: icon("chevron") }),
    ]);
    this.cmdCollapse = el("div", { class: "help-collapse" }, [
      collapseHead,
      el("div", { class: "help-collapse-body" }, [collapseInner]),
    ]);
    collapseHead.addEventListener("click", () => {
      this.cmdCollapse.classList.toggle("is-open");
    });

    // --- historial de versiones: una tarjeta por release ---
    const releases = CHANGELOG.map((r) =>
      el("div", { class: "help-release" }, [
        el("div", { class: "help-release-head" }, [
          el("span", { class: "help-release-v", text: `v${r.version}` }),
          el("span", { class: "help-release-title", text: r.title }),
          el("span", { class: "help-release-date", text: r.date }),
        ]),
        el(
          "ul",
          { class: "help-changes" },
          r.changes.map((c) => el("li", { class: "help-change", text: c })),
        ),
      ]),
    );

    // --- cabecera: marca + versión + cerrar ---
    const close = el("button", { class: "btn btn-icon help-close", type: "button", title: "Cerrar", html: icon("close") });
    close.addEventListener("click", () => this.hide());

    const head = el("div", { class: "help-head" }, [
      el("div", { class: "help-head-main" }, [
        el("h2", { class: "help-title brand-lockup" }, [
          el("span", { class: "brand-zence", text: "ZENCE" }),
          el("span", { class: "brand-draw", text: "DRAW" }),
        ]),
      ]),
      close,
    ]);

    // --- pie: etiqueta "DEV" (misma que el splash) + nombre y versión ---
    const foot = el("div", { class: "help-foot" }, [
      el("span", { class: "help-dev" }, [
        el("span", { class: "help-dev-tag", text: "DEV" }),
        el("span", { text: AUTHOR }),
      ]),
      el("span", { class: "help-credit-v", text: `Zence Draw · v${APP_VERSION}` }),
    ]);

    // Cuerpo desplazable: TODO en una sola tirada. Arriba los atajos (plegados)
    // y debajo el historial de versiones; se baja con el scroll para verlo.
    const body = el("div", { class: "help-body" }, [
      this.cmdCollapse,
      el("div", { class: "help-section" }, [
        el("h3", { class: "help-section-title" }, [
          el("span", { class: "help-section-ico", html: icon("spark") }),
          el("span", { text: "Novedades" }),
        ]),
        el("div", { class: "help-changelog" }, releases),
      ]),
    ]);

    // Contenido nítido, por encima de la piel ondulante.
    const content = el("div", { class: "help-content" }, [head, body, foot]);
    // Cascada: cada bloque (cabecera, cuerpo, pie) arranca un pelín abajo y
    // transparente, y sube a su sitio con un retardo escalonado (--i) al recibir
    // .is-revealed —en el relevo de las partículas—.
    [head, body, foot].forEach((node, i) => {
      node.classList.add("help-rise");
      node.style.setProperty("--i", String(i));
    });

    // Piel: SVG vectorial con los cuatro bordes vivos. Mismo negro (#161619) que
    // el dock y el menú radial.
    this.edge = new MateriaEdge({ fill: "#161619", radius: 26, amplitude: 12, inset: 16, full: true });
    this.edge.el.classList.add("help-skin");

    this.dialog = el("div", { class: "help-dialog", role: "dialog" }, [this.edge.el, content]);

    // Partículas: MISMA configuración y gesto que el buscador —núcleo redondo y
    // sólido que se junta en el centro (coreSize 112, reach 96, 8 gotas) y luego
    // un bloom que lo expande hasta el rectángulo del cuadro—, así la ayuda y el
    // buscador nacen y se cierran igual.
    this.fx = new MateriaFx({ coreSize: 112, reach: 96, dots: 8, solidCore: true, gatherMs: 420, scatterMs: 300 });

    this.el = el("div", { class: "help-overlay" }, [this.fx.el, this.dialog]);
    this.el.hidden = true;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }
  show(): void {
    if (this.open) return;
    this.el.hidden = false;
    this.open = true;

    window.clearTimeout(this.fxTimer);
    window.clearTimeout(this.bloomTimer);
    window.clearTimeout(this.revealTimer);
    this.dialog.classList.remove("is-closing", "is-forming");
    this.cmdCollapse.classList.remove("is-open"); // atajos siempre plegados al abrir
    this.setRevealed(false);
    this.edge.start();

    if (prefersReducedMotion()) {
      // Sin movimiento: aparición directa, sin partículas ni cascada.
      this.el.classList.add("is-visible");
      this.setRevealed(true);
      this.fx.clear();
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
    const rw = r.width > 0 ? r.width : 820;
    const rh = r.height > 0 ? r.height : 520;
    this.fx.center(cx, cy);

    // Mismo gesto continuo que el buscador (un solo impulso, sin que el círculo
    // descanse formado en medio):
    //  1) GATHER: las gotas viajan de fuera al centro y cuaja el círculo.
    //  2) A ~0.6 del gather, sin pausa, BLOOM: ese impulso abre la masa hasta la
    //     forma del cuadro y brotan más gotas que lo llenan.
    //  3) A ~0.55 del bloom la caja aparece con crossfade y la masa se funde a la
    //     vez; +120ms después se revela el contenido en cascada.
    this.dialog.classList.add("is-forming");
    this.fx.gather();

    this.fxTimer = window.setTimeout(() => {
      if (!this.open) return;
      this.fx.bloom(rw, rh, 26); // el impulso sigue hacia afuera y cubre el cuadro
      this.bloomTimer = window.setTimeout(() => {
        if (!this.open) return;
        this.dialog.classList.remove("is-forming"); // la caja aparece sobre la masa
        this.fx.fadeOut();
        this.revealTimer = window.setTimeout(() => {
          if (!this.open) return;
          this.setRevealed(true); // ...y con ella, el contenido
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
    this.dialog.classList.remove("is-forming");
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

    // El fondo se desvanece a la vez que el cuadro se va.
    this.el.classList.remove("is-visible");

    // El cuadro se desintegra en partículas al irse: sale como entró. Se mide aún
    // a tamaño real (no se le ha aplicado el scale de salida).
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

  /** Activa/desactiva la cascada del contenido (clase en el contenedor raíz). */
  private setRevealed(on: boolean): void {
    this.dialog.classList.toggle("is-revealed", on);
  }

  /**
   * Centra las partículas en el diálogo. El núcleo es REDONDO (no rectangular):
   * la masa nace como un blob en el centro, igual que el buscador, y es el cuadro
   * el que al crecer (bloom) llena los bordes. Por eso NO se le pasa `setRect`.
   */
  private syncFxToDialog(): void {
    const r = this.dialog.getBoundingClientRect();
    if (r.width > 0) this.fx.center(r.left + r.width / 2, r.top + r.height / 2);
    else this.fx.center(window.innerWidth / 2, window.innerHeight / 2);
  }

  get isOpen(): boolean {
    return this.open;
  }
}
