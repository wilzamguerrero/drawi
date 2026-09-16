import { Emitter } from "../core/emitter";
import { clamp, clamp01 } from "../core/math";
import { DEFAULT_PALETTES, rgbToHex, type Palette } from "../core/color";
import { globalRng, Rng } from "../core/rng";
import type { Vec2 } from "../core/vec2";
import { PointerInput, type GestureState, type InputSample } from "../input/pointer";
import { DEFAULT_SHAPE, randomShape, type ShapeDef } from "../physics/shapes";
import { createBody, setBodyStatic, type WorldSettings } from "../physics/world";
import type { Body } from "../physics/world";
import { fieldContours } from "../physics/marching";
import { Camera } from "../render/camera";
import { FieldRenderer, type FieldStyle } from "../render/field-gl";
import { FieldFallbackRenderer } from "../render/field-2d";
import { InkRenderer } from "../render/ink-renderer";
import { Layer } from "../render/layer";
import { OverlayRenderer, type OverlayState } from "../render/overlay-renderer";
import { SceneDocument } from "../scene/document";
import type { HistoryStatus } from "./history";
import { History } from "./history";
import { DEFAULT_BRUSH, type BrushSettings } from "../stroke/types";
import { symmetryTransforms, type SymmetryState } from "../symmetry/symmetry";
import { BrushTool } from "../tools/brush-tool";
import { MatterTool } from "../tools/matter-tool";
import { HandTool, PickerTool } from "../tools/picker-tool";
import { ShapeTool } from "../tools/shape-tool";
import { SymmetryTool } from "../tools/symmetry-tool";
import type { PullFamily } from "../tools/pull-shapes";
import type { Tool, ToolContext, ToolId, WetStroke } from "../tools/types";

export interface PenReadout {
  kind: "pen" | "touch" | "mouse";
  pressure: number;
  tilt: number;
  eraser: boolean;
  barrel: boolean;
  /** Hz estimados de muestreo del digitalizador. */
  rate: number;
}

export interface EditorState {
  name: string;
  tool: ToolId;
  brush: BrushSettings;
  color: string;
  palette: Palette;
  paletteIndex: number;
  symmetry: SymmetryState;
  shape: ShapeDef;
  world: WorldSettings;
  field: FieldStyle;
  pullFamily: PullFamily | "random";
  history: HistoryStatus;
  zoom: number;
  items: number;
  bodies: number;
  running: boolean;
  webgl: boolean;
  fps: number;
  pen: PenReadout | null;
  background: string;
  showWalls: boolean;
  debugColliders: boolean;
}

interface EditorEvents extends Record<string, unknown> {
  state: EditorState;
  status: string;
  /** Emitido tras cada trazo/cambio: la UI puede autoguardar. */
  dirty: void;
}

/**
 * Editor: el pegamento entre entrada, herramientas, escena y render.
 *
 * Reglas de la casa:
 * - Ninguna herramienta toca el DOM ni el bucle de render; solo marca sucio.
 * - El trazo en curso vive en su propia capa, asi que repintarlo no obliga a
 *   repintar toda la tinta seca: eso es lo que sostiene la sensacion de lapiz.
 * - La fisica avanza con paso fijo dentro del rAF; si el frame se retrasa,
 *   se acumulan subpasos en vez de deformar el tiempo.
 */
export class Editor {
  readonly events = new Emitter<EditorEvents>();
  readonly doc = new SceneDocument();
  readonly camera = new Camera();
  readonly history: History;
  readonly rng = new Rng(globalRng.int(0, 1 << 30));

  brush: BrushSettings = { ...DEFAULT_BRUSH };
  color = "#16181d";
  paletteIndex = 0;
  pullFamily: PullFamily | "random" = "random";
  running = true;
  showWalls = false;
  debugColliders = false;

  private host: HTMLElement;
  private inkLayer: Layer;
  private wetLayer: Layer;
  private fieldLayer: Layer;
  private overlayLayer: Layer;
  private fieldCanvas: HTMLCanvasElement;

