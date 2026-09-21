import { el } from "./dom";
import { MateriaEdge } from "./fx/materia-edge";
import { MateriaFx, prefersReducedMotion } from "./fx/materia";
import { icon } from "./icons";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Herramientas",
    rows: [
      ["B", "Pincel"],
      ["F", "Forma fisica"],
      ["M", "Mover materia"],
      ["S", "Eje de simetria"],
      ["I", "Cuentagotas"],
      ["H / Espacio", "Mano (desplazar la vista)"],
    ],
  },
  {
    title: "Pincel",
    rows: [
      ["1 / 2 / 3", "Trazo, relleno, arrastre"],
      ["[ / ]", "Tamano menor / mayor"],
      ["G", "Degradado"],
      ["P", "Splat (contorno anguloso)"],
      ["Boton lateral del lapiz", "Borra o quita materia"],
      ["Punta de goma", "Pinta con el color del fondo"],
    ],
  },
  {
    title: "Vista e historial",
    rows: [
      ["Rueda", "Desplazar; con Ctrl, zoom"],
      ["Dos dedos", "Zoom y desplazamiento a la vez"],
      ["0", "Restablecer la vista"],
      ["Ctrl+Z / Ctrl+Shift+Z", "Deshacer / rehacer"],
      ["Shift+Supr", "Limpiar todo"],
      ["Esc", "Cancelar el gesto en curso"],
    ],
  },
];

const NOTES: [string, string][] = [
  [
    "Materia que se funde",
    "Cada forma aporta un campo de distancia y todas se unen con una mezcla suave: al acercarse crean el puente continuo de un metaball, pero conservando su silueta real (caja, estrella, capsula).",
  ],
  [
    "Respuesta del lapiz",
    "Se leen los eventos coalescidos del navegador, asi que no se pierde ninguna muestra entre fotogramas, y la punta se filtra con One-Euro en vez de una media movil: quita el temblor sin anadir el retraso constante que hace sentir la linea pegajosa.",
  ],
  [
    "Simetria movible",
    "El eje es un objeto del lienzo: se arrastra su origen, se gira tirando del brazo y se cambia el numero de sectores con el mando exterior. Todo lo que dibujes se replica en vivo.",
  ],
];

/**
 * Panel de ayuda.
 *
 * Alcanzable con el boton de la barra o con ?, y cerrable con Escape o clic
 * fuera: un panel de atajos que no se cierra rapido acaba siendo un estorbo.
 *
 * Comparte el lenguaje visual del resto: el mismo negro del dock/menú radial, un
 * borde vivo ondulante (MateriaEdge, sus cuatro lados porque el cuadro flota) y
 * la entrada/salida por partículas del menú radial (MateriaFx), pero a la escala
 * de este cuadro —más grande que el centro del menú—, así toda la interfaz se
 * siente hecha de la misma materia.
 */
export class HelpOverlay {
  readonly el: HTMLElement;
  private open = false;

  private dialog: HTMLElement;
  private edge: MateriaEdge;
  /** Partículas (metaball) que forman/deshacen el cuadro. Sistema compartido. */
  private fx: MateriaFx;
  private fxTimer = 0;

  constructor() {
    const columns = GROUPS.map((g) =>
      el("div", { class: "help-group" }, [
        el("h4", { class: "help-group-title", text: g.title }),
        el(
          "dl",
          { class: "help-list" },
          g.rows.flatMap(([k, v]) => [
            el("dt", { class: "help-key", text: k }),
            el("dd", { class: "help-desc", text: v }),
          ]),
        ),
      ]),
    );

    const notes = NOTES.map(([title, body]) =>
      el("div", { class: "help-note" }, [
        el("h4", { class: "help-group-title", text: title }),
        el("p", { class: "help-desc", text: body }),
      ]),
    );

    const close = el("button", { class: "btn btn-icon help-close", type: "button", title: "Cerrar", html: icon("close") });
    close.addEventListener("click", () => this.hide());

    // Contenido nítido, por encima de la piel ondulante.
    const content = el("div", { class: "help-content" }, [
      el("div", { class: "help-head" }, [
        el("h2", { class: "help-title", text: "drawi" }),
        el("p", { class: "help-sub", text: "Dibujo generativo con materia que se funde." }),
        close,
      ]),
      el("div", { class: "help-columns" }, columns),
      el("div", { class: "help-notes" }, notes),
    ]);

    // Piel: el relleno del cuadro, dibujado como SVG vectorial con los cuatro
    // bordes vivos. Mismo negro (#161619) que el dock y el menú radial.
    this.edge = new MateriaEdge({ fill: "#161619", radius: 26, amplitude: 12, inset: 16, full: true });
    this.edge.el.classList.add("help-skin");

    this.dialog = el("div", { class: "help-dialog", role: "dialog" }, [this.edge.el, content]);

    // Capa de partículas: hermana del diálogo, para que la opacidad del cuadro al
    // abrir/cerrar no la afecte. Núcleo grande, acorde al tamaño del cuadro.
    this.fx = new MateriaFx({ coreSize: 260, reach: 230, dots: 14 });

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
    this.dialog.classList.remove("is-closing", "is-forming", "is-opening");
    this.edge.start();

    if (prefersReducedMotion()) {
      // Sin movimiento: aparición directa, sin partículas.
      this.fx.clear();
      return;
    }

    // Las partículas se juntan en el centro del cuadro y lo forman; el diálogo
    // espera (encogido/oculto por .is-forming) hasta que la masa está hecha. Al
    // quitar .is-forming, el cuadro entra con su transición y las partículas se
    // funden con él (mismo negro). El relevo es continuo, igual que el menú radial.
    this.dialog.classList.add("is-forming");
    this.centerFx();
    this.fx.gather();

    this.fxTimer = window.setTimeout(() => {
      if (!this.open) return;
      this.dialog.classList.remove("is-forming");
      this.dialog.classList.add("is-opening");
      this.fx.fadeOut();
    }, this.fx.gatherMs);
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;

    window.clearTimeout(this.fxTimer);
    this.dialog.classList.remove("is-forming", "is-opening");
    this.edge.collapse();

    if (prefersReducedMotion()) {
      this.el.hidden = true;
      this.dialog.classList.remove("is-closing");
      return;
    }

    // El cuadro se desintegra en partículas mientras se va: sale como entró.
    this.dialog.classList.add("is-closing");
    this.centerFx();
    this.fx.scatter();

    this.fxTimer = window.setTimeout(() => {
      if (this.open) return;
      this.el.hidden = true;
      this.dialog.classList.remove("is-closing");
      this.fx.clear();
    }, this.fx.scatterMs);
  }

  /** Coloca las partículas en el centro del diálogo (en coords del overlay). */
  private centerFx(): void {
    const r = this.dialog.getBoundingClientRect();
    if (r.width > 0) {
      this.fx.center(r.left + r.width / 2, r.top + r.height / 2);
    } else {
      // Aún sin medir (primer frame): el centro de la ventana, donde se centra.
      this.fx.center(window.innerWidth / 2, window.innerHeight / 2);
    }
  }

  get isOpen(): boolean {
    return this.open;
  }
}
