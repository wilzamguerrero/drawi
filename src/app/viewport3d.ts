/**
 * Visor 3D: el modo de dibujo espacial.
 *
 * Es autonómo a proposito. El editor 2D tiene su propio bucle, sus herramientas y
 * su gestion de puntero; meter el 3D ahi dentro habria obligado a tocar todas las
 * herramientas. En su lugar, el visor pone su propio lienzo encima y **captura el
 * puntero antes de que llegue al editor**: los manejadores del 2D escuchan en fase
 * de burbuja sobre el anfitrion, asi que un `stopPropagation` en fase de captura
 * sobre el lienzo del visor basta para que el motor 2D no vea nada mientras el
 * modo 3D esta activo. Ni una herramienta tiene que saber que el 3D existe.
 *
 * Dos reglas de interaccion, y las dos importan:
 *
 *  - **Navegar nunca dibuja.** La orbita va con el boton central, el derecho o la
 *    barra espaciadora. El boton izquierdo y la punta del lapiz son siempre para
 *    pintar.
 *  - **Dibujar nunca mueve la camara.** Un gesto de trazo no toca el estado de la
 *    camara en absoluto.
 *
 * El trazo se dibuja sobre un **plano de profundidad fija** que mira a la camara.
 * Es la decision que hace que dibujar funcione sin configurar nada: el trazo
 * aparece justo bajo el cursor. El boceto libre en el aire, sin plano, es lo que
 * academicamente se sabe que falla -el usuario pierde la profundidad y no acierta
 * donde pinta-, asi que el plano es fijo y la profundidad se ajusta aparte.
 */

import { DEFAULT_BRUSH, type BrushSettings, type Polygon } from "../stroke/types";
import { Stroke3DBuilder } from "../scene3d/builder";
import { StrokeScene } from "../scene3d/batch";
import { radiusAt, type Sample3D, type Stroke3D } from "../scene3d/types";
import type { SceneDocument } from "../scene/document";
import type { History } from "../app/history";
import {
  CameraController3D,
  clampZoomFactor,
  rayToDepthPlane,
  snapDepth,
} from "../scene3d/controls3d";
import {
  DEFAULT_CAMERA_3D,
  forwardOf,
  projectPoint,
  rightOf,
  upOf,
  viewProjection,
  type Camera3DState,
} from "../scene3d/camera3d";
import { Scene3DBackend, type LayerPaint } from "../render3d/backend";
import { relaxStroke, touches } from "../scene3d/relax";
import type { Scene3DSettings } from "../scene3d/tools3d";
import {
  MAX_OUTLINE_POINTS,
  FillScene,
  makeFill,
  outlineArea,
} from "../scene3d/fill";
import { placePullShape, pullShape, randomPullShape, type PullFamily } from "../tools/pull-shapes";
import { Rng, uid } from "../core/rng";
import { v3, type V3 } from "../scene3d/vec3";

/** Recurso de un lote cuya capa ya no existe: no se dibuja. */
const HIDDEN_PAINT: LayerPaint = { visible: false, opacity: 1, order: 0 };

/**
 * Grosor del contorno con el que se enseña un relleno o un arrastre mientras se
 * dibujan, en unidades de mundo.
 *
 * Es fino y constante a proposito: no es la pintura, es el borde de lo que va a
 * quedar. Con el grosor del pincel, un pincel grueso taparia con la vista previa
 * justo lo que se esta intentando encuadrar.
 */
const OUTLINE_WIDTH = 2.5;

/**
 * Area minima de una mancha, en unidades de mundo al cuadrado.
 *
 * Por debajo de esto el gesto fue un tiron y no un contorno: rellenarlo dejaria
 * una astilla que nadie pidio. El valor es pequeno a proposito -una mancha de
 * cuatro unidades de lado ya pasa-, porque quien decide el tamano es quien dibuja.
 */
const MIN_FILL_AREA = 8;

/**
 * Gesto en curso.
 *
 * - `stroke`: el trazado normal, con su vista previa en vivo.
 * - `erase`: barrido del borrador; va borrando lo que toca por el camino.
 * - `pull`: agarra los puntos que caen dentro del radio y los arrastra. Guarda la
 *   forma ORIGINAL de lo agarrado, porque el desplazamiento se aplica entero sobre
 *   ella en cada fotograma; acumularlo sobre la forma ya movida haria que el trazo
 *   se fuese quedando donde no se pidio.
 * - `smooth`: relaja lo que va tocando el puntero, acumulando pasadas mientras se
 *   insiste, que es como se dosifica un suavizado a mano.
 * - `fill`: acumula el contorno para rellenarlo al soltar. Mientras dura, la cinta
 *   provisional pinta ese contorno, que es lo unico que se puede enseñar en el
 *   acto: la mancha no existe hasta que el gesto cierra.
 * - `pull`: estira una forma geometrica entre donde se apoya y donde esta el
 *   puntero, que es lo que hace el arrastre en el lienzo. La forma se calcula en
 *   coordenadas del plano de dibujo y se sube al espacio, asi que se reutilizan
 *   las mismas familias -blob, hoja, astilla...- que en 2D.
 * - `erase`: barrido del borrador; va borrando lo que toca por el camino.
 * - `smooth`: relaja lo que va tocando el puntero, acumulando pasadas mientras se
 *   insiste, que es como se dosifica un suavizado a mano.
 */
type Gesture =
  | { kind: "stroke"; planeNormal: V3 }
  | { kind: "fill"; planeNormal: V3; outline: number[]; minStep: number }
  | {
      kind: "pull";
      /** Base del plano de dibujo: pasar del mundo a 2D y volver. */
      origin: V3;
      u: V3;
      w: V3;
      /** Donde se apoyo el lapiz y donde esta ahora, en coordenadas del plano. */
      a: { x: number; y: number };
      b: { x: number; y: number };
      /** La forma de la familia activa, en espacio unitario. */
      shape: Polygon;
    }
  | { kind: "erase"; erasing: boolean }
  | { kind: "smooth" }
  | null;