  private inkRenderer = new InkRenderer();
  private overlayRenderer = new OverlayRenderer();
  private fieldRenderer: FieldRenderer;
  private fieldFallback = new FieldFallbackRenderer();

  private pointer: PointerInput;
  private tools: Record<ToolId, Tool>;
  private toolId: ToolId = "brush";
  private tempTool: ToolId | null = null;

  private wet: WetStroke | null = null;
  private highlight: Body | null = null;
  private cursor: Vec2 | null = null;
  private cursorKind: "pen" | "touch" | "mouse" = "mouse";
  private previewShape = false;
  private pen: PenReadout | null = null;

  private raf = 0;
  private lastFrame = 0;
  private fps = 60;
  private dpr = 1;
  private needsResize = true;
  private lastSampleTimes: number[] = [];
  private gestureStart = { x: 0, y: 0, zoom: 1, rotation: 0 };
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pickCanvas: HTMLCanvasElement;
  private pickCtx: CanvasRenderingContext2D;

  constructor(host: HTMLElement) {
    this.host = host;
    this.history = new History(this.doc);

    this.inkLayer = new Layer("layer layer-ink");
    this.wetLayer = new Layer("layer layer-wet");
    this.overlayLayer = new Layer("layer layer-overlay");
    this.fieldLayer = new Layer("layer layer-field-2d");

    this.fieldCanvas = document.createElement("canvas");
    this.fieldCanvas.className = "layer layer-field";
    this.fieldRenderer = new FieldRenderer(this.fieldCanvas);

    host.appendChild(this.inkLayer.canvas);
    if (this.fieldRenderer.available) host.appendChild(this.fieldCanvas);
    else host.appendChild(this.fieldLayer.canvas);
    host.appendChild(this.wetLayer.canvas);
    host.appendChild(this.overlayLayer.canvas);
    host.style.background = this.doc.meta.background;

    this.pickCanvas = document.createElement("canvas");
    this.pickCanvas.width = 1;
    this.pickCanvas.height = 1;
    const pickCtx = this.pickCanvas.getContext("2d", { willReadFrequently: true });
    if (!pickCtx) throw new Error("Canvas 2D no disponible");
    this.pickCtx = pickCtx;

    this.doc.shape = { ...DEFAULT_SHAPE };
    this.color = DEFAULT_PALETTES[0].colors[0];

    this.tools = {
      brush: new BrushTool(),
      shape: new ShapeTool(),
      matter: new MatterTool(),
      symmetry: new SymmetryTool(),
      picker: new PickerTool(),
      hand: new HandTool(),
    };

    this.pointer = new PointerInput(host, {
      onStart: (s) => this.onStart(s),
      onMove: (samples, predicted) => this.onMove(samples, predicted),
      onEnd: (s) => this.onEnd(s),
      onCancel: () => this.onCancel(),
      onHover: (s) => this.onHover(s),
      onGestureStart: (g) => this.onGestureStart(g),
      onGestureMove: (g) => this.onGestureMove(g),
      onGestureEnd: () => this.onGestureEnd(),
      onWheel: (e, x, y) => this.onWheel(e, x, y),
    });

    this.observeSize();
    this.bindKeyboard();
    this.start();
  }

  // ---------------------------------------------------------------- estado

  get palette(): Palette {
    return DEFAULT_PALETTES[this.paletteIndex] ?? DEFAULT_PALETTES[0];
  }

  get activeTool(): Tool {
    return this.tools[this.tempTool ?? this.toolId];
  }

  get state(): EditorState {
    return {
      name: this.doc.meta.name,
      tool: this.toolId,
      brush: this.brush,
      color: this.color,
      palette: this.palette,
      paletteIndex: this.paletteIndex,
      symmetry: this.doc.symmetry,
      shape: this.doc.shape,
      world: this.doc.physics.settings,
      field: this.doc.field,
      pullFamily: this.pullFamily,
      history: this.history.status,
      zoom: this.camera.zoom,
      items: this.doc.items.length,
      bodies: this.doc.bodies.length,
      running: this.running,
      webgl: this.fieldRenderer.available,
      fps: this.fps,
      pen: this.pen,
      background: this.doc.meta.background,
      showWalls: this.showWalls,
      debugColliders: this.debugColliders,
    };
  }

