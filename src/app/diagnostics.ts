import { clear, el } from "../ui/dom";
import { rectIntersects, type Rect } from "../scene/types";
import type { Camera } from "../render/camera";
import type { SceneDocument } from "../scene/document";

/** Referencia a un lienzo del pipeline para poder sondearlo. */
export interface DiagCanvasRef {
  name: string;
  role: "ink" | "field" | "wet" | "overlay";
  canvas: HTMLCanvasElement;
  dirty: boolean;
}

/** Fotografía cruda del pipeline que expone el editor (sin procesar). */
export interface DiagSnapshot {
  host: HTMLElement;
  dpr: number;
  camera: Camera;
  doc: SceneDocument;
  canvases: DiagCanvasRef[];
  fieldAvailable: boolean;
  soloId: string | null;
  maskMode: boolean;
}

/** Resultado de sondear un lienzo: cuántos píxeles no transparentes tiene. */
interface Probe {
  painted: number;
  total: number;
  note?: string;
}

/** Lienzo reutilizable donde se reduce cada capa para contar sus píxeles. */
const probeCanvas = document.createElement("canvas");
probeCanvas.width = 96;
probeCanvas.height = 96;

/**
 * Sondea un lienzo: lo dibuja reducido en `probeCanvas` y cuenta los píxeles
 * con alfa apreciable. Funciona igual para 2D y WebGL (vía `drawImage`); en
 * WebGL sin `preserveDrawingBuffer` el búfer puede salir vacío tras el frame,
 * así que un 0 ahí no es concluyente y se anota.
 */
function probe(canvas: HTMLCanvasElement, webgl: boolean): Probe {
  const pw = probeCanvas.width;
  const ph = probeCanvas.height;
  const ctx = probeCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { painted: 0, total: 0, note: "sin contexto 2D" };
  ctx.clearRect(0, 0, pw, ph);
  if (canvas.width === 0 || canvas.height === 0) {
    return { painted: 0, total: 0, note: "lienzo 0×0" };
  }
  try {
    ctx.drawImage(canvas, 0, 0, pw, ph);
  } catch (err) {
    return { painted: 0, total: 0, note: `no se pudo leer (${String(err)})` };
  }
  const data = ctx.getImageData(0, 0, pw, ph).data;
  let painted = 0;
  const total = pw * ph;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted++;
  const p: Probe = { painted, total };
  if (painted === 0 && webgl) p.note = "WebGL: 0 puede ser falso (búfer no conservado)";
  return p;
}

/** Describe el elemento más alto en un punto de pantalla (para ver qué tapa). */
function topAt(x: number, y: number): string {
  const node = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!node) return "nada";
  const cls = node.className && typeof node.className === "string" ? `.${node.className.trim().split(/\s+/)[0]}` : "";
  const layer = node.classList?.contains("layer") ? " ✓lienzo" : "";
  return `${node.tagName.toLowerCase()}${cls}${layer}`;
}

/** Lo que el panel necesita del editor (evita el acoplamiento con su clase). */
export interface DiagHost {
  debugState(): DiagSnapshot;
  resetView(): void;
  fitView(): void;
  invalidateAll(): void;
  status(message: string): void;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const rectStr = (r: Rect): string => `${fmt(r.x)}, ${fmt(r.y)} · ${fmt(r.w)}×${fmt(r.h)}`;

/**
 * Panel de diagnóstico del pipeline de dibujo.
 *
 * Se abre con Ctrl+Alt+D (o `window.__drawiDiag.toggle()`). Muestra en vivo el
 * tamaño real de cada lienzo, la cámara, las capas, un SONDEO de píxeles (¿el
 * lienzo de tinta tiene algo pintado?) y qué elemento tapa el centro. Con eso se
 * distingue "no se pinta" (fallo del compositor/cámara) de "se pinta pero no se
 * ve" (CSS/algo encima). No toca el documento; solo lee y repinta.
 */
export class Diagnostics {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private timer = 0;
  private visible = false;