/** Rejilla de profundidad, en unidades de mundo. */
const DEPTH_STEP = 25;

/** Radio de captura del borrador, en pixeles de pantalla. */
const ERASE_SLOP = 10;

export interface Viewport3DHost {
  /** Color activo del editor. */
  color(): string;
  /** Ajustes del pincel activo. */
  brush(): BrushSettings;
  /** Familia de forma del arrastre activa; "random" elige una distinta cada vez. */
  pullFamily(): PullFamily | "random";
  /** El documento: los trazos del espacio viven en el, no en el visor. */
  doc(): SceneDocument;
  /** Historial, para que las operaciones del espacio sean deshacibles. */
  history(): History;
  /** Ajustes propios del visor: herramienta, radio de agarre y fuerza. */
  settings(): Scene3DSettings;
  /** Avisa al editor de algo que el usuario debe leer. */
  status(message: string): void;
  /** Avisa de que el estado cambio (para refrescar la interfaz). */
  changed(): void;
}

export class Viewport3D {
  readonly canvas: HTMLCanvasElement;
  readonly scene = new StrokeScene();
  /** Manchas del espacio. Igual que `scene`, es un derivado del documento. */
  readonly fills = new FillScene();
  readonly camera: Camera3DState = { ...DEFAULT_CAMERA_3D };

  private readonly controls = new CameraController3D(this.camera);
  private readonly backend: Scene3DBackend;
  private readonly builder = new Stroke3DBuilder({ ...DEFAULT_BRUSH });
  /**
   * Constructor propio para el contorno de lo que se esta encuadrando -un relleno
   * o un arrastre-.
   *
   * Va aparte del de dibujo y con el pincel domado: sin ruido, sin estabilizador,
   * sin afilado y de grosor fino y constante. Es un borde, no pintura; con el
   * pincel real, un pincel grueso taparia con la vista previa justo lo que se
   * esta intentando encuadrar.
   */
  private readonly outline = new Stroke3DBuilder({
    ...DEFAULT_BRUSH,
    size: OUTLINE_WIDTH,
    dynamics: "constant",
    smoothing: 0,
    streamline: 0,
    jitter: 0,
    taperIn: 0,
    taperOut: 0,
  });
  private readonly rng = new Rng();
  private readonly api: Viewport3DHost;
  private readonly hud: HTMLDivElement;

  /**
   * El espacio recibe el puntero.
   *
   * Es una cosa distinta de "el lienzo se ve": el espacio se ve siempre que tenga
   * algo que enseñar, este activo o no, porque salirse de el no debe hacer
   * desaparecer lo dibujado. Lo que cambia al activarlo es quien atiende el raton.
   */
  private live = false;
  /** El lienzo del espacio esta en pantalla. Ver `frame`. */
  private showing = false;
  /** Fondo del documento, que solo se pinta cuando el espacio ocupa la vista. */
  private background = "#f4f1ea";
  /**
   * Gesto en curso, o `null`.
   *
   * Es un unico campo con una etiqueta en vez de varios booleanos porque los
   * gestos son excluyentes y porque cada uno necesita llevar sus propios datos:
   * el arrastre guarda de donde salio y la forma original de lo que agarro.
   */
  private gesture: Gesture = null;
  /** Revision del documento que los lotes ya reflejan. Evita reconciliar en cada
   *  fotograma algo que solo cambia cuando alguien dibuja o deshace. */
  private syncedRevision = -1;
  /** Revision de la pila de capas que ya se pinto. Ver `syncScene`. */
  private syncedInk = -1;
  /** Firma de la pila que ya se pinto: identidad, ojo y opacidad de cada capa. */
  private syncedLayers = "";
  /**
   * Ultima muestra cruda bajo el puntero.
   *
   * La vista previa anade esta cola al trazo en curso: el muestreo minimo del
   * constructor hace que el ultimo punto guardado vaya por detras del cursor, y
   * sin ella el trazo se veria retrasado respecto al lapiz.
   */
  private tail: Sample3D | null = null;
  /** Ultimo punto de pantalla por el que paso el borrador, para no dejar huecos. */
  private eraseFrom: { x: number; y: number } | null = null;
  private depth = 0;
  private space = false;
  private dirty = true;
  private disposers: Array<() => void> = [];

  constructor(host: HTMLElement, api: Viewport3DHost) {
    this.api = api;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "layer layer-3d";
    host.appendChild(this.canvas);

    this.backend = new Scene3DBackend(this.canvas);

    this.hud = document.createElement("div");
    this.hud.className = "hud-3d";
    host.appendChild(this.hud);

    this.attach(host);
    this.setActive(false);
    this.updateHud();
  }

  get available(): boolean {
    return this.backend.available;
  }

  get error(): string | null {
    return this.backend.error;
  }

  get active(): boolean {
    return this.live;
  }

  /** Profundidad actual del plano de dibujo, en unidades de mundo. */
  get planeDepth(): number {
    return this.depth;
  }

  /**
   * Fondo del visor.
   *
   * Se toma del documento y no se fija en negro: la tinta por defecto del
   * editor es negra, y sobre un fondo oscuro el trazo seria invisible. Ademas,
   * entrar al espacio y encontrarse otro color hace que se sienta como haber
   * abierto otra aplicacion, que es justo lo que hay que evitar.
   */
  setBackground(css: string): void {
    this.background = css;
    this.applyBackground();
  }

  /**
   * El fondo depende de si el espacio ocupa la vista o esta compuesto encima del
   * lienzo 2D.
   *
   * Dentro del espacio el lienzo lo es todo y lleva el fondo del documento,
   * porque sobre negro la tinta por defecto no se veria. Compuesto sobre el
   * lienzo 2D tiene que ser TRANSPARENTE: si no, taparia el dibujo entero.
   */
  private applyBackground(): void {
    this.canvas.style.background = this.live ? this.background : "transparent";
  }

