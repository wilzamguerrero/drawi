import type { EditorState, PenReadout } from "../app/editor";
import { TOOL_LABELS } from "../tools/types";
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

  constructor() {
    this.message = el("span", { class: "status-message", text: "Listo" });
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

    this.el = el("footer", { class: "statusbar" }, [
      this.message,
      el("span", { class: "statusbar-spacer" }),
      this.penBox,
      this.toolName,
      this.counts,
      this.zoom,
      this.fps,
      this.engine,
    ]);
  }

  setMessage(text: string): void {
    this.message.textContent = text;
    this.message.classList.add("is-fresh");
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.message.classList.remove("is-fresh"), 1800);
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