  emitState(): void {
    this.events.emit("state", this.state);
  }

  status(message: string): void {
    this.events.emit("status", message);
  }

  // ------------------------------------------------------------- comandos

  setTool(id: ToolId): void {
    if (this.toolId === id) return;
    this.activeTool.onCancel(this.ctx());
    this.toolId = id;
    this.host.style.cursor = this.tools[id].cursor === "none" ? "none" : this.tools[id].cursor;
    this.overlayLayer.invalidate();
    this.emitState();
  }

  setBrush(patch: Partial<BrushSettings>): void {
    this.brush = { ...this.brush, ...patch };
    this.overlayLayer.invalidate();
    this.emitState();
  }

  setColor(hex: string): void {
    this.color = hex;
    this.emitState();
  }

  setPalette(index: number): void {
    this.paletteIndex = clamp(index, 0, DEFAULT_PALETTES.length - 1);
    this.emitState();
  }

  setSymmetry(patch: Partial<SymmetryState>): void {
    const before = this.doc.snapshot();
    Object.assign(this.doc.symmetry, patch);
    if (patch.mode !== undefined && patch.mode !== "none") {
      // Al activarla por primera vez se coloca en el centro de la vista.
      if (this.doc.symmetry.x === 0 && this.doc.symmetry.y === 0) {
        this.doc.symmetry.x = this.camera.x;
        this.doc.symmetry.y = this.camera.y;
      }
    }
    this.history.record("Simetria", before);
    this.overlayLayer.invalidate();
    this.emitState();
  }

  setShape(patch: Partial<ShapeDef>): void {
    this.doc.shape = { ...this.doc.shape, ...patch };
    this.overlayLayer.invalidate();
    this.emitState();
  }

  setWorld(patch: Partial<WorldSettings>): void {
    Object.assign(this.doc.physics.settings, patch);
    this.doc.physics.wakeAll();
    this.fieldFallback.invalidate();
    this.emitState();
  }

  setField(patch: Partial<FieldStyle>): void {
    this.doc.field = { ...this.doc.field, ...patch };
    this.fieldFallback.invalidate();
    this.fieldLayer.invalidate();
    this.emitState();
  }

  setPullFamily(family: PullFamily | "random"): void {
    this.pullFamily = family;
    this.emitState();
  }

  setBackground(hex: string): void {
    const before = this.doc.snapshot();
    this.doc.meta.background = hex;
    this.host.style.background = hex;
    this.history.record("Fondo", before);
    this.emitState();
  }

  setRunning(on: boolean): void {
    this.running = on;
    if (on) this.doc.physics.wakeAll();
    this.emitState();
  }

  toggleWalls(): void {
    this.showWalls = !this.showWalls;
    this.doc.physics.settings.walls = this.showWalls;
    this.overlayLayer.invalidate();
    this.emitState();
  }

  toggleColliders(): void {
    this.debugColliders = !this.debugColliders;
    this.overlayLayer.invalidate();
    this.emitState();
  }

  undo(): void {
    const label = this.history.undo();
    if (!label) return;
    this.afterHistory(`Deshecho: ${label}`);
  }

  redo(): void {
    const label = this.history.redo();
    if (!label) return;
    this.afterHistory(`Rehecho: ${label}`);
  }

  private afterHistory(message: string): void {
    this.inkRenderer.prune(this.doc.items);
    this.inkLayer.invalidate();
    this.fieldFallback.invalidate();
    this.fieldLayer.invalidate();
    this.overlayLayer.invalidate();
    this.status(message);
    this.emitState();
    this.events.emit("dirty", undefined);
  }

  clearInk(): void {
    if (this.doc.items.length === 0) return;
    const before = this.doc.snapshot();
    this.doc.clearInk();
    this.history.record("Limpiar tinta", before);
    this.afterHistory("Tinta borrada");
  }

