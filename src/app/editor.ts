import { Emitter } from "../core/emitter";
import { clamp, clamp01 } from "../core/math";
import { DEFAULT_PALETTES, rgbToHex, type Palette } from "../core/color";
import { globalRng, Rng } from "../core/rng";
import type { Vec2 } from "../core/vec2";
import { PointerInput, type GestureState, type InputSample } from "../input/pointer";
import { DEFAULT_SHAPE, randomShape, type ShapeDef } from "../physics/shapes";
import { createBody, setBodyStatic, syncTransform, type WorldSettings } from "../physics/world";
import type { Body } from "../physics/world";
import { computeBridges } from "../physics/bridges";
import { fieldContours } from "../physics/marching";
import { Camera } from "../render/camera";
import { FieldRenderer, BRIDGE_STYLE_CODE, type FieldStyle } from "../render/field-gl";
import { MatterCompositor } from "../render/matter-compositor";
import { InkRenderer } from "../render/ink-renderer";
import { Compositor } from "../render/compositor";
import { Layer } from "../render/layer";
import { OverlayRenderer, type OverlayState } from "../render/overlay-renderer";
import { SceneDocument } from "../scene/document";
import type { LayerColor, SceneLayer } from "../scene/layer";
import type { HistoryStatus } from "./history";
import type { DiagSnapshot } from "./diagnostics";
import { History } from "./history";
import { DEFAULT_BRUSH, type BrushSettings } from "../stroke/types";
import { symmetryTransforms, SYMMETRY_LABELS, type SymmetryState } from "../symmetry/symmetry";
import { rotationAround, reflectionAbout, multiply, invert, apply as applyMat, applyDir as applyDirMat, type Mat2d } from "../core/mat2d";
import { polygonBounds } from "../stroke/outline";
import { transformRect } from "../scene/document";
import { unionRect } from "../scene/types";
export type SelectOp = "move" | "scale" | "rotate" | "pivot";
export type SelectPivotMode = "center" | "custom";
import { Selection } from "./selection";
import { SymmetryTool } from "../tools/symmetry-tool";
import { AquaField } from "../aqua/aqua-field";
import { DEFAULT_AQUA_PARAMS, type AquaParams } from "../aqua/aqua-field";
import { bakeAqua } from "../aqua/aqua-bake";
import type { PullFamily } from "../tools/pull-shapes";
import { DEFAULT_TOOL, HELD_TOOL, TOOL_KEYS, TOOL_LABELS, TOOLS } from "../tools/manifest";
import type { Tool, ToolContext, ToolId, WetStroke } from "../tools/types";
import { Viewport3D } from "./viewport3d";

/** Operacion activa de la herramienta Materia. */
export type MatterOp = "move" | "rotate" | "scale" | "pivot";

/** Semilla del historial de colores: la escala de grises de la paleta Tinta.
    Se va sustituyendo por los colores que el usuario elige. */
const RECENT_SEED = ["#000000", "#1b1b1f", "#3d3d46", "#6e6e78", "#a8a8b3", "#d6d6dd", "#ffffff"];

/**
 * Cupo de motores de acuarela vivos a la vez.
 *
 * Cada uno es un contexto WebGL2 con varias rejillas de punto flotante a
 * resolución de pantalla: tres ya son decenas de megas de VRAM, y los
 * navegadores empiezan a tirar contextos antiguos pasados unos pocos. Se pueden
 * tener más capas de acuarela que esto; las que pasen del cupo conservan lo que
 * tengan horneado pero no reciben fluido nuevo hasta que se libere una.
 */