  constructor(private host: DiagHost) {
    this.body = el("div", { class: "diag-body" });
    const btn = (label: string, on: () => void): HTMLElement => {
      const b = el("button", { class: "diag-btn" }, [label]);
      b.addEventListener("click", on);
      return b;
    };
    const bar = el("div", { class: "diag-bar" }, [
      el("strong", {}, ["Diagnóstico de render"]),
      btn("Restablecer cámara", () => this.host.resetView()),
      btn("Ajustar", () => this.host.fitView()),
      btn("Repintar", () => this.host.invalidateAll()),
      btn("Copiar", () => this.copy()),
      btn("Cerrar", () => this.hide()),
    ]);
    this.el = el("div", { class: "diag-overlay" }, [bar, this.body]);
  }

  // __APPEND3__
  private lastText = "";

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    if (!this.el.isConnected) document.body.appendChild(this.el);
    this.visible = true;
    this.el.classList.add("is-open");
    this.refresh();
    console.log("[drawi] Diagnóstico de render\n" + this.lastText);
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.refresh(), 400);
  }

  hide(): void {
    this.visible = false;
    this.el.classList.remove("is-open");
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  private copy(): void {
    const text = this.lastText;
    console.log("[drawi] Diagnóstico de render\n" + text);
    navigator.clipboard?.writeText(text).then(
      () => this.host.status("Diagnóstico copiado"),
      () => this.host.status("No se pudo copiar (mira la consola)"),
    );
  }

  /** Recolecta el estado del pipeline, lo pinta en el panel y arma el veredicto. */
  private refresh(): void {
    const s = this.host.debugState();
    const cam = s.camera;
    const view = cam.visibleBounds(0);
    const doc = s.doc;
    const hostRect = s.host.getBoundingClientRect();
    const content = doc.contentBounds();
    const hasContent = content.w > 0 && content.h > 0;
    const onScreen = hasContent ? rectIntersects(content, view) : false;

    clear(this.body);
    const out: string[] = [];
    const section = (title: string): void => {
      this.body.appendChild(el("div", { class: "diag-h" }, [title]));
      out.push(`== ${title}`);
    };
    const line = (k: string, val: string): void => {
      this.body.appendChild(
        el("div", { class: "diag-row" }, [
          el("span", { class: "diag-k" }, [k]),
          el("span", { class: "diag-v" }, [val]),
        ]),
      );
      out.push(`${k}: ${val}`);
    };

    section("Contenedor");
    line("host", `${fmt(hostRect.width)}×${fmt(hostRect.height)} css`);
    line("dpr", fmt(s.dpr));

    section("Cámara");
    line("centro", `${fmt(cam.x)}, ${fmt(cam.y)}`);
    line("zoom / rot", `${fmt(cam.zoom)} · ${fmt(cam.rotation)} rad`);
    line("vista mundo", rectStr(view));

    section("Contenido");
    line("trazos / cuerpos", `${doc.items.length} / ${doc.bodies.length}`);
    line("caja", hasContent ? rectStr(content) : "(vacío)");
    line("¿dentro de la vista?", hasContent ? (onScreen ? "sí" : "NO — fuera de cámara") : "n/a");
    if (s.soloId) line("modo foco", s.soloId);
    if (s.maskMode) line("modo máscara", "activo");

    section(`Capas (${doc.layers.length})`);
    for (const l of doc.layers) {
      // Cada tipo cuenta lo suyo: la tinta sus items, la materia sus cuerpos y
      // la acuarela si tiene pigmento horneado (el fluido vivo está en la GPU).
      const n =
        l.kind === "matter"
          ? doc.physics.bodiesOf(l.id).length
          : l.kind === "aqua"
            ? Number(Boolean(l.aquaBaked))
            : doc.layerItems(l.id).length;
      const unit = l.kind === "matter" ? "cuerpos" : l.kind === "aqua" ? "horneado" : "it";
      const flags = `${l.kind} · ${n} ${unit} · op ${fmt(l.opacity)} · fill ${fmt(l.fill)} · ${l.blend}`;
      line(`${l.visible ? "ojo" : " — "} ${l.name}`, flags + (l.id === doc.activeLayerId ? " · ACTIVA" : ""));
    }

    section("Lienzos (respaldo + sondeo de píxeles)");
    const probes: Record<string, Probe> = {};
    for (const c of s.canvases) {
      const cs = getComputedStyle(c.canvas);
      const pr = probe(c.canvas, c.role === "field" && s.fieldAvailable);
      probes[c.name] = pr;
      const note = pr.note ? ` (${pr.note})` : "";
      const attach = c.canvas.isConnected ? "" : " · SIN ADJUNTAR";
      line(
        c.name,
        `${c.canvas.width}×${c.canvas.height}px · ${cs.display}/${cs.visibility}/op${cs.opacity} · z${cs.zIndex || "auto"}${attach} · pint ${pr.painted}/${pr.total}${note}${c.dirty ? " · dirty" : ""}`,
      );
    }

    section("Qué hay encima del lienzo");
    const pts: Array<[string, number, number]> = [
      ["centro", hostRect.left + hostRect.width / 2, hostRect.top + hostRect.height / 2],
      ["sup-izq", hostRect.left + hostRect.width * 0.25, hostRect.top + hostRect.height * 0.25],
      ["inf-der", hostRect.left + hostRect.width * 0.75, hostRect.top + hostRect.height * 0.75],
    ];
    const tops: string[] = [];
    for (const [name, x, y] of pts) {
      const t = topAt(x, y);
      tops.push(t);
      line(name, t);
    }

    section("Veredicto");
    for (const verdict of this.verdicts(s, hostRect, onScreen, probes, tops)) {
      line("•", verdict);
    }
    this.lastText = out.join("\n");
  }

  /** Traduce los datos crudos a conclusiones legibles en español. */
  private verdicts(
    s: DiagSnapshot,
    hostRect: DOMRect,
    onScreen: boolean,
    probes: Record<string, Probe>,
    tops: string[],
  ): string[] {
    const v: string[] = [];
    const doc = s.doc;
    const items = doc.items.length;
    const ink = probes["tinta"];

    if (hostRect.width <= 1 || hostRect.height <= 1) {
      v.push("❌ El contenedor mide 0: ningún lienzo puede pintar. Revisa el layout de .canvas-host/.stage.");
    }
    for (const c of s.canvases) {
      if (c.canvas.isConnected && (c.canvas.width === 0 || c.canvas.height === 0)) {
        v.push(`❌ El lienzo «${c.name}» no tiene respaldo (0px): resize() no corrió o el host medía 0.`);
      }
      const cs = getComputedStyle(c.canvas);
      const hidden = cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0";
      if (c.canvas.isConnected && hidden) {
        if (c.role === "field") {
          v.push(`⚠️ La materia está oculta por CSS (${cs.display}/${cs.visibility}/op${cs.opacity}): ojo cerrado u opacidad 0.`);
        } else {
          v.push(`❌ El lienzo «${c.name}» está oculto por CSS (${cs.display}/${cs.visibility}/op${cs.opacity}).`);
        }
      }
    }
    if (items === 0 && doc.bodies.length === 0) {
      v.push("ℹ️ El documento está vacío (0 trazos, 0 cuerpos): dibuja algo para poder diagnosticar.");
    }
    if (ink) {
      if (items > 0 && ink.painted === 0) {
        if (!onScreen) v.push(`⚠️ Hay ${items} trazos pero su caja está FUERA de la vista. Pulsa «Ajustar» para traerlos.`);
        else v.push(`⚠️ Hay ${items} trazos en la vista pero la tinta sale VACÍA: el fallo está en el compositor o la cámara, no en el CSS.`);
      } else if (ink.painted > 0) {
        v.push(`✅ La tinta SÍ tiene píxeles pintados (${ink.painted}/${ink.total}).`);
        if (tops[0] && !tops[0].includes("lienzo")) {
          v.push(`⚠️ Pinta, pero en el centro lo tapa «${tops[0]}»: eso es lo que oculta el dibujo.`);
        }
      }
    }
    if (v.length === 0) {
      v.push("✅ Nada anómalo en el pipeline. Si aun así no ves nada, comprueba el color del trazo frente al fondo.");
    }
    return v;
  }
}