  clearMatter(): void {
    if (this.doc.bodies.length === 0) return;
    const before = this.doc.snapshot();
    this.doc.clearMatter();
    this.history.record("Limpiar materia", before);
    this.afterHistory("Materia borrada");
  }

  clearAll(): void {
    if (this.doc.isEmpty) return;
    const before = this.doc.snapshot();
    this.doc.clearAll();
    this.history.record("Limpiar todo", before);
    this.afterHistory("Lienzo limpio");
  }

  /**
   * Congela la materia como tinta.
   *
   * Extrae el contorno fundido del campo y lo convierte en items de tinta, de
   * modo que lo que era simulacion pasa a ser dibujo: se puede seguir pintando
   * encima, entra en el historial y se exporta como vector.
   */
  bakeMatter(): void {
    const bodies = this.doc.bodies;
    if (bodies.length === 0) return;
    const loops = fieldContours(bodies, this.doc.field.blend, { cell: 2.5 });
    if (loops.length === 0) return;

    const before = this.doc.snapshot();
    const identity = symmetryTransforms({ ...this.doc.symmetry, mode: "none" });
    for (const poly of loops) {
      const item = this.doc.buildItem([poly], this.color, 1, false, false);
      if (item) {
        item.transforms = identity;
        this.doc.addItem(item);
      }
    }
    this.doc.clearMatter();
    this.history.record("Hornear materia", before);
    this.afterHistory(`${loops.length} contornos horneados`);
  }

  /** Siembra n cuerpos aleatorios dentro de la vista. */
  seedMatter(n = 8): void {
    const before = this.doc.snapshot();
    const view = this.camera.visibleBounds(-40);
    for (let i = 0; i < n; i++) {
      const shape = randomShape(this.rng, this.doc.shape);
      const body = createBody(
        shape,
        {
          x: view.x + this.rng.next() * view.w,
          y: view.y + this.rng.next() * view.h * 0.6,
        },
        {
          color: this.rng.pick(this.palette.colors),
          blend: this.doc.field.blend,
        },
      );
      body.angle = this.rng.range(0, Math.PI * 2);
      setBodyStatic(body, false);
      this.doc.physics.add(body);
    }
    this.history.record("Sembrar materia", before);
    this.afterHistory(`${n} formas sembradas`);
  }

  fitView(): void {
    const b = this.doc.contentBounds();
    if (b.w > 0 && b.h > 0) this.camera.fit(b, 0.88);
    else this.camera.reset();
    this.invalidateAll();
    this.emitState();
  }

  resetView(): void {
    this.camera.reset();
    this.invalidateAll();
    this.emitState();
  }

  zoomBy(factor: number): void {
    this.camera.zoomAt(this.camera.width / 2, this.camera.height / 2, factor);
    this.invalidateAll();
    this.emitState();
  }

  invalidateAll(): void {
    this.inkLayer.invalidate();
    this.fieldLayer.invalidate();
    this.overlayLayer.invalidate();
    this.fieldFallback.invalidate();
  }

  /** Nombre del documento (lo muestra la barra superior y viaja en el .drawi). */
  setName(name: string): void {
    this.doc.meta.name = name.trim() || "Sin titulo";
    this.emitState();
    this.events.emit("dirty", undefined);
  }

  /**
   * Reconstruye caches y capas tras cargar un proyecto.
   *
   * La cache de Path2D esta indexada por item: si se cambia el documento entero
   * sin podarla, quedan rutas de la escena anterior ocupando memoria y, peor,
   * items nuevos que reutilizan un id verian geometria vieja.
   */
  reload(message?: string): void {
    this.inkRenderer.clearCache();
    this.host.style.background = this.doc.meta.background;
    this.invalidateAll();
    if (message) this.status(message);
    this.emitState();
    this.events.emit("dirty", undefined);
  }

  // ----------------------------------------------------- contexto de tool

  private toolCtx: ToolContext | null = null;