  /**
   * El espacio toma el puntero, o lo suelta.
   *
   * Ya **no** oculta el lienzo: el espacio se ve tambien cuando no esta activo, y
   * esa es la diferencia entre un modo del que se sale y una capa con la que se
   * convive. Lo que se apaga al soltarlo es la atencion del puntero, no la imagen.
   */
  setActive(on: boolean): void {
    this.live = on && this.backend.available;
    this.canvas.style.pointerEvents = this.live ? "" : "none";
    this.hud.style.display = this.live ? "" : "none";
    this.applyBackground();
    if (this.live) {
      // El punto de vista viaja con el documento: al volver al espacio se vuelve
      // a donde se estaba mirando, no a un encuadre por defecto.
      Object.assign(this.camera, this.api.doc().camera3d);
      this.controls.viewportHeight = this.canvas.clientHeight || 800;
      this.resetDepth();
      this.dirty = true;
      this.updateHud();
    } else {
      this.saveCamera();
      this.cancelGesture();
    }
  }

  /** Guarda el punto de vista en el documento para que sobreviva al guardado. */
  saveCamera(): void {
    this.api.doc().camera3d = { ...this.camera };
  }

  resize(width: number, height: number, dpr: number): void {
    this.controls.viewportHeight = height;
    this.backend.resize(width, height, dpr);
    this.dirty = true;
  }

  /**
   * Pone los lotes de acuerdo con el documento, y marca sucio si algo cambio.
   *
   * Son dos avisos distintos y los dos hacen falta. `spaceRevision` dice que
   * cambio el dibujo del espacio; `inkRevision` dice que cambio la pila de capas
   * -un ojo, una opacidad, un reordenamiento-, que no toca ni un vertice pero
   * cambia la imagen. Sin el segundo, apagar una capa dejaba el lienzo con el
   * fotograma anterior: el visor solo redibuja cuando algo lo marca sucio, y
   * conserva el buffer de dibujado.
   */
  /**
   * Pone los lotes de acuerdo con el documento, y marca sucio si algo cambio.
   *
   * Son dos avisos distintos y los dos hacen falta. `spaceRevision` dice que
   * cambio el dibujo del espacio; la pila de capas dice como se pinta -un ojo, una
   * opacidad, un reordenamiento-, que no toca ni un vertice pero cambia la imagen.
   * Sin el segundo, apagar una capa dejaba el lienzo con el fotograma anterior.
   *
   * La pila se mira por FIRMA y no por `inkRevision`, porque `inkRevision` sube
   * tambien cada vez que se pinta tinta en el lienzo 2D, y eso no cambia nada de
   * lo que se ve aqui: sin la firma, cada trazo de tinta en 2D obligaria a
   * redibujar el espacio entero.
   */
  private syncScene(): void {
    const doc = this.api.doc();
    if (doc.spaceRevision !== this.syncedRevision) {
      this.scene.sync(doc.strokes3d);
      this.fills.sync(doc.fills3d);
      this.syncedRevision = doc.spaceRevision;
      this.dirty = true;
    }
    if (doc.inkRevision !== this.syncedInk) {
      this.syncedInk = doc.inkRevision;
      const firma = this.layerSignature(doc);
      if (firma !== this.syncedLayers) {
        this.syncedLayers = firma;
        this.dirty = true;
      }
    }
  }

  /** Lo de la pila de capas que cambia lo que se ve: identidad, ojo y opacidad. */
  private layerSignature(doc: SceneDocument): string {
    let s = "";
    for (const l of doc.layers) s += `${l.id}:${l.visible ? 1 : 0}:${l.opacity};`;
    return s;
  }

  /**
   * Como se pinta cada capa: ojo, opacidad y sitio en la pila.
   *
   * El mapa se rehace en cada sincronizacion porque las capas son pocas y
   * reordenarlas o apagar una no debe obligar a reconstruir ni un vertice.
   */
  private paintMap(): Map<string, LayerPaint> {
    const doc = this.api.doc();
    const map = new Map<string, LayerPaint>();
    for (let i = 0; i < doc.layers.length; i++) {
      const l = doc.layers[i];
      map.set(l.id, { visible: doc.layerVisible(l.id), opacity: l.opacity, order: i });
    }
    return map;
  }

  /** Encaja la vista en todo lo dibujado. */
  frameAll(): void {
    this.syncScene();
    const paint = this.paintMap();
    const paintOf = (id: string): LayerPaint => paint.get(id) ?? HIDDEN_PAINT;
    this.backend.sync(this.scene.all, paintOf);
    this.backend.syncFills(this.fills.all, paintOf);
    const b = this.backend.bounds();
    if (!b) {
      this.camera.px = 0;
      this.camera.py = 0;
      this.camera.pz = 0;
      this.camera.distance = 900;
    } else {
      this.camera.px = b.cx;
      this.camera.py = b.cy;
      this.camera.pz = b.cz;
      this.camera.distance = Math.max(50, b.radius / Math.tan(this.camera.fovY * 0.5));
    }
    this.resetDepth();
    this.dirty = true;
    this.saveCamera();
    this.updateHud();
  }

  /** Devuelve el estado de dibujado al plano por defecto, delante del punto de mira. */
  resetDepth(): void {
    this.depth = 0;
  }

  adjustDepth(steps: number): void {
    this.depth = snapDepth(this.depth + steps * DEPTH_STEP, DEPTH_STEP);
    this.updateHud();
  }

