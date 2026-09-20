import type { EditorState, PenReadout } from "../app/editor";
import { TOOL_LABELS } from "../tools/types";
import { button } from "./controls";
import { el, num, setClass } from "./dom";

const KIND_LABELS: Record<PenReadout["kind"], string> = {
  pen: "Lapiz",
  touch: "Tactil",
  mouse: "Raton",
};

/**
 * Barra de estado.
 *
 * Incluye un medidor del lapiz en vivo (presion, inclinacion y Hz reales del
 * digitalizador) porque cuando alguien dice que "el lapiz no responde" casi
 * siempre pasa una de tres cosas: el navegador no entrega presion, entrega 20
 * muestras por segundo, o el estabilizador esta demasiado alto. Con estos tres
 * numeros a la vista se distingue en un trazo cual de las tres es.
 */
export class StatusBar {
  readonly el: HTMLElement;

  /** Boton para fijar el HUD. Vive fuera del footer para que el HUD lo coloque
      como hijo directo (junto al chip de motor, al lado de CPU/GPU) y herede el
      estilo translucido del resto de la barra. */
  readonly pinEl: HTMLElement;
  private pinBtn: ReturnType<typeof button>;
  private pinned = false;

  private message: HTMLElement;
  private toolName: HTMLElement;
  private counts: HTMLElement;
  private zoom: HTMLElement;
  private fps: HTMLElement;
  private penKind: HTMLElement;
  private penBar: HTMLElement;
  private penValue: HTMLElement;
  private penTilt: HTMLElement;
  private penRate: HTMLElement;
  private penBox: HTMLElement;
  private engine: HTMLElement;
  private timer = 0;
  private swapTimer = 0;

  /**
   * @param initialPinned  Estado inicial del pin (recordado de sesiones previas).
   * @param onTogglePin  Se llama al pulsar el boton de fijar; recibe el nuevo
   *   estado. Fijado = el HUD queda siempre visible; suelto = vuelve a aparecer
   *   y esconderse solo con la inactividad.
   */
  constructor(initialPinned = false, onTogglePin?: (pinned: boolean) => void) {
    // Nace ya visible (is-fresh) para que el HUD no arranque con el hueco vacio;
    // el primer status() real hara el swap suave sobre este.
    this.message = el("span", { class: "status-message is-fresh", text: "Listo" });
    this.toolName = el("span", { class: "status-chip" });
    this.counts = el("span", { class: "status-chip" });
    this.zoom = el("span", { class: "status-chip" });
    this.fps = el("span", { class: "status-chip" });
    this.engine = el("span", { class: "status-chip status-engine" });

    this.penKind = el("span", { class: "pen-kind", text: "--" });
    this.penBar = el("span", { class: "pen-bar-fill" });
    this.penValue = el("span", { class: "pen-num", text: "0%" });
    this.penTilt = el("span", { class: "pen-num", text: "0deg" });
    this.penRate = el("span", { class: "pen-num", text: "0Hz" });
    this.penBox = el("span", { class: "pen-readout", title: "Presion / inclinacion / muestras por segundo" }, [
      this.penKind,
      el("span", { class: "pen-bar" }, [this.penBar]),
      this.penValue,
      this.penTilt,
      this.penRate,
    ]);

    // El zoom ya se muestra en la barra de acciones (topbar), así que aquí no
    // se repite para no duplicar información en la misma línea del HUD.
    this.el = el("footer", { class: "statusbar" }, [
      this.message,
      this.penBox,
      this.toolName,
      this.counts,
      this.fps,
      this.engine,
    ]);

    // Toggle para fijar el HUD. Al lado de CPU/GPU (justo despues del footer en
    // el orden del HUD). Suelto por defecto: el HUD sigue apareciendo y
    // escondiendose solo. Fijado: se queda siempre a la vista.
    const pinTitle = (on: boolean): string =>
      on
        ? "HUD fijo — clic para volver a ocultarlo solo"
        : "Fijar el HUD (mantenerlo siempre visible)";

    this.pinned = initialPinned;
    this.pinBtn = button({
      iconName: "pin",
      title: pinTitle(initialPinned),
      onClick: () => {
        this.pinned = !this.pinned;
        this.pinBtn.setActive(this.pinned);
        this.pinBtn.el.title = pinTitle(this.pinned);
        onTogglePin?.(this.pinned);
      },
    });
    this.pinBtn.el.classList.add("status-pin");
    this.pinBtn.setActive(initialPinned);
    this.pinEl = this.pinBtn.el;
  }

  setMessage(text: string): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.swapTimer);

    const show = () => {
      this.message.textContent = text;
      // Reflow para que la transicion arranque desde el estado de reposo (fuera).
      void this.message.offsetWidth;
      this.message.classList.add("is-fresh");
    };

    if (this.message.classList.contains("is-fresh")) {
      // Ya hay un mensaje dentro: sale primero y entra el nuevo. Swap, no corte.
      this.message.classList.remove("is-fresh");
      this.swapTimer = window.setTimeout(show, 190);
    } else {
      show();
    }

    // Caduca solo: sale suave pasado un rato.
    this.timer = window.setTimeout(() => this.message.classList.remove("is-fresh"), 2600);
  }

  update(state: EditorState): void {
    this.toolName.textContent = TOOL_LABELS[state.tool];
    this.counts.textContent = `${state.items} trazos · ${state.bodies} cuerpos`;
    this.zoom.textContent = `${num(state.zoom * 100, 0)}%`;
    this.fps.textContent = `${num(state.fps, 0)} fps`;
    setClass(this.fps, "is-warn", state.fps < 45);
    this.engine.textContent = state.webgl ? "GPU" : "CPU";
    this.engine.title = state.webgl
      ? "Campo de materia por WebGL2"
      : "Sin WebGL2: el campo se traza por CPU con marching squares";
    setClass(this.engine, "is-warn", !state.webgl);

    const pen = state.pen;
    if (!pen) {
      setClass(this.penBox, "is-idle", true);
      this.penKind.textContent = "--";
      this.penBar.style.width = "0%";
      this.penValue.textContent = "--";
      this.penTilt.textContent = "--";
      this.penRate.textContent = "--";
      return;
    }
    setClass(this.penBox, "is-idle", false);
    this.penKind.textContent = KIND_LABELS[pen.kind] + (pen.eraser ? " (borra)" : pen.barrel ? " (boton)" : "");
    this.penBar.style.width = `${Math.round(pen.pressure * 100)}%`;
    setClass(this.penBox, "is-pen", pen.kind === "pen");
    this.penValue.textContent = pen.kind === "pen" && pen.pressure <= 0 ? "sin presion" : `${Math.round(pen.pressure * 100)}%`;
    this.penTilt.textContent = `${num(pen.tilt, 0)}deg`;
    this.penRate.textContent = `${pen.rate || 0}Hz`;
    setClass(this.penRate, "is-warn", pen.kind === "pen" && pen.rate > 0 && pen.rate < 60);
  }
}