  private ctx(): ToolContext {
    if (this.toolCtx) {
      this.toolCtx.brush = this.brush;
      this.toolCtx.color = this.color;
      this.toolCtx.pullFamily = this.pullFamily;
      return this.toolCtx;
    }
    const editor = this;
    this.toolCtx = {
      doc: this.doc,
      camera: this.camera,
      history: this.history,
      rng: this.rng,
      brush: this.brush,
      color: this.color,
      pullFamily: this.pullFamily,
      toWorld(s: InputSample, out?: Vec2): Vec2 {
        return editor.camera.screenToWorld(s.x, s.y, out);
      },
      setColor(hex: string): void {
        editor.setColor(hex);
      },
      setWet(wet: WetStroke | null): void {
        editor.wet = wet;
        editor.wetLayer.invalidate();
      },
      commitWet(wet: WetStroke): void {
        const item = editor.doc.buildItem(
          wet.polys,
          wet.color,
          wet.opacity,
          wet.smooth,
          wet.gradient,
        );
        if (!item) return;
        item.transforms = wet.transforms;
        editor.doc.addItem(item);
        editor.inkLayer.invalidate();
        editor.emitState();
        editor.events.emit("dirty", undefined);
      },
      invalidateInk(): void {
        editor.inkLayer.invalidate();
      },
      invalidateField(): void {
        editor.fieldLayer.invalidate();
        editor.fieldFallback.invalidate();
      },
      invalidateOverlay(): void {
        editor.overlayLayer.invalidate();
      },
      setHighlight(body): void {
        if (editor.highlight !== body) {
          editor.highlight = body;
          editor.overlayLayer.invalidate();
        }
      },
      setPreviewShape(visible: boolean): void {
        if (editor.previewShape !== visible) {
          editor.previewShape = visible;
          editor.overlayLayer.invalidate();
        }
      },
      status(message: string): void {
        editor.status(message);
      },
      sampleScreenColor(x: number, y: number): string | null {
        return editor.sampleScreenColor(x, y);
      },
    };
    return this.toolCtx;
  }

  // -------------------------------------------------------------- entrada

  private onStart(s: InputSample): void {
    this.trackPen(s);
    this.cursor = { x: s.x, y: s.y };
    this.activeTool.onDown(this.ctx(), s);
    this.overlayLayer.invalidate();
  }

  private onMove(samples: InputSample[], predicted: InputSample[]): void {
    const last = samples[samples.length - 1];
    this.trackPen(last);
    this.cursor = { x: last.x, y: last.y };
    this.activeTool.onMove(this.ctx(), samples, predicted);
    this.overlayLayer.invalidate();
  }

  private onEnd(s: InputSample): void {
    this.activeTool.onUp(this.ctx(), s);
    this.overlayLayer.invalidate();
    this.emitState();
  }

  private onCancel(): void {
    this.activeTool.onCancel(this.ctx());
    this.wet = null;
    this.wetLayer.invalidate();
    this.overlayLayer.invalidate();
  }

  private onHover(s: InputSample | null): void {
    if (s) {
      this.trackPen(s);
      this.cursor = { x: s.x, y: s.y };
    } else {
      this.cursor = null;
      this.pen = null;
    }
    const tool = this.activeTool;
    if (tool.onHover) tool.onHover(this.ctx(), s);
    this.overlayLayer.invalidate();
  }

  private onGestureStart(g: GestureState): void {
    this.onCancel();
    this.gestureStart = {
      x: this.camera.x,
      y: this.camera.y,
      zoom: this.camera.zoom,
      rotation: this.camera.rotation,
    };
    void g;
  }

  private onGestureMove(g: GestureState): void {
    // Se reconstruye desde el estado inicial: sin deriva acumulada.
    this.camera.x = this.gestureStart.x;
    this.camera.y = this.gestureStart.y;
    this.camera.zoom = this.gestureStart.zoom;
    this.camera.rotation = this.gestureStart.rotation;
    this.camera.zoomAt(g.cx, g.cy, g.scale);
    this.camera.panByScreen(g.dx, g.dy);
    this.invalidateAll();
  }

  private onGestureEnd(): void {
    this.emitState();
  }