  /**
   * Un fotograma.
   *
   * Se llama tambien cuando el espacio NO esta activo: si tiene algo que enseñar,
   * se dibuja compuesto sobre el lienzo 2D y se queda ahi. De ahi que la primera
   * decision sea si hay que enseñarlo, antes que si hay que repintarlo.
   */
  frame(): void {
    if (!this.backend.available) return;
    const doc = this.api.doc();

    // El lienzo solo se aparta cuando no hay nada del espacio a la vista. Dejarlo
    // siempre puesto costaria componer un lienzo WebGL a pantalla completa en
    // cada fotograma para no enseñar nada.
    const want = this.live || this.hasVisibleSpace(doc);
    if (want !== this.showing) {
      this.showing = want;
      this.canvas.style.display = want ? "" : "none";
      this.dirty = true;
    }
    if (!this.showing) return;

    // El aviso de cambio se mira ANTES de tocar nada: `syncScene` son dos
    // comparaciones, y con el espacio a la vista pero quieto -que es como estara
    // la mayor parte del tiempo mientras se dibuja en el lienzo- no hay motivo
    // para rehacer el mapa de capas ni para volver a sincronizar los lotes en
    // cada fotograma.
    this.syncScene();
    const tracing = this.gesture?.kind === "stroke";
    const contouring = this.gesture?.kind === "fill" || this.gesture?.kind === "pull";
    if (!this.dirty && !tracing && !contouring) return;

    const paint = this.paintMap();
    const paintOf = (id: string): LayerPaint => paint.get(id) ?? HIDDEN_PAINT;
    this.backend.sync(this.scene.all, paintOf);
    this.backend.syncFills(this.fills.all, paintOf);
    // La vista previa se rehace una vez por fotograma y no una por evento de
    // puntero: el navegador puede entregar varios eventos coalescidos entre dos
    // fotogramas, y recomponer la cinta para cada uno seria trabajo tirado.
    let live: Stroke3D | null = null;
    if (tracing) live = this.builder.preview(this.tail);
    else if (contouring) live = this.outline.preview(null);
    this.backend.setLive(live);
    this.backend.render(this.camera);
    this.dirty = false;
  }

  /**
   * ¿Hay algo del espacio que enseñar?
   *
   * Basta con que exista una capa del espacio visible y que haya trazos o
   * manchas: mirar capa por capa cual tiene contenido costaria un recorrido del
   * dibujo entero en cada fotograma, y el caso raro -todo el contenido en una
   * capa oculta mientras otra esta vacia y visible- solo deja un lienzo
   * transparente de mas, que no se ve.
   */
  private hasVisibleSpace(doc: SceneDocument): boolean {
    if (doc.strokes3d.length === 0 && doc.fills3d.length === 0) return false;
    for (const l of doc.scene3dLayers) if (doc.layerVisible(l.id)) return true;
    return false;
  }

  stats(): {
    drawCalls: number;
    instances: number;
    bytes: number;
    fillVertices: number;
    strokes: number;
    fills: number;
  } {
    // Los trazos y las manchas se cuentan en el DOCUMENTO y no en los lotes: los
    // lotes son datos derivados y su reparto en rangos -con huecos de lo borrado-
    // no es lo que el usuario tiene dibujado.
    const doc = this.api.doc();
    return { ...this.backend.stats(), strokes: doc.strokes3d.length, fills: doc.fills3d.length };
  }

  /** Borra todo lo dibujado en el espacio, en todas sus capas. */
  clear(): void {
    const doc = this.api.doc();
    if (doc.strokes3d.length === 0 && doc.fills3d.length === 0) return;
    this.api.history().begin();
    for (const l of doc.scene3dLayers) {
      doc.clearStrokes3D(l.id);
      doc.clearFills3D(l.id);
    }
    this.api.history().commit("Borrar el espacio");
    this.dirty = true;
    this.updateHud();
    this.api.changed();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.backend.dispose();
    this.canvas.remove();
    this.hud.remove();
  }

  // ------------------------------------------------------------- entrada

