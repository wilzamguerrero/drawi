import { el } from "./dom";
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
 */
export class HelpOverlay {
  readonly el: HTMLElement;
  private open = false;

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

    const dialog = el("div", { class: "help-dialog", role: "dialog" }, [
      el("div", { class: "help-head" }, [
        el("h2", { class: "help-title", text: "drawi" }),
        el("p", { class: "help-sub", text: "Dibujo generativo con materia que se funde." }),
        close,
      ]),
      el("div", { class: "help-columns" }, columns),
      el("div", { class: "help-notes" }, notes),
    ]);

    this.el = el("div", { class: "help-overlay" }, [dialog]);
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
    this.el.hidden = false;
    this.open = true;
  }

  hide(): void {
    this.el.hidden = true;
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }
}