const MAX_AQUA_FIELDS = 3;

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
  secondaryColor: string;
  palette: Palette;
  paletteIndex: number;
  symmetry: SymmetryState;
  shape: ShapeDef;
  world: WorldSettings;
  field: FieldStyle;
  pullFamily: PullFamily | "random";
  /** Últimos colores usados (más reciente primero, máx. 15). */
  recentColors: string[];
  history: HistoryStatus;
  zoom: number;
  items: number;
  bodies: number;
  running: boolean;
  /** El campo se pinta ahora mismo por GPU (WebGL2) y no por el respaldo CPU. */
  webgl: boolean;
  /** WebGL2 está disponible: el chip GPU/CPU puede alternar. */
  webglAvailable: boolean;
  fps: number;
  pen: PenReadout | null;
  background: string;
  showWalls: boolean;
  debugColliders: boolean;
  /** Dibuja el radio de alcance de puentes de cada cuerpo. */
  showBridgeReach: boolean;
  /** Operacion de la herramienta Materia: mover, rotar o escalar. */
  matterOp: MatterOp;
  selectOp: SelectOp;
  keepAspect: boolean;
  snapEnabled: boolean;
  selectSnap: number;
  selectBounds: import("../scene/types").Rect | null;
  selectPivot: import("../core/vec2").Vec2 | null;
  selectCount: number;
  selection: import("./selection").Selection;
  /** Capas del documento (abajo→arriba) para el panel. */
  layers: SceneLayer[];
  activeLayerId: string;
  /** Capa aislada (modo foco), o null. */
  soloLayerId: string | null;
  /** El pincel pinta la máscara de la capa activa, no su contenido. */
  maskMode: boolean;
  /** El plano de acuarela existe (WebGL2 disponible). */
  aquaAvailable: boolean;
  /** Modo del pincel de acuarela: pluma (pigmento) o agua. */
  aquaMode: "pen" | "brush";
  /** Tamaño propio de la acuarela (px mundo) del modo activo. */
  aquaSize: number;
  /** El plano de acuarela esta visible. */
  aquaLayerVisible: boolean;
  /** Opacidad del plano de acuarela (0..1). */
  aquaLayerOpacity: number;
  /** Parametros vivos de la acuarela (0..1). */
  aquaParams: import("../aqua/aqua-field").AquaParams;
  /** El visor de dibujo espacial esta activo. */
  mode3d: boolean;
  /** WebGL2 esta disponible para el visor 3D. */
  scene3dAvailable: boolean;
  /** Lotes, instancias y trazos del espacio. Los lotes son las draw calls. */
  scene3d: { drawCalls: number; instances: number; strokes: number };
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
  selection = new Selection();
  selectOp: SelectOp = "move";
  keepAspect = true;
  snapEnabled = true;
  selectSnap = 12;
  color = "#16181d";
  /** Color secundario (estilo Photoshop): se intercambia con el activo con la
      tecla X y desde el círculo sobrepuesto de la rueda de color. */
  secondaryColor = "#ffffff";
  paletteIndex = 0;
  /** Historial de colores usados: se siembra con la escala de grises y se va
      sustituyendo por los colores que el usuario elige (más reciente primero). */
  recentColors: string[] = [...RECENT_SEED];
  pullFamily: PullFamily | "random" = "random";
  running = true;
  /** El visor de dibujo espacial esta activo. */
  mode3d = false;
  showWalls = false;
  debugColliders = false;
  showBridgeReach = false;
  matterOp: MatterOp = "move";

  private host: HTMLElement;
  private inkLayer: Layer;
  private wetLayer: Layer;
  private overlayLayer: Layer;
  /** Lienzo WebGL del campo (fuera de pantalla); el compositor de materia lo usa. */
  private fieldCanvas: HTMLCanvasElement;

  private inkRenderer = new InkRenderer();
  private compositor = new Compositor(this.inkRenderer);
  private overlayRenderer = new OverlayRenderer();
  private fieldRenderer: FieldRenderer;
  private matter: MatterCompositor;

  /**
   * Motores de acuarela, uno por capa de acuarela (`kind === "aqua"`).
   *
   * Se crean en perezoso —solo al pintar de verdad en la capa— y se sueltan al
   * borrarla: cada motor es un contexto WebGL2 con rejillas de punto flotante
   * grandes, y el navegador solo tolera unos pocos a la vez. De ahí el cupo de
   * `MAX_AQUA_FIELDS`: una capa por encima del cupo existe y conserva lo que
   * tenga horneado, pero no recibe simulación nueva.
   */
  private aquaFields = new Map<string, AquaField>();
  /** Sondeo de WebGL2 cacheado: no se crea un motor solo para saber si se puede. */
  private aquaSupport: boolean | null = null;
  /** Sondeo propio del visor 3D, por el mismo motivo. */
  private scene3dSupport: boolean | null = null;
  /**
   * Visor 3D, creado en perezoso.
   *
   * En perezoso y no en el constructor porque cada visor abre un contexto WebGL2
   * propio, y el navegador solo tolera unos pocos a la vez: ademas de la materia
   * y de la acuarela, que ya gastan los suyos.
   */
  private viewport3dInstance: Viewport3D | null = null;
  /** Modo del pincel de acuarela: pluma (pigmento) o agua. */
  private aquaModeValue: "pen" | "brush" = "pen";
  /** Parámetros vivos, compartidos por todas las capas: son ajustes del PINCEL
      (el papel, el sangrado, el secado), no propiedades de cada capa. */
  private aquaParamsValue: AquaParams = { ...DEFAULT_AQUA_PARAMS };
  /** Tinta blanca (gouache) en vez de pigmento oscuro. */
  private aquaWhite = false;
  /** Tamaños propios de la acuarela por modo (px mundo), independientes del
      pincel vectorial y entre si: pluma fina, agua ancha. */
  private aquaSizePen = 10;
  private aquaSizeBrush = 40;

  private pointer: PointerInput;
  private tools: Record<ToolId, Tool>;
  private toolId: ToolId = DEFAULT_TOOL;
  private tempTool: ToolId | null = null;

  private wet: WetStroke | null = null;
  /** Pintar sobre la máscara de la capa activa en vez de su contenido. */
  private maskMode = false;
  /** Capa aislada (modo foco): solo ella se compone; null = todas. */
  private soloLayerId: string | null = null;
  private highlight: Body | null = null;
  private transformPivot: Vec2 | null = null;
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
    (globalThis as unknown as { __drawiEditor?: unknown }).__drawiEditor = this as unknown as never;
    this.host = host;
    this.history = new History(this.doc);

    this.inkLayer = new Layer("layer layer-ink");
    this.wetLayer = new Layer("layer layer-wet");
    this.overlayLayer = new Layer("layer layer-overlay");

    // El campo WebGL rinde a un lienzo fuera de pantalla; el compositor de
    // materia lo vuelca por capa (con su opacidad/fusión) sobre su propio
    // lienzo, que es el que se muestra encima de la tinta.
    this.fieldCanvas = document.createElement("canvas");
    this.fieldCanvas.className = "layer layer-field-src";
    this.fieldRenderer = new FieldRenderer(this.fieldCanvas);
    this.matter = new MatterCompositor(this.fieldRenderer);

    host.appendChild(this.inkLayer.canvas);
    host.appendChild(this.matter.output.canvas);
    // La acuarela ya NO tiene un plano propio en el DOM: cada capa de acuarela
    // se compone dentro de la pila de tinta (ver `Compositor`), que es lo que
    // hace que su orden en el panel cuente de verdad y que herede opacidad,
    // fusión y máscara. Sus lienzos WebGL viven fuera de pantalla.
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

    // Las instancias salen del manifiesto: ya no hay una segunda lista de clases
    // que mantener en sincronia con la union `ToolId`. `TOOLS` es la definicion
    // del conjunto, asi que el registro queda total por construccion.
    const tools = {} as Record<ToolId, Tool>;
    for (const spec of TOOLS) tools[spec.id] = spec.create();
    this.tools = tools;

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
    const sb = this.selection.bounds(this.doc);
    return {
      name: this.doc.meta.name,
      tool: this.toolId,
      brush: this.brush,
      color: this.color,
      secondaryColor: this.secondaryColor,
      palette: this.palette,
      paletteIndex: this.paletteIndex,
      symmetry: this.doc.symmetry,
      shape: this.doc.shape,
      world: this.doc.physics.settings,
      field: this.doc.field,
      pullFamily: this.pullFamily,
      recentColors: this.recentColors,
      history: this.history.status,
      zoom: this.camera.zoom,
      items: this.doc.items.length,
      bodies: this.doc.bodies.length,
      running: this.running,
      webgl: this.fieldRenderer.available && !this.matter.forceCpu,
      webglAvailable: this.fieldRenderer.available,
      fps: this.fps,
      pen: this.pen,
      background: this.doc.meta.background,
      showWalls: this.showWalls,
      debugColliders: this.debugColliders,
      showBridgeReach: this.showBridgeReach,
      matterOp: this.matterOp,
      selectOp: this.selectOp,
      keepAspect: this.keepAspect,
      snapEnabled: this.snapEnabled,
      selectSnap: this.selectSnap,
      selectBounds: sb,
      selectPivot: this.selection.pivot(this.doc),
      selectCount: this.selection.count,
      selection: this.selection,
      layers: this.doc.layers,
      activeLayerId: this.doc.activeLayerId,
      soloLayerId: this.soloLayerId,
      maskMode: this.maskMode,
      aquaAvailable: this.aquaAvailable,
      aquaMode: this.aquaMode,
      aquaSize: this.aquaMode === "brush" ? this.aquaSizeBrush : this.aquaSizePen,
      aquaLayerVisible: this.aquaLayerVisible,
      aquaLayerOpacity: this.aquaLayerOpacity,
      aquaParams: this.aquaParamsValue,
      mode3d: this.mode3d,
      scene3dAvailable: this.scene3dAvailable,
      scene3d: this.scene3dStats(),
    };
  }

  // ------------------------------------------------------------------ 3D

  /** ¿Se puede dibujar en el espacio (WebGL2 disponible)? Se sondea una sola vez. */
  get scene3dAvailable(): boolean {
    if (this.scene3dSupport === null) {
      try {
        const probe = document.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
        this.scene3dSupport = probe.getContext("webgl2") !== null;
      } catch {
        this.scene3dSupport = false;
      }
      if (!this.scene3dSupport) console.warn("[drawi] Modo 3D no disponible: sin WebGL2");
    }
    return this.scene3dSupport;
  }

  /** El visor 3D, creandolo la primera vez. `null` si no hay WebGL2. */
  get viewport3d(): Viewport3D | null {
    if (!this.scene3dAvailable) return null;
    if (!this.viewport3dInstance) {
      this.viewport3dInstance = new Viewport3D(this.host, {
        color: () => this.color,
        brush: () => this.brush,
        changed: () => {
          this.events.emit("dirty", undefined);
          this.emitState();
        },
      });
      this.viewport3dInstance.resize(this.inkLayer.width, this.inkLayer.height, this.dpr);
      this.viewport3dInstance.setBackground(this.doc.meta.background);
    }
    return this.viewport3dInstance;
  }

  /**
   * Entra o sale del modo 3D.
   *
   * Al entrar se encuadra lo dibujado: aparecer mirando a un punto vacio del
   * espacio, sin nada a la vista, hace pensar que el modo no funciona.
   */
  setMode3D(on: boolean): void {
    const vp = on ? this.viewport3d : this.viewport3dInstance;
    if (on && !vp) {
      this.status("El modo 3D necesita WebGL2");
      return;
    }

    this.mode3d = on && vp !== null;
    if (vp) {
      if (this.mode3d) {
        vp.resize(this.inkLayer.width, this.inkLayer.height, this.dpr);
        vp.setBackground(this.doc.meta.background);
        vp.setActive(true);
        vp.frameAll();
        this.status(
          "Modo 3D: dibuja con el lapiz · orbita con el boton central o el derecho · " +
            "corchetes ajustan la profundidad · F encuadra",
        );
      } else {
        vp.setActive(false);
        this.status("Vuelta al lienzo 2D");
      }
    }
    this.invalidateAll();
    this.emitState();
  }

  toggleMode3D(): void {
    this.setMode3D(!this.mode3d);
  }

  private scene3dStats(): { drawCalls: number; instances: number; strokes: number } {
    const vp = this.viewport3dInstance;
    if (!vp) return { drawCalls: 0, instances: 0, strokes: 0 };
    const s = vp.stats();
    return { drawCalls: s.drawCalls, instances: s.instances, strokes: s.strokes };
  }

  emitState(): void {
    this.events.emit("state", this.state);
  }

  status(message: string): void {
    this.events.emit("status", message);
  }

  // ------------------------------------------------------------- acuarela

  /** ¿Se puede hacer acuarela (WebGL2 disponible)? Se sondea una sola vez. */
  get aquaAvailable(): boolean {
    if (this.aquaSupport === null) {
      try {
        const probe = document.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
        this.aquaSupport = probe.getContext("webgl2") !== null;
      } catch {
        this.aquaSupport = false;
      }
      if (!this.aquaSupport) console.warn("[drawi] Acuarela no disponible: sin WebGL2");
    }
    return this.aquaSupport;
  }

  /**
   * Motor de la capa `layerId`, creándolo si hace falta y si queda cupo.
   *
   * Devuelve null cuando la capa no es de acuarela, cuando no hay WebGL2 o
   * cuando ya hay `MAX_AQUA_FIELDS` motores vivos. Quien pinta avisa al usuario;
   * quien solo dibuja (compositor, miniaturas) se limita a no pintar nada.
   */
  private aquaFieldFor(layerId: string, create = false): AquaField | null {
    const existing = this.aquaFields.get(layerId);
    if (existing) return existing;
    if (!create) return null;
    if (this.doc.layerById(layerId)?.kind !== "aqua") return null;
    if (!this.aquaAvailable) return null;
    if (this.aquaFields.size >= MAX_AQUA_FIELDS) {
      this.status(`Máximo ${MAX_AQUA_FIELDS} capas de acuarela con fluido a la vez`);
      return null;
    }
    try {
      const field = new AquaField();
      field.asLayer = true;
      // Los parámetros son del pincel, no de la capa: el motor nuevo arranca
      // con los que el usuario tiene puestos ahora mismo.
      Object.assign(field.params, this.aquaParamsValue);
      field.setWhite(this.aquaWhite);
      field.resize(this.camera.width, this.camera.height, this.dpr);
      this.aquaFields.set(layerId, field);
      return field;
    } catch (err) {
      console.warn("[drawi] No se pudo crear el fluido de acuarela:", err);
      this.aquaSupport = false;
      return null;
    }
  }

  /** Lienzo del fluido vivo de una capa (lo consulta el compositor). */
  aquaCanvasFor(layerId: string): HTMLCanvasElement | null {
    return this.aquaFields.get(layerId)?.canvas ?? null;
  }

  /** Capa de acuarela donde cae lo que se pinta ahora (la crea si no hay). */
  private aquaTargetLayer(): SceneLayer | null {
    if (!this.aquaAvailable) return null;
    const active = this.doc.activeLayer;
    if (active?.kind === "aqua") return active;
    const existing = this.doc.aquaLayers[this.doc.aquaLayers.length - 1];
    if (existing) return existing;
    // Primera pincelada de acuarela del documento: nace su capa, como la materia.
    // La instantánea va ANTES de crearla, o deshacer no la quitaría.
    const before = this.doc.snapshot();
    const layer = this.doc.addAquaLayer();
    this.history.record("Nueva capa de acuarela", before);
    this.invalidateAll();
    this.emitState();
    return layer;
  }

  /** Motor donde cae lo que se pinta ahora (crea capa y motor si hace falta). */
  private aquaTargetField(): AquaField | null {
    const layer = this.aquaTargetLayer();
    return layer ? this.aquaFieldFor(layer.id, true) : null;
  }

  /** Motor de la capa activa si es de acuarela; si no, el del último destino.
   *  Lo usan los ajustes del panel (hornear, limpiar) para saber a quién tocar. */
  private aquaCurrent(): { layer: SceneLayer; field: AquaField | null } | null {
    const active = this.doc.activeLayer;
    const layer =
      active?.kind === "aqua"
        ? active
        : this.doc.aquaLayers[this.doc.aquaLayers.length - 1];
    if (!layer) return null;
    return { layer, field: this.aquaFields.get(layer.id) ?? null };
  }

  /** Crea una capa de acuarela a mano (botón del panel de capas). */
  addAquaLayer(): void {
    if (!this.aquaAvailable) {
      this.status("Acuarela no disponible: hace falta WebGL2");
      return;
    }
    this.layerEdit("Nueva capa de acuarela", () => this.doc.addAquaLayer());
    this.status("Nueva capa de acuarela creada");
  }

  /** Modo del pincel de acuarela: pluma (pigmento) o agua. */
  get aquaMode(): "pen" | "brush" {
    return this.aquaModeValue;
  }

  setAquaMode(mode: "pen" | "brush"): void {
    this.aquaModeValue = mode;
    this.emitState();
  }

  /** Tamaño de la acuarela (px mundo) del modo activo. Independiente por modo. */
  get aquaSize(): number {
    return this.aquaMode === "brush" ? this.aquaSizeBrush : this.aquaSizePen;
  }

  setAquaSize(px: number): void {
    const v = clamp(px, 1, 400);
    if (this.aquaMode === "brush") this.aquaSizeBrush = v;
    else this.aquaSizePen = v;
    this.emitState();
  }

  /** Lee un parametro vivo de la acuarela (0..1). */
  aquaParam(key: keyof AquaParams): number {
    return this.aquaParamsValue[key];
  }

  /** Fija un parametro vivo de la acuarela (0..1) en todas las capas. */
  setAquaParam(key: keyof AquaParams, value: number): void {
    this.aquaParamsValue[key] = value;
    for (const field of this.aquaFields.values()) field.params[key] = value;
    this.emitState();
  }

  /** Tinta blanca (gouache) para la acuarela. */
  setAquaWhite(on: boolean): void {
    this.aquaWhite = on;
    for (const field of this.aquaFields.values()) field.setWhite(on);
  }

  /**
   * Hornea la capa de acuarela: el pigmento móvil se asienta en el papel.
   *
   * Hace las dos cosas que "seco" significa aquí: el fluido deja de correr
   * (`field.fix()`) y lo que ya hay se pasa a un ráster de MUNDO, así que a
   * partir de ahora acompaña al paneo y al zoom, se guarda y se exporta.
   */
  aquaFix(): void {
    const current = this.aquaCurrent();
    if (!current) {
      this.status("No hay ninguna capa de acuarela");
      return;
    }
    current.field?.fix();
    void this.bakeAquaLayer(current.layer.id, "Acuarela horneada");
  }

  /** Vacia la capa de acuarela: el fluido vivo y lo ya horneado. */
  aquaClear(): void {
    const current = this.aquaCurrent();
    if (!current) {
      this.status("No hay ninguna capa de acuarela");
      return;
    }
    this.clearAquaLayer(current.layer.id);
  }

  /** Vacia una capa de acuarela concreta (fluido y ráster horneado). */
  clearAquaLayer(id: string): void {
    const layer = this.doc.layerById(id);
    if (!layer || layer.kind !== "aqua") return;
    const field = this.aquaFields.get(id);
    if (!field?.hasContent && !layer.aquaBaked) return;
    const before = this.doc.snapshot();
    field?.clear();
    this.doc.setLayer(id, { aquaBaked: undefined, aquaRect: undefined });
    this.history.record("Limpiar acuarela", before);
    this.afterHistory("Acuarela limpiada");
  }

  /**
   * Pasa el fluido de una capa a su ráster de mundo (horneado).
   *
   * Es lo que hace que la acuarela se pueda guardar y exportar: `toDataURL` es
   * lento (décimas con un lienzo grande), así que esto se llama a mano, al
   * guardar y al exportar, nunca por fotograma ni en el autoguardado.
   */
  bakeAquaLayer(id: string, message?: string): boolean {
    const layer = this.doc.layerById(id);
    if (!layer || layer.kind !== "aqua") return false;
    const field = this.aquaFields.get(id);
    if (!field?.hasContent) return false;
    // El ráster anterior ya está decodificado en la caché del compositor; si no
    // lo estuviera todavía, se hornea solo el fluido y el viejo se respeta en el
    // siguiente horneado (nunca se pierde: `bakeAqua` compone los dos).
    const previous = layer.aquaBaked ? this.compositor.cachedImage(layer.aquaBaked) : null;
    const baked = bakeAqua(layer, field.canvas, previous, this.camera);
    if (!baked) return false;
    const before = this.doc.snapshot();
    this.doc.setLayer(id, {
      aquaBaked: baked.canvas.toDataURL("image/png"),
      aquaRect: baked.rect,
    });
    // Lo horneado ya está en el ráster: el fluido se vacía para no pintarlo dos
    // veces (el compositor dibuja ráster + fluido, uno encima del otro).
    field.clear();
    this.history.record("Hornear acuarela", before);
    this.afterHistory(message ?? "Acuarela horneada");
    return true;
  }

  /** Hornea todas las capas de acuarela con fluido vivo. Lo llama el guardado
   *  y la exportación, que necesitan la acuarela en coordenadas de mundo. */
  bakeAllAquaLayers(): number {
    let n = 0;
    for (const layer of this.doc.aquaLayers) if (this.bakeAquaLayer(layer.id)) n++;
    return n;
  }

  /** ¿Alguna capa de acuarela tiene fluido vivo sin hornear? */
  get hasLiveAqua(): boolean {
    for (const layer of this.doc.aquaLayers) {
      if (this.aquaFields.get(layer.id)?.hasContent) return true;
    }
    return false;
  }

  /** ¿La capa de acuarela de destino está visible? (compatibilidad del dock). */
  get aquaLayerVisible(): boolean {
    return this.aquaCurrent()?.layer.visible ?? true;
  }

  /** Muestra u oculta la capa de acuarela de destino. */
  setAquaVisible(on: boolean): void {
    const current = this.aquaCurrent();
    if (!current) return;
    this.setLayer(current.layer.id, { visible: on });
    this.status(on ? "Capa acuarela visible" : "Capa acuarela oculta");
  }

  /** Opacidad de la capa de acuarela de destino (0..1). */
  get aquaLayerOpacity(): number {
    return this.aquaCurrent()?.layer.opacity ?? 1;
  }

  setAquaOpacity(v: number): void {
    const current = this.aquaCurrent();
    if (!current) return;
    this.setLayer(current.layer.id, { opacity: clamp01(v) });
  }

  /** ¿El pincel esta en modo acuarela y se puede simular? */
  get aquaBrushActive(): boolean {
    return this.brush.asAqua && this.aquaAvailable;
  }

  /**
   * Siembra un TRAZO (linea central con radios, en mundo) en la capa de
   * acuarela de destino. Convierte cada punto a UV de pantalla y su radio (px
   * mundo) a la escala Y-normalizada del fluido. Asi el trazo humedo sigue
   * exactamente la geometria del pincel vectorial (presion/afilado incluidos).
   */
  stampAquaStroke(points: readonly import("../stroke/types").StrokePoint[], color: string): void {
    const field = this.aquaTargetField();
    if (!field || points.length === 0) return;
    field.setPigment(color);
    const dens = this.aquaMode === "brush" ? 0 : 0.9;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const p: Vec2 = { x: 0, y: 0 };
    // El trazo conserva la dinamica de presion del pincel (variacion relativa de
    // pt.r), pero su grosor base lo fija el tamaño propio de la acuarela, no el
    // del pincel vectorial: se reescala por aquaSize/brushSize.
    const sizeScale = this.aquaSize / Math.max(this.brush.size, 1);
    const uvPts = points.map((pt) => {
      this.camera.worldToScreen(pt, p);
      // Radio: px mundo -> px pantalla (x zoom) -> fraccion de alto (como el splat).
      const rScreen = pt.r * sizeScale * this.camera.zoom;
      return { x: p.x / w, y: 1 - p.y / h, r: Math.max(rScreen / h, 0.002) };
    });
    field.stampStroke(uvPts, dens);
    this.inkLayer.invalidate();
    this.status(dens === 0 ? "Agua" : "Acuarela");
  }

  /**
   * Siembra AREAS rellenas (poligonos en mundo) en la capa de acuarela de
   * destino: para el modo Relleno y las formas de Arrastre. Cada poligono se
   * rasteriza como mancha.
   */
  stampAquaArea(polys: readonly import("../stroke/types").Polygon[], color: string): void {
    const field = this.aquaTargetField();
    if (!field || polys.length === 0) return;
    field.setPigment(color);
    const dens = this.aquaMode === "brush" ? 0 : 0.9;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const p: Vec2 = { x: 0, y: 0 };
    for (const poly of polys) {
      if (poly.length < 3) continue;
      const uv = poly.map((pt) => {
        this.camera.worldToScreen(pt, p);
        return { x: p.x / w, y: 1 - p.y / h };
      });
      field.stampArea(uv, dens);
    }
    this.inkLayer.invalidate();
    this.status(dens === 0 ? "Agua" : "Acuarela");
  }

  /** Suelta los motores de capas que ya no existen (borradas, deshechas o de un
   *  documento anterior). Devuelve cuántos ha soltado. */
  private pruneAquaFields(): number {
    const live = new Set(this.doc.aquaLayers.map((l) => l.id));
    let n = 0;
    for (const [id, field] of [...this.aquaFields]) {
      if (live.has(id)) continue;
      field.dispose();
      this.aquaFields.delete(id);
      n++;
    }
    return n;
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
    this.pushRecentColor(hex);
    this.emitState();
  }

  /** Fija el color secundario (el círculo sobrepuesto de la rueda de color). */
  setSecondaryColor(hex: string): void {
    this.secondaryColor = hex;
    this.emitState();
  }

  /** Intercambia el color activo con el secundario (tecla X, estilo Photoshop).
      El fondo no se toca: para eso está la tecla C (color ⇄ fondo). */
  swapColors(): void {
    const prev = this.color;
    this.color = this.secondaryColor;
    this.secondaryColor = prev;
    this.pushRecentColor(this.color);
    this.emitState();
  }

  /** Registra un color en el historial: lo lleva al frente, sin duplicados, y
      recorta a 15. Así el panel de color muestra siempre lo último usado. */
  private pushRecentColor(hex: string): void {
    const norm = hex.toLowerCase();
    const next = this.recentColors.filter((c) => c.toLowerCase() !== norm);
    next.unshift(hex);
    this.recentColors = next.slice(0, 15);
  }

  setPalette(index: number): void {
    this.paletteIndex = clamp(index, 0, DEFAULT_PALETTES.length - 1);
    this.emitState();
  }

  setSymmetry(patch: Partial<SymmetryState>): void {
    const before = this.doc.snapshot();
    const s = this.doc.symmetry;
    // Mantener lastMode coherente: cada vez que se fija un modo activo,
    // ese pasa a ser el recordado para el proximo toggle.
    if (patch.mode !== undefined && patch.mode !== "none") {
      s.lastMode = patch.mode;
    }
    Object.assign(s, patch);
    // Compat: proyectos viejos sin lastMode → derivarlo del mode cargado.
    if (!(s as unknown as { lastMode: unknown }).lastMode) {
      (s as unknown as { lastMode: string }).lastMode = s.mode !== "none" ? s.mode : "mirror";
    }
    if (patch.mode !== undefined && patch.mode !== "none") {
      // Al activarla por primera vez se coloca en el centro de la vista.
      if (s.x === 0 && s.y === 0) {
        s.x = this.camera.x;
        s.y = this.camera.y;
      }
    }
    this.history.record("Simetria", before);
    this.overlayLayer.invalidate();
    this.emitState();
  }

  /** S (tecla dedicada): activa/desactiva recordando el ultimo tipo usado. */
  toggleSymmetry(): void {
    const s = this.doc.symmetry;
    // Asegurar lastMode valido si viene de documento viejo
    const last = (s.lastMode as unknown as string) && (s.lastMode as string) !== "none" ? s.lastMode : "mirror";
    if (s.mode === "none") {
      this.setSymmetry({ mode: last as typeof s.mode });
    } else {
      // Recuerda el que apaga para poder volver a el
      s.lastMode = s.mode as typeof s.lastMode;
      this.setSymmetry({ mode: "none" });
    }
  }

  setShape(patch: Partial<ShapeDef>): void {
    this.doc.shape = { ...this.doc.shape, ...patch };
    this.overlayLayer.invalidate();
    this.emitState();
  }

  setWorld(patch: Partial<WorldSettings>): void {
    Object.assign(this.doc.physics.settings, patch);
    this.doc.physics.wakeAll();
    this.matter.invalidate();
    this.emitState();
  }

  setField(patch: Partial<FieldStyle>): void {
    this.doc.field = { ...this.doc.field, ...patch };
    this.matter.invalidate();
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
    this.viewport3dInstance?.setBackground(hex);
    this.history.record("Fondo", before);
    this.emitState();
  }

  // --------------------------------------------------------------- capas

  /** Ejecuta una mutación de capas registrándola en el historial y refrescando. */
  private layerEdit(label: string, run: () => void): void {
    const before = this.doc.snapshot();
    run();
    this.history.record(label, before);
    // Una capa puede haber desaparecido (borrado, aplanado): sus motores de
    // acuarela sueltan el contexto WebGL2 aquí, que es el único sitio por donde
    // pasan todas las mutaciones de capas.
    this.pruneAquaFields();
    this.inkLayer.invalidate();
    this.emitState();
  }

  addLayer(): void {
    this.layerEdit("Nueva capa", () => this.doc.addLayer());
  }

  addGroup(): void {
    this.layerEdit("Nuevo grupo", () => this.doc.addGroup());
  }

  addMatterLayer(): void {
    this.layerEdit("Nueva capa de materia", () => this.doc.addMatterLayer());
    this.status("Nueva capa de materia creada");
  }

  removeLayer(id: string): void {
    this.layerEdit("Borrar capa", () => this.doc.removeLayer(id));
  }

  duplicateLayer(id: string): void {
    this.layerEdit("Duplicar capa", () => this.doc.duplicateLayer(id));
  }

  mergeLayerDown(id: string): void {
    this.layerEdit("Combinar capa", () => this.doc.mergeDown(id));
  }

  flattenLayers(): void {
    this.layerEdit("Aplanar", () => this.doc.flatten());
  }

  /** Reubica una capa: a `parentId` (null = raíz), en la posición `index` entre
   *  sus hermanas contando de abajo arriba (0 = la más baja). */
  moveLayerTo(id: string, parentId: string | null, index: number): void {
    this.layerEdit("Reordenar capa", () => this.doc.moveLayerTo(id, parentId, index));
    this.matter.invalidate();
  }

  /** Cambios de propiedad de capa (opacidad, fusión, ojo, bloqueos, nombre…). */
  setLayer(id: string, patch: Partial<SceneLayer>): void {
    this.layerEdit("Ajustar capa", () => this.doc.setLayer(id, patch));
    // La materia se compone por capa: opacidad, fusión y visibilidad se aplican
    // al volcar cada capa, así que basta con marcar el compositor sucio.
    if (this.doc.layerById(id)?.kind === "matter") this.matter.invalidate();
  }

  /** Lienzo compuesto de la materia (el que se muestra sobre la tinta). */
  private matterCanvas(): HTMLCanvasElement {
    return this.matter.output.canvas;
  }

  setLayerColor(id: string, color: LayerColor): void {
    this.layerEdit("Color de capa", () => this.doc.setLayerColor(id, color));
  }

  toggleLayerMask(id: string, on?: boolean): void {
    this.layerEdit("Máscara de capa", () => this.doc.toggleMask(id, on));
  }

  invertLayerMask(id: string): void {
    this.layerEdit("Invertir máscara", () => this.doc.invertMask(id));
  }

  /** Selecciona la capa activa (sin historial: no altera el documento). */
  setActiveLayer(id: string): void {
    this.doc.setActiveLayer(id);
    this.inkLayer.invalidate();
    this.emitState();
  }

  /** Alterna el modo de foco (aislar una capa) sin tocar el documento. */
  toggleSolo(id: string): void {
    this.soloLayerId = this.soloLayerId === id ? null : id;
    this.inkLayer.invalidate();
    this.emitState();
  }

  /** Alterna el modo máscara: el pincel pinta la máscara de la capa activa. */
  setMaskMode(on: boolean): void {
    if (this.maskMode === on) return;
    this.maskMode = on;
    // Al entrar en modo máscara, garantizar que la capa activa tenga máscara.
    if (on) {
      const layer = this.doc.activeLayer;
      if (layer && layer.kind !== "matter" && !layer.mask) this.doc.toggleMask(layer.id, true);
    }
    this.inkLayer.invalidate();
    this.emitState();
  }

  toggleMaskMode(): void {
    this.setMaskMode(!this.maskMode);
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

  setMatterOp(op: MatterOp): void {
    this.matterOp = op;
    this.emitState();
  }

  // ------------------- Seleccion universal (Flecha · V)
  setSelectOp(op: SelectOp): void { this.selectOp = op; this.overlayLayer.invalidate(); this.emitState(); }
  setKeepAspect(on: boolean): void { this.keepAspect = on; this.emitState(); }
  setSnap(on: boolean): void { this.snapEnabled = on; this.emitState(); }
  clearSelection(): void { this.selection.clear(); this.overlayLayer.invalidate(); this.emitState(); }
  selectAll(): void {
    const sel = this.selection;
    sel.clear();
    for (const it of this.doc.items) if (!this.doc.layerById(it.layerId)?.locked) sel.inkIds.add(it.id);
    for (const l of this.doc.layers) if (l.kind === "image" && !l.locked) sel.imageIds.add(l.id);
    for (const b of this.doc.bodies) if (!this.doc.layerById(b.layerId)?.locked) sel.bodyIds.add(b.id);
    this.overlayLayer.invalidate(); this.emitState();
  }
  deleteSelection(): void {
    const sel = this.selection;
    if (sel.empty || sel.isLocked(this.doc)) { this.status("Capa bloqueada"); return; }
    const before = this.doc.snapshot();
    const inkIds = new Set(sel.inkIds);
    this.doc.items = this.doc.items.filter((it) => !inkIds.has(it.id));
    for (const id of sel.imageIds) this.doc.removeLayer(id);
    for (const id of sel.bodyIds) this.doc.physics.remove(id);
    sel.clear();
    this.history.record("Borrar selección", before);
    this.afterHistory("Selección borrada");
  }
  duplicateSelection(): void {
    const sel = this.selection;
    if (sel.empty || sel.isLocked(this.doc)) { this.status("Capa bloqueada"); return; }
    const before = this.doc.snapshot();
    const off = 18;
    for (const id of [...sel.inkIds]) {
      const it = this.doc.items.find((i) => i.id === id);
      if (!it) continue;
      const copy = { ...it, id: Math.random().toString(36).slice(2), polys: it.polys.map((p) => p.map((q) => ({ ...q }))), transforms: it.transforms.map((m) => ({ ...m, e: m.e + off, f: m.f + off })), bounds: { x: it.bounds.x + off, y: it.bounds.y + off, w: it.bounds.w, h: it.bounds.h }, gy0: it.gy0 + off, gy1: it.gy1 + off } as import("../scene/types").InkItem;
      this.doc.items.push(copy);
    }
    for (const id of [...sel.imageIds]) {
      const dup = this.doc.duplicateLayer(id); if (dup) { dup.imageX = (dup.imageX ?? 0) + off; dup.imageY = (dup.imageY ?? 0) + off; }
    }
    for (const id of [...sel.bodyIds]) {
      const b = this.doc.physics.bodies.find((bb) => bb.id === id); if (!b) continue;
      const nb = createBody({ ...b.shape }, { x: b.pos.x + off, y: b.pos.y + off }, { color: b.color, group: b.group, blend: b.blend, bridgeReach: b.bridgeReach, isStatic: b.isStatic, density: b.density, restitution: b.restitution, friction: b.friction, layerId: b.layerId });
      nb.angle = b.angle; this.doc.physics.add(nb);
    }
    this.history.record("Duplicar selección", before);
    this.afterHistory("Selección duplicada");
  }
  alignSelection(dir: "left" | "center" | "right" | "top" | "middle" | "bottom"): void {
    const b = this.selection.bounds(this.doc);
    if (!b || this.selection.isLocked(this.doc)) return;
    const before = this.doc.snapshot();
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let dx = 0, dy = 0;
    if (dir === "left") dx = b.x - cx;
    else if (dir === "right") dx = (b.x + b.w) - cx;
    else if (dir === "center") dx = 0;
    if (dir === "top") dy = b.y - cy;
    else if (dir === "bottom") dy = (b.y + b.h) - cy;
    else if (dir === "middle") dy = 0;
    if (dx !== 0) {
      for (const id of this.selection.inkIds) { const it = this.doc.items.find((i) => i.id === id); if (it) { for (const m of it.transforms) m.e += -dx; it.bounds.x += -dx; } }
      for (const id of this.selection.imageIds) { const l = this.doc.layerById(id); if (l) l.imageX = (l.imageX ?? 0) - dx; }
      for (const id of this.selection.bodyIds) { const bb = this.doc.physics.bodies.find((b_) => b_.id === id); if (bb) { bb.pos.x -= dx; syncTransform(bb); } }
    }
    if (dy !== 0) {
      for (const id of this.selection.inkIds) { const it = this.doc.items.find((i) => i.id === id); if (it) { for (const m of it.transforms) m.f += -dy; it.bounds.y += -dy; } }
      for (const id of this.selection.imageIds) { const l = this.doc.layerById(id); if (l) l.imageY = (l.imageY ?? 0) - dy; }
      for (const id of this.selection.bodyIds) { const bb = this.doc.physics.bodies.find((b_) => b_.id === id); if (bb) { bb.pos.y -= dy; syncTransform(bb); } }
    }
    this.doc.inkRevision++; this.matter.invalidate(); this.overlayLayer.invalidate();
    this.history.record("Alinear selección", before);
    this.emitState();
  }

  toggleBridgeReach(): void {
    this.showBridgeReach = !this.showBridgeReach;
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
    // Deshacer puede haber borrado capas de acuarela (o resucitado otras): los
    // motores de las que ya no están tienen que soltar su contexto WebGL2.
    this.pruneAquaFields();
    this.inkLayer.invalidate();
    this.matter.invalidate();
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

  /** Vacía solo los cuerpos de una capa de materia (sin borrar la capa). */
  clearMatterLayer(id: string): void {
    if (this.doc.physics.bodiesOf(id).length === 0) return;
    const before = this.doc.snapshot();
    this.doc.clearMatter(id);
    this.history.record("Vaciar capa de materia", before);
    this.afterHistory("Capa de materia vaciada");
  }

  clearAll(): void {
    if (this.doc.isEmpty) return;
    const before = this.doc.snapshot();
    this.doc.clearAll();
    this.history.record("Limpiar todo", before);
    this.afterHistory("Lienzo limpio");
  }

  /** Convierte los trazos de la capa de tinta activa en capsulas fisicas. */
  convertInkToMatter(): void {
    const layer = this.doc.activeLayer;
    if (!layer || layer.kind !== "ink") {
      this.status("Selecciona una capa de tinta para convertirla en materia");
      return;
    }
    const eligible = this.doc.layerItems(layer.id).some((item) => !item.erase);
    if (!eligible) {
      this.status("La capa no tiene trazos convertibles");
      return;
    }
    const before = this.doc.snapshot();
    const created = this.doc.convertInkLayerToMatter(layer.id);
    if (created === 0) {
      this.status("No se pudo convertir ningún trazo");
      return;
    }
    this.history.record("Tinta a materia", before);
    this.afterHistory(`${created} cuerpos creados desde tinta`);
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
    const bridges = computeBridges(bodies, this.doc.field.bridgeReach);
    const bridgeOpts = {
      style: BRIDGE_STYLE_CODE[this.doc.field.bridgeStyle] ?? 0,
      threads: Math.max(1, Math.round(this.doc.field.bridgeThreads)),
      threadReach: this.doc.field.bridgeThreadReach,
      flare: Math.max(0, this.doc.field.bridgeFlare),
      time: 0,
    };
    const loops = fieldContours(bodies, this.doc.field.blend, { cell: 2.5 }, bridges, bridgeOpts);
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
    const target = this.doc.matterTarget();
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
          layerId: target.id,
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

  // ---------------------------------------------------------- rotacion / volteo de lienzo
  // Vista (solo gira la camara) y contenido (transforma documento con matriz).

  /** Gira solo la vista (camera) — no toca el documento. */
  setCanvasRotation(deg: number): void {
    // Normaliza a [-180,180] para que el slider sea estable
    let d = ((deg + 180) % 360) - 180;
    if (d <= -180) d += 360;
    this.camera.rotation = (d * Math.PI) / 180;
    this.invalidateAll();
    this.emitState();
  }

  rotateViewBy(deltaDeg: number): void {
    this.setCanvasRotation((this.camera.rotation * 180) / Math.PI + deltaDeg);
  }

  resetCanvasRotation(): void {
    this.setCanvasRotation(0);
  }

  /** Rota el CONTENIDO 90°/180° alrededor del centro de la vista. */
  rotateContent(deg: 90 | 180 | -90 | number): void {
    const a = deg === 90 || deg === -90 || deg === 180 ? deg : Math.round(Number(deg) || 0);
    if (a === 0) return;
    const before = this.doc.snapshot();
    const cx = this.camera.x;
    const cy = this.camera.y;
    // Construir G como rotacion pura alrededor de cx,cy
    const rad = (a * Math.PI) / 180;
    const G = rotationAround(rad, cx, cy);
    this.applyGlobalMat(G, a === 180 ? "Rotar 180" : a === 90 ? "Rotar 90 horario" : a === -90 ? "Rotar 90 antihorario" : `Rotar ${a}°`, before);
  }

  flipContentHorizontal(): void {
    const before = this.doc.snapshot();
    const cx = this.camera.x;
    const cy = this.camera.y;
    // Reflejar segun eje de vista: horizontal = espejo izquierda/derecha → reflejo respecto a eje vertical de pantalla
    const ang = this.camera.rotation + Math.PI / 2;
    const G = reflectionAbout(ang, cx, cy);
    this.applyGlobalMat(G, "Voltear horizontal", before);
  }

  flipContentVertical(): void {
    const before = this.doc.snapshot();
    const cx = this.camera.x;
    const cy = this.camera.y;
    const ang = this.camera.rotation;
    const G = reflectionAbout(ang, cx, cy);
    this.applyGlobalMat(G, "Voltear vertical", before);
  }

  private applyGlobalMat(G: Mat2d, label: string, before: import("../scene/document").SceneSnapshot): void {
    const Ginv = invert(G);
    if (!Ginv) return;
    // Tinta: polys + transforms conjugados
    for (const item of this.doc.items) {
      for (const poly of item.polys) {
        for (const v of poly) {
          const p = applyMat(G, v);
          v.x = p.x; v.y = p.y;
        }
      }
      for (let i = 0; i < item.transforms.length; i++) {
        const m = item.transforms[i];
        // G * m * Ginv
        item.transforms[i] = multiply(multiply(G, m), Ginv);
      }
      // Recalcular bounds desde poligonos + transforms
      let nb: import("../scene/types").Rect | null = null;
      for (const poly of item.polys) {
        if (poly.length < 3) continue;
        const pb = polygonBounds(poly);
        for (const m of item.transforms) nb = unionRect(nb, transformRect(pb, m));
      }
      if (nb) {
        item.bounds = nb;
        item.gy0 = nb.y;
        item.gy1 = nb.y + nb.h;
      }
    }
    // Materia
    for (const body of this.doc.physics.bodies) {
      const np = applyMat(G, body.pos);
      body.pos.x = np.x; body.pos.y = np.y;
      const dir = { x: Math.cos(body.angle), y: Math.sin(body.angle) };
      const nd = applyDirMat(G, dir);
      body.angle = Math.atan2(nd.y, nd.x);
      syncTransform(body);
    }
    // Simetria
    {
      const np = applyMat(G, { x: this.doc.symmetry.x, y: this.doc.symmetry.y });
      this.doc.symmetry.x = np.x; this.doc.symmetry.y = np.y;
      const dir = { x: Math.cos(this.doc.symmetry.angle), y: Math.sin(this.doc.symmetry.angle) };
      const nd = applyDirMat(G, dir);
      this.doc.symmetry.angle = Math.atan2(nd.y, nd.x);
    }
    // Imagenes
    for (const layer of this.doc.layers) {
      if (layer.kind === "image" && layer.imageX !== undefined) {
        const np = applyMat(G, { x: layer.imageX, y: layer.imageY ?? 0 });
        layer.imageX = np.x; layer.imageY = np.y;
        const a = layer.imageAngle ?? 0;
        const dir = { x: Math.cos(a), y: Math.sin(a) };
        const nd = applyDirMat(G, dir);
        layer.imageAngle = Math.atan2(nd.y, nd.x);
      }
    }
    this.doc.inkRevision++;
    this.history.record(label, before);
    this.invalidateAll();
    this.emitState();
  }

  invalidateAll(): void {
    this.inkLayer.invalidate();
    this.matter.invalidate();
    this.overlayLayer.invalidate();
  }

  /**
   * Fotografía cruda del pipeline para el panel de diagnóstico (Ctrl+Alt+D).
   * Expone los lienzos reales y el estado interno sin dar acceso de escritura:
   * el panel solo lee y sondea píxeles para distinguir "no se pinta" de "se
   * pinta pero no se ve".
   */
  debugState(): DiagSnapshot {
    return {
      host: this.host,
      dpr: this.dpr,
      camera: this.camera,
      doc: this.doc,
      fieldAvailable: this.fieldRenderer.available,
      soloId: this.soloLayerId,
      maskMode: this.maskMode,
      canvases: [
        { name: "tinta", role: "ink", canvas: this.inkLayer.canvas, dirty: this.inkLayer.dirty },
        { name: "materia", role: "field", canvas: this.matterCanvas(), dirty: this.matter.dirty },
        { name: "húmedo", role: "wet", canvas: this.wetLayer.canvas, dirty: this.wetLayer.dirty },
        { name: "superpuesto", role: "overlay", canvas: this.overlayLayer.canvas, dirty: this.overlayLayer.dirty },
      ],
    };
  }

  /**
   * Alterna el motor del campo entre GPU (WebGL2) y el respaldo CPU. Sin efecto
   * si WebGL2 no está disponible (no hay a qué volver). Devuelve el modo nuevo:
   * true = GPU. Sirve para comparar ambos renders a mano.
   */
  toggleEngine(): boolean {
    if (!this.fieldRenderer.available) return false;
    this.matter.forceCpu = !this.matter.forceCpu;
    this.matter.invalidate();
    this.status(this.matter.forceCpu ? "Campo por CPU (forzado)" : "Campo por GPU (WebGL2)");
    this.emitState();
    return !this.matter.forceCpu;
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
    // El documento es otro: los motores de acuarela del anterior ya no valen
    // (sus capas no existen) y hay que devolver sus contextos WebGL2.
    this.pruneAquaFields();
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
      this.toolCtx.matterOp = this.matterOp;
      (this.toolCtx as unknown as { selectOp: SelectOp }).selectOp = this.selectOp;
      (this.toolCtx as unknown as { keepAspect: boolean }).keepAspect = this.keepAspect;
      (this.toolCtx as unknown as { selection: Selection }).selection = this.selection;
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
      matterOp: this.matterOp,
      selectOp: this.selectOp,
      keepAspect: this.keepAspect,
      selection: this.selection,
      toWorld(s: InputSample, out?: Vec2): Vec2 {
        return editor.camera.screenToWorld(s.x, s.y, out);
      },
      setColor(hex: string): void {
        editor.setColor(hex);
      },
      setWet(wet: WetStroke | null): void {
        editor.wet = wet;
        // El trazo húmedo se compone dentro de la capa activa: siempre hay que
        // recomponer la tinta para verlo en vivo (pinte contenido o máscara).
        // Si pinta materia y la capa activa no es de tinta, además se repinta la
        // capa húmeda flotante (encima del plano de materia).
        editor.inkLayer.invalidate();
        if (editor.wetIsOverlay) editor.wetLayer.invalidate();
      },
      commitWet(wet: WetStroke): void {
        // La materia (y los grupos) no admiten tinta. Si la capa activa no es de
        // tinta, el trazo se redirige a la primera capa de tinta y esta se vuelve
        // activa: así dibujar NUNCA produce trazos invisibles (antes el item se
        // asignaba a la pseudo-capa "Materia", que el compositor omite).
        let layer = editor.doc.activeLayer;
        if (!layer || layer.kind !== "ink") {
          const target = editor.doc.inkTarget();
          if (target.id !== editor.doc.activeLayerId) {
            editor.doc.setActiveLayer(target.id);
            editor.status(`La materia no admite tinta: se dibuja en "${target.name}"`);
          }
          layer = target;
        }
        if (layer.locked) {
          editor.status("Capa bloqueada");
          editor.wet = null;
          editor.inkLayer.invalidate();
          return;
        }
        const item = editor.doc.buildItem(
          wet.polys,
          wet.color,
          wet.opacity,
          wet.smooth,
          wet.gradient,
          wet.erase,
        );
        if (!item) return;
        item.transforms = wet.transforms;
        if (editor.maskMode) {
          // En modo máscara el trazo va a la máscara de la capa, no al lienzo.
          editor.doc.addMaskStroke(layer.id, item);
        } else {
          // Alfa bloqueado: el item se compondrá con source-atop (no se derrama).
          if (layer.alphaLock) item.atop = true;
          editor.doc.addItem(item);
        }
        editor.inkLayer.invalidate();
        editor.emitState();
        editor.events.emit("dirty", undefined);
      },
      invalidateInk(): void {
        editor.inkLayer.invalidate();
      },
      invalidateField(): void {
        editor.matter.invalidate();
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
      setPivot(p): void {
        editor.transformPivot = p;
        editor.overlayLayer.invalidate();
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
      get aquaBrushActive(): boolean {
        return editor.aquaBrushActive;
      },
      stampAquaStroke(points, color): void {
        editor.stampAquaStroke(points, color);
      },
      stampAquaArea(polys, color): void {
        editor.stampAquaArea(polys, color);
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

  /**
   * Muestrea el color compuesto del lienzo (fondo + capas) en un punto de
   * pantalla. Usado por el picker y por el HUD para adaptar su contraste.
   */
  sampleScreenColor(x: number, y: number): string | null {
    const ctx = this.pickCtx;
    const sx = Math.round(x * this.dpr);
    const sy = Math.round(y * this.dpr);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = this.doc.meta.background;
    ctx.fillRect(0, 0, 1, 1);
    const sources: HTMLCanvasElement[] = [
      this.inkLayer.canvas,
      this.matter.output.canvas,
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
    // Los atajos salen del manifiesto. `shift` los separa porque la simetria usa
    // Shift+S: la `S` a secas es un INTERRUPTOR (toggleSymmetry), no un cambio de
    // herramienta, y su bloque corre antes que este despacho.
    //
    // `plain` NO consulta e.shiftKey a proposito: hoy Shift+V tambien selecciona
    // la flecha. Endurecerlo haria que Shift+B/F/M/P dejaran de cambiar de
    // herramienta — seria un cambio de comportamiento, no un refactor.
    const plain: Record<string, ToolId> = {};
    const shifted: Record<string, ToolId> = {};
    for (const k of TOOL_KEYS) (k.shift ? shifted : plain)[k.key] = k.id;

    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Solo se bloquea el atajo cuando de verdad se está escribiendo texto (un
      // campo de texto o editable). Deslizadores, interruptores y botones NO son
      // texto: con ellos enfocados, deshacer/rehacer y los atajos deben seguir
      // funcionando (antes cualquier <input> tragaba Ctrl+Z tras tocar el borrador).
      const editingText =
        tag === "TEXTAREA" ||
        !!target?.isContentEditable ||
        (tag === "INPUT" && isTextInput(target as HTMLInputElement));
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z") {
        if (editingText) return;
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        if (editingText) return;
        e.preventDefault();
        this.redo();
        return;
      }

      // Entrar y salir del espacio. Lleva Ctrl a proposito: el 3 a secas ya
      // selecciona el modo arrastre del pincel, y robar esa tecla habria sido una
      // regresion silenciosa.
      if (mod && !editingText && e.key === "3") {
        e.preventDefault();
        this.toggleMode3D();
        return;
      }

      // Atajos de capas (todos con Ctrl/Cmd). No deben dispararse tecleando.
      if (mod && !editingText) {
        const k = e.key.toLowerCase();
        // Nueva capa (Ctrl+Shift+N) / nuevo grupo (Ctrl+Shift+G).
        if (e.shiftKey && k === "n") { e.preventDefault(); this.addLayer(); return; }
        if (e.shiftKey && k === "g") { e.preventDefault(); this.addGroup(); return; }
        // Recorte a la capa inferior (Ctrl+G).
        if (!e.shiftKey && k === "g") {
          e.preventDefault();
          const l = this.doc.activeLayer;
          if (l && l.kind !== "matter") this.setLayer(l.id, { clip: !l.clip });
          return;
        }
        // Invertir la máscara de la capa activa (Ctrl+I).
        if (k === "i") {
          e.preventDefault();
          const l = this.doc.activeLayer;
          if (l?.mask) this.invertLayerMask(l.id);
          return;
        }
      }
      if (mod) return;

      // El resto de atajos de una tecla no deben dispararse mientras se teclea.
      if (editingText) return;

      // Alt alterna "usar como borrador": invierte los modos de pintura a borrado.
      // Es el mismo estado que el toggle del panel, así que ambos se sincronizan.
      if (e.key === "Alt") {
        if (e.repeat) return;
        e.preventDefault();
        this.setBrush({ invertErase: !this.brush.invertErase });
        this.status(this.brush.invertErase ? "Borrador temporal (Alt)" : "Pincel normal");
        return;
      }

      if (HELD_TOOL && e.code === "Space" && this.tempTool !== HELD_TOOL) {
        e.preventDefault();
        this.tempTool = HELD_TOOL;
        this.host.style.cursor = "grab";
        return;
      }
      const key = e.key.toLowerCase();
      // S: toggle de simetria (activa/desactiva recordando el ultimo tipo) SIN
      // cambiar de herramienta: sigues con el pincel y dibujas con simetria al
      // instante. Shift+S abre la herramienta Simetria para arrastrar el eje.
      // Es la unica entrada de `shifted`: la `S` a secas no cambia de herramienta,
      // asi que no puede vivir en `plain`.
      if (key === "s") {
        e.preventDefault();
        const sym = shifted[key];
        if (e.shiftKey && sym) {
          this.setTool(sym);
          this.status("Herramienta Simetria — arrastra el eje");
        } else {
          this.toggleSymmetry();
          const m = this.doc.symmetry.mode;
          this.status(m === "none" ? "Simetria desactivada" : `Simetria activa — ${SYMMETRY_LABELS[m]}`);
        }
        return;
      }
      if (plain[key]) {
        this.setTool(plain[key]);
        this.status(TOOL_LABELS[plain[key]]);
        return;
      }
      switch (key) {
        case "1":
          this.setBrush({ mode: "stroke" });
          this.status("Pincel · Trazo");
          break;
        case "2":
          this.setBrush({ mode: "fill" });
          this.status("Pincel · Relleno");
          break;
        case "3":
          this.setBrush({ mode: "pull" });
          this.status("Pincel · Arrastre");
          break;
        case "4":
          this.setBrush({ mode: "erase" });
          this.status("Pincel · Borrador");
          break;
        case "5":
          this.setBrush({ asMatter: !this.brush.asMatter });
          this.status(this.brush.asMatter ? "Pincel pinta materia" : "Pincel pinta tinta");
          break;
        case "[":
          this.setBrush({ size: Math.max(0.5, this.brush.size * 0.85) });
          this.status(`Grosor ${Math.round(this.brush.size)} px`);
          break;
        case "]":
          this.setBrush({ size: Math.min(400, this.brush.size * 1.18) });
          this.status(`Grosor ${Math.round(this.brush.size)} px`);
          break;
        case "g":
          this.setBrush({ gradient: !this.brush.gradient });
          this.status(this.brush.gradient ? "Degradado activo" : "Degradado desactivado");
          break;
        case "p":
          this.setBrush({ splat: !this.brush.splat });
          this.status(this.brush.splat ? "Salpicado activo" : "Salpicado desactivado");
          break;
        case "0":
          this.resetView();
          this.status("Vista restablecida");
          break;
        case "escape":
          if (this.toolId === "select" && !this.selection.empty) { this.clearSelection(); break; }
          if (this.maskMode) this.setMaskMode(false);
          else this.onCancel();
          break;
        case "delete":
        case "backspace":
          if (e.shiftKey) { this.clearAll(); break; }
          // Supr sin Shift borra la capa activa (incluida la materia, con sus
          // cuerpos). Nunca deja el documento sin tinta; es reversible con Ctrl+Z.
          {
            const l = this.doc.activeLayer;
            if (l) this.removeLayer(l.id);
          }
          break;
        default:
          break;
      }
    };

    this.keyUpHandler = (e: KeyboardEvent) => {
      if (HELD_TOOL && e.code === "Space" && this.tempTool === HELD_TOOL) {
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
    this.overlayLayer.resize(w, h, dpr);
    this.fieldRenderer.resize(w, h, dpr);
    this.matter.resize(w, h, dpr);
    for (const field of this.aquaFields.values()) field.resize(w, h, dpr);
    this.viewport3dInstance?.resize(w, h, dpr);
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

    // En modo 3D no se dibuja el lienzo 2D. Dos renderizadores a plena frecuencia
    // cuando solo se ve uno es justo el desperdicio que hay que evitar, y de paso
    // congela la fisica y el fluido mientras se dibuja en el espacio.
    if (this.mode3d && this.viewport3dInstance) {
      this.viewport3dInstance.frame();
      return;
    }

    if (this.running && this.doc.bodies.length > 0) {
      const walls = this.doc.physics.settings.walls;
      if (walls) {
        const v = this.camera.visibleBounds(0);
        this.doc.physics.bounds = v;
      }
      const moving = this.doc.bodies.some((b) => b.awake);
      if (moving || this.doc.physics.dragging) {
        this.doc.physics.update(dt);
        this.matter.invalidate();
      }
    }

    // Acuarela: cada capa con fluido avanza y se repinta mientras siga viva
    // (unos segundos tras el ultimo deposito). Dormida no consume GPU. Los
    // trazos se siembran al soltar el pincel (ver stampAqua), no aqui.
    // Como la acuarela se compone DENTRO de la pila de tinta, mientras el fluido
    // se mueve hay que recomponerla: es el precio de que su orden Z cuente.
    let aquaMoving = false;
    for (const [id, field] of this.aquaFields) {
      if (!field.active) continue;
      if (!this.doc.layerById(id)) continue; // capa borrada: se suelta abajo
      field.step(dt);
      field.render();
      aquaMoving = true;
    }
    if (aquaMoving) this.inkLayer.invalidate();

    if (this.inkLayer.dirty) {
      // El compositor compone todas las capas (orden, opacidad, relleno, fusión,
      // máscara, alfa y recorte) y pinta en vivo el trazo húmedo dentro de la
      // capa activa (o su máscara, en modo máscara). Si la vista previa pinta
      // materia, se salta aquí y se pinta flotante en la capa húmeda.
      this.compositor.composite(this.inkLayer, this.doc, this.camera, {
        wet: this.wet,
        activeLayerId: this.doc.activeLayerId,
        maskMode: this.maskMode,
        soloId: this.soloLayerId,
        wetAsOverlay: this.wetIsOverlay,
        aquaCanvas: (id) => this.aquaCanvasFor(id),
      });
      this.inkLayer.dirty = false;
    }

    // Puentes organicos: ondulan con el tiempo (solo en GPU; el shader lee
    // uTime). En CPU quedan estaticos para no re-extraer contornos cada frame.
    // La animacion va ligada al boton Pausar/Reanudar del menu Materia: si la
    // simulacion esta pausada, los puentes tambien se congelan.
    if (
      this.running &&
      this.doc.field.bridgeStyle === "organic" &&
      this.fieldRenderer.available &&
      !this.matter.forceCpu &&
      (this.doc.field.bridgeReach > 0 || this.doc.bodies.some((b) => b.bridgeReach > 0))
    ) {
      this.matter.invalidate();
    }

    if (this.matter.dirty) {
      // Cada capa de materia se rinde y compone con su opacidad/fusión sobre un
      // único lienzo que se muestra encima de la tinta.
      const t = this.running ? now / 1000 : 0;
      this.matter.render(this.doc, this.camera, this.dpr, t);
    }

    if (this.wetLayer.dirty) {
      // El trazo húmedo se compone dentro de la capa activa (compositor), así
      // respeta su opacidad/fusión/máscara/alfa. EXCEPTO cuando pinta sobre la
      // materia (toggle "Hacer materia" del pincel): las capas de materia no se
      // componen, así que la vista previa se pinta aquí, en la capa húmeda, que
      // va ENCIMA del plano de materia y permite ver el trazo mientras se
      // dibuja antes de convertirse en cuerpos.
      const w = this.wet;
      if (w && this.wetIsOverlay) this.paintWetOverlay(w);
      else this.wetLayer.clear();
      this.wetLayer.dirty = false;
    }

    if (this.overlayLayer.dirty) {
      this.overlayLayer.clear();
      this.overlayRenderer.render(this.overlayLayer, this.overlayState(), this.camera);
      this.overlayLayer.dirty = false;
    }
  }

  /** ¿La vista previa vive en la capa húmeda (materia) y no en la tinta? */
  private get wetIsOverlay(): boolean {
    const layer = this.doc.activeLayer;
    return this.brush.asMatter && !!layer && layer.kind !== "ink";
  }

  /**
   * Pinta el trazo húmedo sobre la capa húmeda cuando se dibuja materia: color
   * de tinta normal con un trazo de contorno suave para que se distinga del
   * campo de materia ya asentado debajo.
   */
  private paintWetOverlay(w: WetStroke): void {
    this.wetLayer.clear();
    const ctx = this.wetLayer.ctx;
    this.camera.applyTo(ctx, this.wetLayer.dpr);
    this.compositor.paintFloatingStroke(ctx, w);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
      transformPivot: this.transformPivot ?? this.selection.pivot(this.doc) ?? null,
      showWalls: this.showWalls,
      walls: this.doc.physics.bounds,
      debugColliders: this.debugColliders,
      showBridgeReach: this.showBridgeReach || this.toolId === "bridge",
      bridgeReach: this.doc.field.bridgeReach,
      bodies: this.doc.bodies,
      selectBounds: this.selection.bounds(this.doc),
      selectPivot: this.selection.pivot(this.doc),
      selectOp: this.selectOp,
      isSelectTool: this.toolId === "select",
    };
  }

  dispose(): void {
    this.stop();
    this.pointer.dispose();
    this.fieldRenderer.dispose();
    // El visor 3D abre su propio contexto WebGL2: hay que soltarlo o el
    // navegador se queda sin cupo al abrir y cerrar el editor varias veces.
    this.viewport3dInstance?.dispose();
    this.viewport3dInstance = null;
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

// Tipos de <input> que NO editan texto: con ellos enfocados los atajos de
// teclado (incluido Ctrl+Z) siguen activos. El resto se trata como texto.
const NON_TEXT_INPUT = new Set([
  "range",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "color",
  "file",
  "image",
]);

function isTextInput(el: HTMLInputElement): boolean {
  return !NON_TEXT_INPUT.has(el.type);
}