  /**
   * Los manejadores van en fase de captura y cortan la propagacion.
   *
   * Es lo que hace que el editor 2D no vea ni un evento mientras el visor esta
   * activo, sin que haya que desactivar sus propias escuchas ni que el 2D sepa
   * que existe un modo 3D.
   */
  private attach(host: HTMLElement): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts: AddEventListenerOptions = { capture: true },
    ): void => {
      const handler = (e: Event): void => {
        if (!this.live) return;
        e.stopPropagation();
        fn(e as HTMLElementEventMap[K]);
      };
      this.canvas.addEventListener(type, handler, opts);
      this.disposers.push(() => this.canvas.removeEventListener(type, handler, opts));
    };

    on("pointerdown", (e) => this.onDown(e));
    on("pointermove", (e) => this.onMove(e), { capture: true, passive: false });
    on("pointerup", (e) => this.onUp(e));
    on("pointercancel", () => this.cancelGesture());
    on("wheel", (e) => this.onWheel(e), { capture: true, passive: false });
    on("contextmenu", (e) => e.preventDefault());

    // El espacio se escucha en la ventana pero solo se atiende en modo 3D; el
    // editor 2D tambien lo mira, asi que se corta la propagacion solo mientras
    // el visor esta activo.
    const keyDown = (e: KeyboardEvent): void => {
      if (!this.live) return;
      if (e.code === "Space") {
        this.space = true;
        e.stopPropagation();
        e.preventDefault();
        this.updateHud();
      } else if (e.code === "BracketLeft") {
        this.adjustDepth(1);
      } else if (e.code === "BracketRight") {
        this.adjustDepth(-1);
      } else if (e.code === "KeyF") {
        this.frameAll();
      }
    };
    const keyUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") {
        this.space = false;
        if (this.live) {
          e.stopPropagation();
          this.updateHud();
        }
      }
    };
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp, true);
    this.disposers.push(() => window.removeEventListener("keydown", keyDown, true));
    this.disposers.push(() => window.removeEventListener("keyup", keyUp, true));

    void host;
  }

  private mods(e: {
    shiftKey: boolean;
    altKey: boolean;
    pointerType?: string;
  }): { shift: boolean; alt: boolean; space: boolean; pen: boolean } {
    return {
      shift: e.shiftKey,
      alt: e.altKey,
      space: this.space,
      pen: e.pointerType === "pen",
    };
  }

  private onDown(e: PointerEvent): void {
    // Con un gesto ya en marcha, un segundo puntero no empieza otro. Importa sobre
    // todo con el boton lateral del lapiz: pulsarlo a mitad de un trazo llamaba al
    // borrador, y ese `history.begin()` pisaba la instantanea que el gesto tenia
    // pendiente, de modo que deshacer despues devolvia un estado equivocado.
    if (this.gesture) return;

    this.canvas.setPointerCapture(e.pointerId);
    const r = this.rect();

    if (this.controls.begin(e.button, this.mods(e), e.clientX - r.left, e.clientY - r.top)) {
      e.preventDefault();
      this.updateHud();
      return;
    }

    // El borrador del lapiz llega como boton 5; Alt hace lo mismo con cualquier
    // puntero. Se mira ANTES de descartar los botones que no son el izquierdo, y
    // borra un trazo entero de un golpe sea cual sea el modo activo.
    if (e.button === 5 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      this.eraseAt(e);
      return;
    }

    if (e.button !== 0) return;
    e.preventDefault();
    this.beginGesture(e);
  }

  private onMove(e: PointerEvent): void {
    if (this.controls.navigating) {
      const r = this.rect();
      this.controls.move(e.clientX - r.left, e.clientY - r.top, this.mods(e));
      this.dirty = true;
      return;
    }
    if (!this.gesture) return;
    e.preventDefault();
    this.moveGesture(e);
  }

  private onUp(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.controls.navigating) {
      this.controls.end();
      this.updateHud();
      return;
    }
    this.endGesture();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.rect();
    const ndcX = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
    const factor = clampZoomFactor(Math.exp(-e.deltaY * 0.0018));
    this.controls.zoomAt(factor, ndcX, ndcY, r.width / Math.max(1, r.height));
    this.dirty = true;
    this.updateHud();
  }

  // --------------------------------------------------------------- gestos

  /**
   * Decide que hace el gesto segun el modo del pincel.
   *
   * Son los mismos modos del lienzo, y aqui significan lo que su nombre dice. La
   * herramienta de suavizado se antepone a todos: es del visor y no del pincel,
   * asi que manda sobre el modo.
   */
  private beginGesture(e: PointerEvent): void {
    if (this.api.settings().tool === "smooth") {
      this.beginEdit(e);
      return;
    }

    const brush = this.api.brush();
    if (brush.mode === "erase") {
      this.api.history().begin();
      this.gesture = { kind: "erase", erasing: false };
      this.eraseAlong(e);
      return;
    }
    if (brush.mode === "pull") {
      this.beginPull(e);
      return;
    }
    if (brush.mode === "fill") {
      this.beginFill(e);
      return;
    }
    this.beginStroke(e);
  }

  private moveGesture(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "stroke") {
      this.pushStroke(e);
      return;
    }
    if (g.kind === "fill") {
      this.pushFill(e);
      return;
    }
    if (g.kind === "pull") {
      this.movePull(e);
      return;
    }
    if (g.kind === "erase") {
      this.eraseAlong(e);
      return;
    }
    const p = this.worldPoint(e);
    if (!p) return;
    this.smoothAt(p);
  }

  private endGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    this.eraseFrom = null;
    if (!g) return;

    const history = this.api.history();
    if (g.kind === "stroke") {
      const stroke = this.builder.finalize();
      this.builder.cancel();
      this.tail = null;
      if (!stroke) return;
      history.begin();
      // La mejora al soltar se aplica ANTES de guardar: lo que entra en el
      // documento es ya lo definitivo, asi que deshacerlo es un solo paso.
      this.api.doc().addStroke3D(this.refine(stroke));
      history.commit("Trazo en el espacio");
      this.dirty = true;
      this.updateHud();
      this.api.changed();
      return;
    }

    if (g.kind === "fill") {
      this.outline.cancel();
      this.tail = null;
      this.closeFill(g);
      this.updateHud();
      return;
    }

    if (g.kind === "pull") {
      this.outline.cancel();
      this.tail = null;
      this.closePull(g);
      this.updateHud();
      return;
    }

    if (g.kind === "erase") {
      // Si el gesto no se llevo nada, no hay nada que deshacer.
      if (g.erasing) history.commit("Borrar en el espacio");
      else history.abort();
    } else {
      // Queda el suavizado: el arrastre y el relleno ya salieron arriba.
      history.commit("Suavizar trazos");
      this.api.changed();
    }
    this.updateHud();
  }

  private cancelGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    this.eraseFrom = null;
    this.tail = null;
    this.builder.cancel();
    this.outline.cancel();
    this.controls.end();
    // El trazado, el relleno y el arrastre no tocaron el documento -solo el
    // constructor-, pero suavizar si lo modifico: cancelar es volver a la
    // instantanea que se fotografio al empezar, sin dejar rastro en el historial.
    if (g && g.kind === "smooth") {
      this.api.history().rollback();
      this.dirty = true;
      this.updateHud();
    }
  }

  // ---------------------------------------------------------------- trazo

  private beginStroke(e: PointerEvent): void {
    const p = this.worldPoint(e);
    if (!p) return;

    const brush = this.api.brush();
    this.builder.settings = brush;
    this.builder.setZoom(1);
    const planeNormal = forwardOf(this.camera, { x: 0, y: 0, z: 0 });
    this.gesture = { kind: "stroke", planeNormal };

    const doc = this.api.doc();
    const sample = this.sampleOf(e, p);
    this.tail = sample;
    this.builder.begin(sample, {
      brush: brush.mode === "erase" ? "ribbon" : brush.mode,
      color: this.api.color(),
      // La capa sale del documento, no de un literal: es lo que hace que el trazo
      // caiga en la capa del espacio que el usuario tenga elegida.
      layerId: doc.scene3dTarget().id,
      planeNormal,
    });
    this.dirty = true;
  }

  private pushStroke(e: PointerEvent): void {
    const p = this.worldPoint(e);
    if (!p) return;
    const samples = this.coalescedSamples(e);
    if (samples.length === 0) return;
    this.tail = samples[samples.length - 1];
    this.builder.push(samples);
    this.dirty = true;
  }

  /** Mejora el trazo recien cerrado, si el ajuste lo pide. */
  private refine(stroke: Stroke3D): Stroke3D {
    const s = this.api.settings();
    if (!s.refineOnRelease) return stroke;
    return (
      relaxStroke(stroke, {
        strength: s.refineStrength,
        iterations: 2,
        radius: true,
        ends: false,
      }) ?? stroke
    );
  }

  /**
   * Muestras de un evento, con las coalescidas.
   *
   * El navegador entrega varios eventos entre dos fotogramas cuando el puntero va
   * rapido: usarlos todos es lo que hace que un trazo veloz no salga a saltos.
   */
  private coalescedSamples(e: PointerEvent): Sample3D[] {
    const out: Sample3D[] = [];
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of events.length > 0 ? events : [e]) {
      const q = this.worldPoint(ev as PointerEvent);
      if (!q) continue;
      out.push(this.sampleOf(ev as PointerEvent, q));
    }
    return out;
  }

  // --------------------------------------------------------------- relleno

  /**
   * Empieza un contorno para rellenarlo.
   *
   * El camino se acumula aparte de la cinta provisional. La cinta sirve para VER
   * el contorno mientras se dibuja -es lo unico que se puede enseñar, porque la
   * mancha no existe hasta que el gesto cierra-, pero el relleno se construye con
   * el camino crudo, sin decimar ni afilar.
   */
  private beginFill(e: PointerEvent): void {
    const p = this.worldPoint(e);
    if (!p) return;
    const planeNormal = forwardOf(this.camera, { x: 0, y: 0, z: 0 });
    const brush = this.api.brush();
    this.gesture = {
      kind: "fill",
      planeNormal,
      outline: [p.x, p.y, p.z],
      // Mismo criterio de muestreo que el constructor: medio radio. Un contorno
      // con puntos mas juntos que eso solo engorda la triangulacion.
      minStep: Math.max(0.55, brush.size * 0.25),
    };
    const sample = this.sampleOf(e, p);
    this.tail = sample;
    this.outline.begin(sample, {
      brush: "fill",
      color: this.api.color(),
      layerId: this.api.doc().scene3dTarget().id,
      planeNormal,
    });
    this.dirty = true;
  }

  private pushFill(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.kind !== "fill") return;
    const p = this.worldPoint(e);
    if (!p) return;
    const samples = this.coalescedSamples(e);
    if (samples.length > 0) {
      this.tail = samples[samples.length - 1];
      this.outline.push(samples);
    }
    this.appendOutline(g, p.x, p.y, p.z);
    this.dirty = true;
  }

  /**
   * Anade un punto al contorno, con el muestreo minimo.
   *
   * Al llegar al tope se diezma el contorno a la mitad y se dobla la distancia
   * minima: asi un gesto larguisimo se sigue aceptando, con menos detalle, en vez
   * de dejar de crecer o de dispararse en memoria.
   */
  private appendOutline(
    g: { outline: number[]; minStep: number },
    x: number,
    y: number,
    z: number,
  ): void {
    const n = g.outline.length;
    if (n >= 3) {
      const dx = x - g.outline[n - 3];
      const dy = y - g.outline[n - 2];
      const dz = z - g.outline[n - 1];
      if (Math.hypot(dx, dy, dz) < g.minStep) return;
    }
    if (n / 3 >= MAX_OUTLINE_POINTS) {
      const reducido: number[] = [];
      for (let i = 0; i < n / 3; i += 2) {
        reducido.push(g.outline[i * 3], g.outline[i * 3 + 1], g.outline[i * 3 + 2]);
      }
      g.outline = reducido;
      g.minStep *= 2;
    }
    g.outline.push(x, y, z);
  }

  /**
   * Cierra el contorno y lo convierte en mancha.
   *
   * Se descartan los gestos que no encierran area: un tiron no es un contorno, y
   * rellenarlo dejaria una astilla que nadie pidio. Se avisa, en vez de no hacer
   * nada en silencio.
   */
  private closeFill(g: { planeNormal: V3; outline: number[] }): void {
    const count = g.outline.length / 3;
    if (count < 3) {
      this.api.status("El relleno necesita un contorno cerrado");
      return;
    }
    const outline = new Float32Array(g.outline);
    if (outlineArea(outline, count, g.planeNormal) < MIN_FILL_AREA) {
      this.api.status("Ese gesto no encierra area: no hay nada que rellenar");
      return;
    }

    const doc = this.api.doc();
    const fill = makeFill(uid(), outline, count, {
      color: this.api.color(),
      layerId: doc.scene3dTarget().id,
      planeNormal: g.planeNormal,
    });
    const history = this.api.history();
    history.begin();
    doc.addFill3D(fill);
    history.commit("Relleno en el espacio");
    this.dirty = true;
    this.api.changed();
  }

  // ------------------------------------------------- suavizar y arrastrar

  /**
   * Empieza a suavizar.
   *
   * Abre un paso de historial, porque el gesto entero -con sus muchos fotogramas-
   * tiene que deshacerse de una vez.
   */
  private beginEdit(e: PointerEvent): void {
    const p = this.worldPoint(e);
    if (!p) return;
    this.api.history().begin();
    this.gesture = { kind: "smooth" };
    this.smoothAt(p);
  }

  /**
   * Relaja los trazos que toca la punta.
   *
   * Se aplica sobre el estado ACTUAL y no sobre una copia del principio: insistir
   * con el puntero sobre la misma zona suaviza mas, que es como se dosifica un
   * suavizado a mano. La fuerza por fotograma es lo que lo hace controlable.
   */
  private smoothAt(p: V3): void {
    const s = this.api.settings();
    const doc = this.api.doc();
    let touched = 0;
    for (const stroke of doc.strokes3d) {
      if (!doc.layerVisible(stroke.layerId)) continue;
      if (!touches(stroke, p, s.radius)) continue;
      const next = relaxStroke(stroke, {
        strength: s.strength,
        iterations: 1,
        radius: false,
        ends: false,
      });
      if (next && doc.replaceStroke3D(next)) touched++;
    }
    if (touched > 0) {
      this.dirty = true;
      this.api.changed();
    }
  }

  /** Arrastra: estira la forma activa entre donde se apoyo y donde esta ahora. */
  private movePull(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.kind !== "pull") return;
    const p = this.worldPoint(e);
    if (!p) return;
    this.tail = this.sampleOf(e, p);
    g.b = this.toPlane2d(p, g.origin, g.u, g.w);
    const contorno = this.pullOutline(g);
    this.outline.cancel();
    this.previewOutline(contorno);
    this.dirty = true;
  }

  // -------------------------------------------------------------- arrastre

  /**
   * Empieza un arrastre: estira una forma geometrica entre donde se apoya el
   * lapiz y donde este el puntero al soltar.
   *
   * Es la mecanica del arrastre del lienzo -la de Alchemy-, y se hace igual: las
   * mismas familias de formas y la misma colocacion. Lo que cambia es el soporte.
   * En 2D la forma es un poligono de tinta; en el espacio es una mancha sobre el
   * plano de dibujo, porque es exactamente eso: una superficie con area.
   */
  private beginPull(e: PointerEvent): void {
    const p = this.worldPoint(e);
    if (!p) return;
    const origin = v3(this.camera.px, this.camera.py, this.camera.pz);
    const u = rightOf(this.camera, v3());
    const w = upOf(this.camera, v3());
    const familia = this.api.pullFamily();
    const shape = familia === "random" ? randomPullShape(this.rng) : pullShape(familia, this.rng);
    const a = this.toPlane2d(p, origin, u, w);
    this.gesture = { kind: "pull", origin, u, w, a, b: { ...a }, shape };
    this.tail = this.sampleOf(e, p);
    this.dirty = true;
  }

  /**
   * La forma estirada, en puntos de mundo.
   *
   * `placePullShape` trabaja en dos dimensiones: se le dan el punto de apoyo y el
   * actual ya proyectados sobre el plano, y devuelve el contorno ahi mismo. Subirlo
   * al espacio es deshacer esa proyeccion, que es exacta porque los dos puntos y
   * la forma viven en el plano.
   */
  private pullOutline(g: {
    origin: V3;
    u: V3;
    w: V3;
    a: { x: number; y: number };
    b: { x: number; y: number };
    shape: Polygon;
  }): V3[] {
    const poly = placePullShape(g.shape, g.a.x, g.a.y, g.b.x, g.b.y, 0.5, this.api.brush().size);
    const out: V3[] = [];
    for (const q of poly) out.push(this.fromPlane2d(q.x, q.y, g.origin, g.u, g.w));
    return out;
  }

  /**
   * Cierra el arrastre: la forma estirada pasa a ser una mancha.
   *
   * Se descarta si el recorrido fue tan corto que la forma no llega a tener area,
   * y se avisa: un tiron sin recorrido no dibuja nada, y conviene decirlo en vez
   * de no hacer nada en silencio.
   */
  private closePull(g: {
    origin: V3;
    u: V3;
    w: V3;
    a: { x: number; y: number };
    b: { x: number; y: number };
    shape: Polygon;
  }): void {
    const puntos = this.pullOutline(g);
    if (puntos.length < 3) {
      this.api.status("Arrastre: el recorrido es demasiado corto");
      return;
    }
    const outline = new Float32Array(puntos.length * 3);
    for (let i = 0; i < puntos.length; i++) {
      outline[i * 3] = puntos[i].x;
      outline[i * 3 + 1] = puntos[i].y;
      outline[i * 3 + 2] = puntos[i].z;
    }
    // La forma vive en el plano de dibujo, asi que su normal es la mirada de la
    // camara: no hace falta deducirla del contorno.
    const planeNormal = forwardOf(this.camera, v3());
    if (outlineArea(outline, puntos.length, planeNormal) < MIN_FILL_AREA) {
      this.api.status("Arrastre: el recorrido no llega a formar una figura");
      return;
    }

    const doc = this.api.doc();
    const fill = makeFill(uid(), outline, puntos.length, {
      color: this.api.color(),
      layerId: doc.scene3dTarget().id,
      planeNormal,
    });
    const history = this.api.history();
    history.begin();
    doc.addFill3D(fill);
    history.commit("Arrastre en el espacio");
    this.dirty = true;
    this.api.changed();
  }

  /** Un punto de mundo, en las dos coordenadas del plano de dibujo. */
  private toPlane2d(p: V3, origin: V3, u: V3, w: V3): { x: number; y: number } {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const dz = p.z - origin.z;
    return {
      x: dx * u.x + dy * u.y + dz * u.z,
      y: dx * w.x + dy * w.y + dz * w.z,
    };
  }

  /** Y al reves: dos coordenadas del plano, de vuelta al mundo. */
  private fromPlane2d(x: number, y: number, origin: V3, u: V3, w: V3): V3 {
    return v3(
      origin.x + u.x * x + w.x * y,
      origin.y + u.y * x + w.y * y,
      origin.z + u.z * x + w.z * y,
    );
  }

  /**
   * Enseña un contorno con la cinta provisional.
   *
   * Se rehace el constructor entero en cada movimiento en vez de acumular: en un
   * arrastre la forma cambia por completo de un fotograma al siguiente, asi que no
   * hay nada que conservar. En un relleno si se acumula, y de eso se encarga quien
   * lo llama.
   */
  private previewOutline(puntos: readonly V3[]): void {
    if (puntos.length < 2) return;
    const planeNormal = forwardOf(this.camera, v3());
    const muestra = (p: V3, t: number): Sample3D => ({
      x: p.x,
      y: p.y,
      z: p.z,
      pressure: 1,
      tilt: 0,
      azimuth: 0,
      t,
      predicted: false,
    });
    this.outline.begin(muestra(puntos[0], 0), {
      brush: "outline",
      color: this.api.color(),
      layerId: "outline",
      planeNormal,
    });
    const resto: Sample3D[] = [];
    for (let i = 1; i < puntos.length; i++) resto.push(muestra(puntos[i], i * 8));
    this.outline.push(resto, true);
  }

  // ------------------------------------------------------------- borrador

  /**
   * Borra lo que toca el borrador a lo largo del gesto.
   *
   * Se barre el camino entre la posicion anterior y la actual en pasos de medio
   * margen. Sin ese barrido, un gesto rapido deja huecos entre muestra y muestra
   * y el borrador perdona justo lo que se queria quitar.
   */
  private eraseAlong(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.kind !== "erase") return;
    const r = this.rect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const to = { x: ((e.clientX - r.left) / w) * 2 - 1, y: -(((e.clientY - r.top) / h) * 2 - 1) };
    const from = this.eraseFrom ?? to;

    const steps = Math.max(
      1,
      Math.ceil((Math.hypot(to.x - from.x, to.y - from.y) * h) / (ERASE_SLOP * 0.5)),
    );
    const doc = this.api.doc();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const id = this.pickStroke(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      if (!id) continue;
      doc.removeStroke3D(id);
      g.erasing = true;
    }
    this.eraseFrom = to;
    if (g.erasing) {
      this.dirty = true;
      this.updateHud();
      this.api.changed();
    }
  }

  /**
   * Id del trazo mas cercano a un punto de pantalla, o `null`.
   *
   * Se prueba el rayo contra las esferas envolventes, no contra la geometria: es
   * lo que hace que acertar cueste lo mismo con mil trazos que con uno, y el
   * margen de `ERASE_SLOP` compensa que la esfera sea mas generosa que la cinta.
   *
   * Las capas ocultas no entran: no se puede borrar lo que no se ve.
   */
  private pickStroke(ndcX: number, ndcY: number): string | null {
    const r = this.rect();
    const h = Math.max(1, r.height);
    // El margen tambien en NDC: asi el area de captura es la misma en pixeles
    // este donde este la camara.
    const slopNdc = (ERASE_SLOP / h) * 2;
    const vp = viewProjection(this.camera, Math.max(1, r.width) / h);
    const doc = this.api.doc();

    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const batch of this.scene.all) {
      if (!doc.layerVisible(batch.layerId)) continue;
      for (const range of batch.ranges) {
        if (!range.active) continue;
        const p = projectPoint(vp, range.cx, range.cy, range.cz);
        if (p.w <= 0) continue;
        // Radio de la esfera en NDC: a profundidad w, el semialto visible es
        // w * tan(fovY/2), y NDC va de -1 a 1.
        const rNdc = range.radius / p.w / Math.tan(this.camera.fovY * 0.5);
        const d = Math.hypot(p.x - ndcX, p.y - ndcY);
        if (d <= rNdc + slopNdc && d < bestDist) {
          bestDist = d;
          bestId = range.strokeId;
        }
      }
    }
    return bestId;
  }

  /** Borra el trazo mas cercano bajo el cursor. Devuelve si borro algo. */
  private eraseAt(e: PointerEvent): boolean {
    const r = this.rect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const id = this.pickStroke(((e.clientX - r.left) / w) * 2 - 1, -(((e.clientY - r.top) / h) * 2 - 1));
    if (!id) return false;
    this.deleteStroke(id, "Borrar en el espacio");
    return true;
  }

  /** Quita un trazo del documento, con su paso por el historial. */
  private deleteStroke(id: string, label: string): void {
    const history = this.api.history();
    history.begin();
    this.api.doc().removeStroke3D(id);
    history.commit(label);
    this.dirty = true;
    this.updateHud();
    this.api.changed();
  }

  /** Punto de mundo del plano de dibujo bajo el puntero. */
  private worldPoint(e: PointerEvent): V3 | null {
    const r = this.rect();
    if (r.width <= 0 || r.height <= 0) return null;
    const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / r.height) * 2 - 1);
    return rayToDepthPlane(
      this.camera,
      ndcX,
      ndcY,
      r.width / r.height,
      this.depth,
      { x: 0, y: 0, z: 0 },
    );
  }

  private sampleOf(e: PointerEvent, p: V3): Sample3D {
    const tiltX = ((e.tiltX ?? 0) * Math.PI) / 180;
    const tiltY = ((e.tiltY ?? 0) * Math.PI) / 180;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      // El raton reporta 0.5 constante; -1 marca "no hay presion real" y el
      // constructor la sustituye por la velocidad, igual que en el lienzo 2D.
      pressure: e.pointerType === "mouse" ? -1 : e.pressure,
      tilt: Math.hypot(tiltX, tiltY),
      azimuth: Math.atan2(tiltY, tiltX),
      t: e.timeStamp,
      predicted: false,
    };
  }

  private rect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  private updateHud(): void {
    const s = this.stats();
    const depth = this.depth === 0 ? "auto" : `${this.depth}`;
    this.hud.textContent =
      `3D · ${this.toolLabel()} · ${s.strokes} trazos · ${s.drawCalls} lotes · ` +
      `${s.instances} instancias · plano ${depth}` +
      (this.depth === 0 ? " (centro de la vista)" : "") +
      (this.controls.navigating ? " · moviendo la vista" : "");
  }

  /** Que hace el puntero ahora mismo, en una palabra. */
  private toolLabel(): string {
    if (this.api.settings().tool === "smooth") return "suavizar";
    const mode = this.api.brush().mode;
    if (mode === "erase") return "borrador";
    if (mode === "pull") return "arrastre";
    if (mode === "fill") return "relleno";
    return "trazo";
  }}

/** Radio del trazo en su punto medio, para pruebas y depuracion. */
export const midRadius = (stroke: Stroke3D): number =>
  radiusAt(stroke.data, Math.floor(stroke.count / 2));