  private onWheel(e: WheelEvent, x: number, y: number): void {
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) {
      const factor = Math.exp(-e.deltaY * 0.0022);
      this.camera.zoomAt(x, y, factor);
    } else {
      this.camera.panByScreen(-e.deltaX, -e.deltaY);
    }
    this.invalidateAll();
    this.emitState();
  }

  /** Lectura en vivo del lapiz: alimenta el indicador de la barra de estado. */
  private trackPen(s: InputSample): void {
    const now = s.t;
    this.lastSampleTimes.push(now);
    if (this.lastSampleTimes.length > 24) this.lastSampleTimes.shift();
    let rate = 0;
    if (this.lastSampleTimes.length > 4) {
      const span = now - this.lastSampleTimes[0];
      if (span > 0) rate = Math.round(((this.lastSampleTimes.length - 1) / span) * 1000);
    }
    this.cursorKind = s.kind;
    this.pen = {
      kind: s.kind,
      pressure: s.pressure < 0 ? 0 : s.pressure,
      tilt: s.tilt,
      eraser: s.eraser,
      barrel: s.barrel,
      rate,
    };
  }

  private sampleScreenColor(x: number, y: number): string | null {
    const ctx = this.pickCtx;
    const sx = Math.round(x * this.dpr);
    const sy = Math.round(y * this.dpr);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = this.doc.meta.background;
    ctx.fillRect(0, 0, 1, 1);
    const sources: HTMLCanvasElement[] = [
      this.inkLayer.canvas,
      this.fieldRenderer.available ? this.fieldCanvas : this.fieldLayer.canvas,
      this.wetLayer.canvas,
    ];
    for (const src of sources) {
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      try {
        ctx.drawImage(src, sx, sy, 1, 1, 0, 0, 1, 1);
      } catch {
        // Un canvas sin buffer preservado puede fallar: se ignora esa capa.
      }
    }
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return rgbToHex({ r: d[0], g: d[1], b: d[2] });
  }

  // ------------------------------------------------------------- teclado

  private bindKeyboard(): void {
    const keys: Record<string, ToolId> = {
      b: "brush",
      f: "shape",
      m: "matter",
      s: "symmetry",
      i: "picker",
      h: "hand",
    };

    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        this.redo();
        return;
      }
      if (mod) return;

      if (e.code === "Space" && this.tempTool !== "hand") {
        e.preventDefault();
        this.tempTool = "hand";
        this.host.style.cursor = "grab";
        return;
      }
      const key = e.key.toLowerCase();
      if (keys[key]) {
        this.setTool(keys[key]);
        return;
      }
      switch (key) {
        case "1":
          this.setBrush({ mode: "stroke" });
          break;
        case "2":
          this.setBrush({ mode: "fill" });
          break;
        case "3":
          this.setBrush({ mode: "pull" });
          break;
        case "[":
          this.setBrush({ size: Math.max(0.5, this.brush.size * 0.85) });
          break;
        case "]":
          this.setBrush({ size: Math.min(400, this.brush.size * 1.18) });
          break;
        case "g":
          this.setBrush({ gradient: !this.brush.gradient });
          break;
        case "p":
          this.setBrush({ splat: !this.brush.splat });
          break;
        case "0":
          this.resetView();
          break;
        case "escape":
          this.onCancel();
          break;
        case "delete":
        case "backspace":
          if (e.shiftKey) this.clearAll();
          break;
        default:
          break;
      }
    };

    this.keyUpHandler = (e: KeyboardEvent) => {
      if (e.code === "Space" && this.tempTool === "hand") {
        this.tempTool = null;
        this.host.style.cursor =
          this.tools[this.toolId].cursor === "none" ? "none" : this.tools[this.toolId].cursor;
      }
    };

    window.addEventListener("keydown", this.keyHandler);
    window.addEventListener("keyup", this.keyUpHandler);
  }

  // --------------------------------------------------------------- bucle

  private observeSize(): void {
    const apply = (): void => {
      this.needsResize = true;
    };
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(apply);
      this.resizeObserver.observe(this.host);
    }
    window.addEventListener("resize", apply);
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    this.dpr = dpr;
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.camera.setViewport(w, h);
    this.inkLayer.resize(w, h, dpr);
    this.wetLayer.resize(w, h, dpr);
    this.fieldLayer.resize(w, h, dpr);
    this.overlayLayer.resize(w, h, dpr);
    this.fieldRenderer.resize(w, h, dpr);
    this.pointer.refreshRect();
    this.invalidateAll();
    this.needsResize = false;
  }

  start(): void {
    if (this.raf) return;
    this.lastFrame = performance.now();
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.fps = this.fps * 0.9 + (dt > 0 ? 1 / dt : 60) * 0.1;

    if (this.needsResize) this.resize();

    if (this.running && this.doc.bodies.length > 0) {
      const walls = this.doc.physics.settings.walls;
      if (walls) {
        const v = this.camera.visibleBounds(0);
        this.doc.physics.bounds = v;
      }
      const moving = this.doc.bodies.some((b) => b.awake);
      if (moving || this.doc.physics.dragging) {
        this.doc.physics.update(dt);
        this.fieldLayer.invalidate();
        this.fieldFallback.invalidate();
      }
    }

    if (this.inkLayer.dirty) {
      this.inkLayer.clear();
      this.inkRenderer.render(this.inkLayer, this.doc.items, this.camera);
      this.inkLayer.dirty = false;
    }

    if (this.fieldRenderer.available) {
      if (this.fieldLayer.dirty) {
        this.fieldRenderer.render(this.doc.bodies, this.camera, this.doc.field, this.dpr);
        this.fieldLayer.dirty = false;
      }
    } else if (this.fieldLayer.dirty) {
      this.fieldLayer.clear();
      this.fieldFallback.render(this.fieldLayer, this.doc.bodies, this.camera, this.doc.field);
      this.fieldLayer.dirty = false;
    }

    if (this.wetLayer.dirty) {
      this.wetLayer.clear();
      if (this.wet) {
        this.inkRenderer.renderWet(
          this.wetLayer,
          this.wet.polys,
          this.wet.transforms,
          this.camera,
          this.wet.color,
          this.wet.opacity,
          this.wet.smooth,
          this.wet.gradient,
          this.wet.gy0,
          this.wet.gy1,
        );
      }
      this.wetLayer.dirty = false;
    }

    if (this.overlayLayer.dirty) {
      this.overlayLayer.clear();
      this.overlayRenderer.render(this.overlayLayer, this.overlayState(), this.camera);
      this.overlayLayer.dirty = false;
    }
  }

  private overlayState(): OverlayState {
    const tool = this.activeTool;
    const symTool = this.tools.symmetry as SymmetryTool;
    const showRing = tool.showCursorRing && this.cursorKind !== "touch";
    return {
      symmetry: this.doc.symmetry,
      hoverHandle: this.toolId === "symmetry" && this.cursor
        ? symTool.hit(this.ctx(), {
            ...EMPTY_SAMPLE,
            x: this.cursor.x,
            y: this.cursor.y,
          })
        : null,
      activeHandle: null,
      cursor: showRing || this.previewShape ? this.cursor : null,
      cursorRadius: (this.brush.size / 2) * this.camera.zoom,
      previewShape: this.previewShape && this.toolId === "shape" ? this.doc.shape : null,
      highlight: this.highlight,
      showWalls: this.showWalls,
      walls: this.doc.physics.bounds,
      debugColliders: this.debugColliders,
      bodies: this.doc.bodies,
    };
  }

  dispose(): void {
    this.stop();
    this.pointer.dispose();
    this.fieldRenderer.dispose();
    this.resizeObserver?.disconnect();
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    if (this.keyUpHandler) window.removeEventListener("keyup", this.keyUpHandler);
    this.events.clear();
  }
}

/** Muestra neutra para consultas de gizmo que solo necesitan coordenadas. */
const EMPTY_SAMPLE: InputSample = {
  x: 0,
  y: 0,
  pressure: -1,
  tilt: 0,
  azimuth: 0,
  twist: 0,
  contact: 0,
  t: 0,
  kind: "mouse",
  predicted: false,
  barrel: false,
  eraser: false,
};

export const clampOpacity = (v: number): number => clamp01(v);
