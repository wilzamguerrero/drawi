import type { EditorState, PenReadout } from "../app/editor";
import { spaceToolLabel } from "../scene3d/tools3d";
import { TOOL_LABELS } from "../tools/manifest";
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
  private space: HTMLElement;
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
  private onToggleEngine?: () => void;
  private engineCanToggle = false;

  constructor(
    initialPinned = false,
    onTogglePin?: (pinned: boolean) => void,
    onToggleEngine?: () => void,
  ) {
    this.onToggleEngine = onToggleEngine;
    // Nace ya visible (is-fresh) para que el HUD no arranque con el hueco vacio;
    // el primer status() real hara el swap suave sobre este.
    this.message = el("span", { class: "status-message is-fresh", text: "Listo" });
    this.toolName = el("span", { class: "status-chip" });
    this.counts = el("span", { class: "status-chip" });
    // Chip del espacio: aparece solo cuando el espacio tiene el puntero, para que
    // en 2D la barra quede exactamente como estaba.
    this.space = el("span", { class: "status-chip status-space" });
    this.zoom = el("span", { class: "status-chip" });
    this.fps = el("span", { class: "status-chip" });
    this.engine = el("span", { class: "status-chip status-engine" });
    // El chip GPU/CPU es un interruptor: al pulsarlo se fuerza el respaldo CPU
    // o se vuelve a GPU. Útil para comparar ambos renders del campo.
    this.engine.addEventListener("click", () => {
      if (this.engineCanToggle) this.onToggleEngine?.();
    });

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
      this.space,
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
    // Fuera del espacio, la barra queda EXACTAMENTE como estaba: los mismos chips
    // y el mismo texto. Solo al entrar al espacio cambian -el chip de herramienta
    // pasa a decir el modo del espacio y el de recuento cuenta lo del espacio-, y
    // eso es una accion deliberada, no un salto mientras se dibuja.
    const s3 = state.scene3d;
    const enEspacio = state.mode3d;
    this.toolName.textContent = enEspacio
      ? `Espacio · ${spaceToolLabel(state.scene3dSettings, state.brush.mode)}`
      : TOOL_LABELS[state.tool];
    this.toolName.title = this.toolName.textContent;
    // Los dos textos tienen la misma forma -"N trazos · N manchas" frente a
    // "N trazos · N cuerpos"-, asi que cambiar de uno a otro no mueve el ancho.
    this.counts.textContent = enEspacio
      ? `${s3.strokes} ${s3.strokes === 1 ? "trazo" : "trazos"} · ${s3.fills} ${
          s3.fills === 1 ? "mancha" : "manchas"
        }`
      : `${state.items} trazos · ${state.bodies} cuerpos`;
    this.counts.title = enEspacio
      ? "Trazos y manchas del espacio"
      : "Trazo de tinta y cuerpos de materia del documento";

    // Un solo dato mas, el que no se ve en ningun otro sitio: donde esta el plano
    // de dibujo. Lo tecnico -lotes, instancias- va en el `title`, porque en la
    // barra solo alarga la linea y donde se mira de verdad es en el diagnostico.
    setClass(this.space, "is-on", enEspacio);
    if (enEspacio) {
      this.space.textContent = `plano ${s3.plane === 0 ? "auto" : num(s3.plane, 0)}`;
      const lotes =
        s3.drawCalls > 0
          ? `${s3.drawCalls} ${s3.drawCalls === 1 ? "lote" : "lotes"}, ${s3.instances} instancias`
          : "sin lotes";
      this.space.title = `${lotes}. Corchetes [ y ] mueven el plano; F encuadra.`;
    }

    this.zoom.textContent = `${num(state.zoom * 100, 0)}%`;
    this.fps.textContent = `${num(state.fps, 0)} fps`;
    setClass(this.fps, "is-warn", state.fps < 45);
    this.engine.textContent = state.webgl ? "GPU" : "CPU";
    this.engineCanToggle = state.webglAvailable;
    this.engine.title = !state.webglAvailable
      ? "Sin WebGL2: el campo se traza por CPU con marching squares"
      : state.webgl
        ? "Campo por WebGL2 — clic para forzar CPU"
        : "Campo por CPU (forzado) — clic para volver a GPU";
    setClass(this.engine, "is-warn", !state.webgl);
    setClass(this.engine, "is-clickable", state.webglAvailable);

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
