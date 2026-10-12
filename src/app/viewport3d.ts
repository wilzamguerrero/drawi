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
import {
  radiusAt,
  boundsOf,
  boundsCenter,
  boundsRadius,
  POINT_FLOATS,
  RADIUS_OFFSET,
  type Sample3D,
  type Stroke3D,
} from "../scene3d/types";
import { computeFrames } from "../scene3d/frames";
import type { SceneDocument } from "../scene/document";
import type { History } from "../app/history";
import {
  CameraController3D,
  clampZoomFactor,
  snapDepth,
} from "../scene3d/controls3d";
import {
  DEFAULT_CAMERA_3D,
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
  outlineNormal,
  type Fill3D,
} from "../scene3d/fill";
import { placePullShape, pullShape, randomPullShape, type PullFamily } from "../tools/pull-shapes";
import {
  axisDirection,
  blendTangent,
  constrainToAxis,
  resolveStart,
  FLOOR_Y,
  type SnapAxis,
} from "../scene3d/snap";
import { drawPlane, planeNormalFor, planePoint, screenRay } from "../scene3d/drawplane";
import polygonClipping from "polygon-clipping";
import { alongRay, placedPlanePoint, strokeDepthAt } from "../scene3d/placement";
import {
  beginGizmo,
  dragGizmo,
  gizmoWorldSize,
  pickAxis,
  rayPlane,
  GIZMO_MODE_ORDER,
  GIZMO_MODE_LABELS,
  type GizmoGrab,
  type GizmoMode,
  type Ray,
} from "../scene3d/gizmo";
import {
  makeObject,
  DEFAULT_PRIMITIVE_SIZE,
  type Object3D,
  type PrimitiveKind,
} from "../scene3d/objects";

/** Radio de la esfera que encierra una primitiva a su escala, para el picking. */
const objectRadius = (o: Object3D): number => {
  const s = o.transform.scale;
  // El toro es el mas ancho a igual escala; el resto cabe en media diagonal del
  // cubo base. Se toma el eje mayor para no quedarse corto.
  const k = o.kind === "torus" ? 0.56 : 0.87;
  return DEFAULT_PRIMITIVE_SIZE * k * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
};

/** Distancia a la que un rayo entra en una esfera, o `null` si no la toca. */
const raySphere = (ray: Ray, center: V3, radius: number): number | null => {
  const ox = ray.origin.x - center.x;
  const oy = ray.origin.y - center.y;
  const oz = ray.origin.z - center.z;
  const b = ox * ray.dir.x + oy * ray.dir.y + oz * ray.dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
};
import { Rng, uid } from "../core/rng";
import { v3, type V3 } from "../scene3d/vec3";
import { icon } from "../ui/icons";

/** Tecla estandar de cada modo del gizmo, para el tooltip de la barra. */
const GIZMO_MODE_KEYS: Record<GizmoMode, string> = { move: "W", rotate: "E", scale: "R" };
/** Icono de cada modo del gizmo en la barra flotante. */
const GIZMO_MODE_ICONS: Record<GizmoMode, string> = { move: "move", rotate: "rotate", scale: "scale" };

/** Distancia de un punto `(px,py)` al segmento `(ax,ay)-(bx,by)`, en el plano. */
const distPointToSegment2D = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // Segmento degenerado (un punto): distancia al punto.
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
};

/** Distancia entre dos puntos. Se usa para medir el avance del gesto. */
const distancia = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/**
 * Huella de la goma entre dos puntos, como poligono para el recorte de manchas.
 *
 * Es un "estadio" (dos circulos y el rectangulo entre sus centros), construido por
 * union de esas tres piezas. Devolverlo ya unido evita que el recorte tenga que
 * lidiar con solapes. Coordenadas en pantalla escaladas por `scale`.
 */
const eraserFootprint = (
  from: { x: number; y: number },
  to: { x: number; y: number },
  radNdc: number,
  scale: number,
): number[][] => {
  const ax = from.x * scale;
  const ay = from.y * scale;
  const bx = to.x * scale;
  const by = to.y * scale;
  const rad = radNdc * scale;
  const K = 20;
  const circle = (cx: number, cy: number): number[][] => {
    const ring: number[][] = [];
    for (let i = 0; i < K; i++) {
      const a = (i / K) * Math.PI * 2;
      ring.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
    ring.push(ring[0]!);
    return ring;
  };
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return circle(ax, ay);
  const px = (-dy / len) * rad;
  const py = (dx / len) * rad;
  const rect: number[][] = [
    [ax + px, ay + py],
    [bx + px, by + py],
    [bx - px, by - py],
    [ax - px, ay - py],
    [ax + px, ay + py],
  ];
  const merged = polygonClipping.union(
    [[circle(ax, ay)]] as unknown as Parameters<typeof polygonClipping.union>[0],
    [[rect]] as unknown as Parameters<typeof polygonClipping.union>[0],
    [[circle(bx, by)]] as unknown as Parameters<typeof polygonClipping.union>[0],
  ) as unknown as number[][][][];
  // La union puede devolver varias piezas; para la huella de la goma basta la
  // primera -las piezas sueltas serian ruido numerico-.
  return merged[0]?.[0] ?? rect;
};

/** Proyecta un anillo de mundo a pantalla escalada, o `null` si algo cae detras. */
const projectRingScaled = (
  vp: Float32Array,
  ring: Float32Array,
  count: number,
  scale: number,
): number[][] | null => {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const p = projectPoint(vp, ring[o]!, ring[o + 1]!, ring[o + 2]!);
    if (p.w <= 0) return null;
    out.push([p.x * scale, p.y * scale]);
  }
  if (count > 0) out.push([out[0]![0]!, out[0]![1]!]); // cerrado para el recorte
  return out;
};

/** Area con signo de un anillo (en el orden dado). */
const ringArea = (ring: number[][]): number => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0]! * ring[i]![1]! - ring[i]![0]! * ring[j]![1]!;
  }
  return a * 0.5;
};

/** Area neta de un poligono con agujeros: exterior menos los huecos (en magnitud). */
const ringsArea = (rings: number[][][]): number => {
  if (rings.length === 0) return 0;
  let a = Math.abs(ringArea(rings[0]!));
  for (let i = 1; i < rings.length; i++) a -= Math.abs(ringArea(rings[i]!));
  return a;
};

/** Area neta de un multipoligono (lista de poligonos con agujeros). */
const ringsAreaMulti = (polys: number[][][][]): number => {
  let a = 0;
  for (const poly of polys) a += ringsArea(poly);
  return a;
};

/** ¿La caja de un anillo roza el segmento engordado al radio? Descarte barato. */
const bboxNearSegment = (
  ring: number[][],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rad: number,
): boolean => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p[0]! < minX) minX = p[0]!;
    if (p[0]! > maxX) maxX = p[0]!;
    if (p[1]! < minY) minY = p[1]!;
    if (p[1]! > maxY) maxY = p[1]!;
  }
  const segMinX = Math.min(ax, bx) - rad;
  const segMaxX = Math.max(ax, bx) + rad;
  const segMinY = Math.min(ay, by) - rad;
  const segMaxY = Math.max(ay, by) + rad;
  return !(maxX < segMinX || minX > segMaxX || maxY < segMinY || minY > segMaxY);
};

/** Caja de un anillo en pantalla escalada. */
const bboxOfRing = (ring: number[][]): { minX: number; minY: number; maxX: number; maxY: number } => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p[0]! < minX) minX = p[0]!;
    if (p[0]! > maxX) maxX = p[0]!;
    if (p[1]! < minY) minY = p[1]!;
    if (p[1]! > maxY) maxY = p[1]!;
  }
  return { minX, minY, maxX, maxY };
};

const bboxesOverlap = (
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean => !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);

const pointInPoly2D = (poly: number[][], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]!, yi = poly[i][1]!, xj = poly[j][0]!, yj = poly[j][1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

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
  | {
      kind: "stroke";
      planeNormal: V3;
      /**
       * Origen del trazado: el punto ya resuelto por el ajuste.
       *
       * El eje y la continuidad de tangente se aplican a los puntos SIGUIENTES
       * tomando este punto como origen; moverlo habria perdido el enganche.
       */
      anchor: V3;
      /** Tangente del trazo al que se ha encadenado, o `null`. */
      tangent: V3 | null;
      /** Lo recorrido desde el ancla, para soltar la tangente poco a poco. */
      travelled: number;
      /**
       * El gesto empezo con Mayusculas, asi que puede ser un clic seco para
       * marcar el anclaje.
       *
       * Se decide al SOLTAR, no al pulsar: Mayusculas sostenida es el bloqueo
       * temporal del eje mientras se arrastra, y un clic sin arrastre es la marca
       * del anclaje. Decidirlo al pulsar obligaria a elegir entre las dos.
       */
      maybeAnchor: boolean;
    }  | { kind: "fill"; planeNormal: V3; outline: number[]; minStep: number; erasing: boolean }
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
       erasing: boolean;
     }
  | { kind: "erase"; erasing: boolean }
  | { kind: "smooth" }
  | {
      kind: "gizmo";
      /** El objeto que se esta transformando. */
      objectId: string;
      /** Lo que se guardo al agarrar el eje, para medir el arrastre contra ello. */
      grab: GizmoGrab;
    }
  | null;

/** Rejilla de profundidad, en unidades de mundo. */
const DEPTH_STEP = 25;

/** Radio de captura del borrador, en pixeles de pantalla. */
const ERASE_SLOP = 10;

/**
 * Movimiento por debajo del cual un gesto con Mayusculas cuenta como clic seco.
 *
 * En unidades de mundo, y pequeño: el temblor de un clic normal no llega a un
 * pixel, asi que ningun trazo de verdad cae por debajo. Es lo que separa "marcar
 * el anclaje" de "trazar con el eje bloqueado".
 */
const ANCHOR_CLICK_SLOP = 2;


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
  /** Sube con cada cambio de esos ajustes: es el aviso de que hay que repintar. */
  settingsRevision(): number;
  /** Marca o quita el punto de anclaje del ajuste (`null` lo quita). */
  setAnchor(p: V3 | null): void;
  /** El objeto seleccionado en el panel, o `null`. */
  selectedObject(): string | null;
  /** Selecciona (o deselecciona con `null`) un objeto del espacio. */
  selectObject(id: string | null): void;
  /** Cambia el modo del gizmo (W/E/R desde el teclado del visor). */
  setGizmoMode(mode: GizmoMode): void;
  /** Borra el objeto seleccionado (Supr desde el visor). */
  deleteObject(): void;
  /** Avisa al editor de algo que el usuario debe leer. */
  status(message: string): void;
  /** Avisa de que el estado cambio (para refrescar la interfaz). */
  changed(): void;
  /** La barra de estado tiene que releer el estado, sin marcar el documento como
   *  sucio: la profundidad del plano o el modo del puntero no son cambios del
   *  dibujo. */
  refresh(): void;
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
  /** Revision de los ajustes del visor que ya se pintaron. */
  private syncedSettings = -1;
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
  /** Buffers reutilizados para proyectar el contorno de una mancha al hacer picking. */
  private readonly pickScratchX = new Float32Array(MAX_OUTLINE_POINTS);
  private readonly pickScratchY = new Float32Array(MAX_OUTLINE_POINTS);
  /**
   * Ultimo punto CRUDO del trazo en curso.
   *
   * Es lo que mide el avance del gesto: el ajuste puede mover los puntos, y medir
   * el avance sobre los ya movidos falsearia cuanto lleva recorrido el trazo -y
   * con ello cuanto pesa todavia la tangente del anterior-.
   */
  private lastRaw: V3 | null = null;
  /** Eje del gizmo bajo el cursor, resaltado. Solo con la herramienta de objetos. */
  private hoverAxis: import("../scene3d/gizmo").GizmoAxis | null = null;
  private depth = 0;
  private space = false;
  private dirty = true;
  private disposers: Array<() => void> = [];
  /** Barra flotante de modos del gizmo (estilo ZBrush), sobre el objeto. */
  private readonly gizmoBar: HTMLElement;

  constructor(host: HTMLElement, api: Viewport3DHost) {
    this.api = api;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "layer layer-3d";
    host.appendChild(this.canvas);

    this.gizmoBar = this.buildGizmoBar();
    host.appendChild(this.gizmoBar);

    this.backend = new Scene3DBackend(this.canvas);

    this.attach(host);
    this.setActive(false);
  }

  /**
   * Barra flotante del gizmo, al estilo de ZBrush: los modos del manipulador
   * (mover, rotar, escalar) como botones sobre el objeto seleccionado, para
   * cambiarlos sin ir al panel. Se coloca cada fotograma sobre la proyeccion del
   * objeto; vive en el anfitrion -no en el lienzo WebGL- porque es interfaz, no
   * dibujo, y asi recibe clics y se lee nitida.
   */
  private buildGizmoBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "gizmo-bar";
    bar.style.display = "none";
    for (const mode of GIZMO_MODE_ORDER) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gizmo-bar-btn";
      b.dataset.mode = mode;
      b.title = `${GIZMO_MODE_LABELS[mode]} (${GIZMO_MODE_KEYS[mode]})`;
      b.innerHTML = icon(GIZMO_MODE_ICONS[mode]);
      // pointerdown, no click: el lienzo captura el puntero en captura, y un
      // click llegaria tarde o se lo comeria el gesto del visor.
      b.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.api.setGizmoMode(mode);
        this.refreshState();
      });
      bar.appendChild(b);
    }
    return bar;
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
   * El espacio toma el puntero, o lo suelta.
   *
   * Ya **no** oculta el lienzo ni le pone fondo: el espacio se ve siempre, y su
   * lienzo es transparente para que debajo se vean la tinta, la acuarela y la
   * materia. Esa es la diferencia entre un modo del que se sale y una capa con la
   * que se convive: lo que se apaga al soltarlo es la atencion del puntero, no la
   * imagen. El papel lo pone el fondo del anfitrion, que esta por debajo de todo.
   */
  setActive(on: boolean): void {
    this.live = on && this.backend.available;
    this.canvas.classList.toggle("is-active", this.live);
    if (this.live) {
      // El punto de vista viaja con el documento: al volver al espacio se vuelve
      // a donde se estaba mirando, no a un encuadre por defecto.
      Object.assign(this.camera, this.api.doc().camera3d);
      this.controls.viewportHeight = this.canvas.clientHeight || 800;
      this.resetDepth();
      this.dirty = true;
      this.refreshState();
    } else {
      this.saveCamera();
      this.cancelGesture();
      // Al soltar el espacio, la barra del gizmo no se queda flotando sobre el 2D.
      this.gizmoBar.style.display = "none";
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
    // Los ajustes del visor -la rejilla, el ajuste del trazo, la marca del
    // anclaje- cambian la imagen sin tocar el documento. Se avisa por revision y
    // no comparando objetos, que seria recorrerlos en cada fotograma.
    const ajustes = this.api.settingsRevision();
    if (ajustes !== this.syncedSettings) {
      this.syncedSettings = ajustes;
      this.dirty = true;
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
    this.refreshState();
  }

  /** Devuelve el estado de dibujado al plano por defecto, delante del punto de mira. */
  resetDepth(): void {
    this.depth = 0;
  }

  adjustDepth(steps: number): void {
    this.depth = snapDepth(this.depth + steps * DEPTH_STEP, DEPTH_STEP);
    this.refreshState();
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
    this.backend.syncObjects(doc.objects3d, paintOf);
    // Sombras de contacto sobre el suelo: un disco difuso bajo cada objeto segun
    // Sombras reales de los objetos sobre el suelo: el mapa de sombra de three las
    // proyecta con la forma del objeto y las recibe un plano receptor. El usuario
    // gradua encendido, opacidad y suavidad; la forma y donde caen las ponen el
    // objeto y la luz principal. Solo con la rejilla puesta, que hace de suelo.
    const settings = this.api.settings();
    const grid = settings.grid;
    const shadow = settings.shadow;
    this.backend.syncShadows({
      enabled: grid.enabled && shadow.enabled,
      opacity: shadow.opacity,
      softness: shadow.softness,
      color: shadow.color,
      extent: shadow.extent,
      resolution: shadow.resolution,
    });
    // Oclusion de trazos: que un objeto solido tape el trazo que tiene detras, o
    // que los trazos vayan siempre por encima. Lo decide el usuario.
    this.backend.setOccludeStrokes(settings.occludeStrokes);
    // Que los trazos proyecten su sombra sobre el suelo, los objetos y otros
    // trazos. Solo tiene efecto con la sombra encendida.
    this.backend.setStrokeCastShadow(shadow.enabled && settings.strokeShadow);
    // Que los trazos y manchas RECIBAN sombra de objetos y otros trazos.
    this.backend.setStrokeReceiveShadow(
      shadow.enabled && settings.strokeReceiveShadow,
      shadow.opacity,
    );
    // El gizmo solo aparece con la herramienta de objetos y uno seleccionado. El
    // eje resaltado es el que haya bajo el cursor cuando no se esta arrastrando;
    // en pleno arrastre, el que se agarro.
    const gd = this.gizmoDraw();
    this.backend.drawGizmo(gd);
    // La barra flotante de modos acompaña al gizmo: encima del objeto, en pantalla.
    this.placeGizmoBar(gd);
    // La marca del anclaje solo se enseña cuando el ajuste esta puesto en el: si
    // no, seria un adorno mas en medio del dibujo.
    const s = this.api.settings().snap;
    this.backend.drawAnchor(s.source === "anchor" ? s.anchor : null, Math.max(4, s.radius * 0.35));
    // La rejilla se centra en el punto de mira: asi siempre hay suelo bajo lo que
    // se esta dibujando, se mire donde se mire. Su paso es el MISMO que el del
    // enganche, para que lo que se ve sea exactamente a lo que se pega el trazo.
    this.backend.syncGrid(
      grid.enabled
        ? {
            centerX: this.camera.px,
            centerZ: this.camera.pz,
            floorY: FLOOR_Y,
            step: s.gridStep,
            opacity: grid.opacity,
          }
        : null,
    );
    // La vista previa se rehace una vez por fotograma y no una por evento de
    // puntero: el navegador puede entregar varios eventos coalescidos entre dos
    // fotogramas, y recomponer la cinta para cada uno seria trabajo tirado.
    let live: Stroke3D | null = null;
    if (tracing) live = this.builder.preview(this.tail);
    else if (contouring) live = this.outline.preview(null);
    this.backend.setLive(live);
    this.backend.render(this.camera, doc.lights3d);
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
    if (doc.strokes3d.length === 0 && doc.fills3d.length === 0 && doc.objects3d.length === 0) {
      return false;
    }
    for (const l of doc.scene3dLayers) if (doc.layerVisible(l.id)) return true;
    return false;
  }

  /**
   * Lo que hay que pasarle al backend para dibujar el gizmo, o `null`.
   *
   * Solo con la herramienta de objetos y uno seleccionado que exista y se vea. El
   * eje resaltado es, en reposo, el que esta bajo el cursor; en pleno arrastre, el
   * que se agarro -no tiene sentido que el resalte salte a otro mientras se mueve-.
   */
  private gizmoDraw(): import("../render3d/backend").GizmoDraw | null {
    if (this.api.settings().tool !== "object") return null;
    const id = this.api.selectedObject();
    if (!id) return null;
    const doc = this.api.doc();
    const obj = doc.objectById(id);
    if (!obj || obj.hidden || !doc.layerVisible(obj.layerId)) return null;

    const g = this.gesture;
    const hover = g?.kind === "gizmo" ? g.grab.axis : this.hoverAxis;
    return {
      center: { ...obj.transform.position },
      size: this.gizmoSize(),
      mode: this.api.settings().gizmo,
      hover,
    };
  }

  /**
   * Coloca la barra de modos sobre el objeto, o la oculta.
   *
   * Se proyecta el centro del objeto a pantalla y se pone la barra un poco por
   * encima. `gd` ya resolvio si hay gizmo que enseñar -misma condicion que el
   * dibujo-, asi que basta con reusarlo. Si el punto queda detras de la camara
   * (`w <= 0`), no se enseña. El modo activo se marca con una clase.
   */
  private placeGizmoBar(gd: import("../render3d/backend").GizmoDraw | null): void {
    if (!gd || !this.live) {
      if (this.gizmoBar.style.display !== "none") this.gizmoBar.style.display = "none";
      return;
    }
    const r = this.rect();
    const aspect = Math.max(1, r.width) / Math.max(1, r.height);
    const vp = viewProjection(this.camera, aspect);
    const p = projectPoint(vp, gd.center.x, gd.center.y, gd.center.z);
    if (p.w <= 0) {
      this.gizmoBar.style.display = "none";
      return;
    }
    // NDC (-1..1) a pixeles del lienzo. La barra sube un poco por encima del gizmo
    // -su tamano en pantalla ronda el 14% del alto-, para no taparlo.
    const sx = (p.x * 0.5 + 0.5) * r.width;
    const sy = (1 - (p.y * 0.5 + 0.5)) * r.height;
    const lift = r.height * 0.12 + 46;
    this.gizmoBar.style.display = "flex";
    this.gizmoBar.style.left = `${Math.round(sx)}px`;
    this.gizmoBar.style.top = `${Math.round(sy - lift)}px`;
    const active = this.api.settings().gizmo;
    for (const b of Array.from(this.gizmoBar.children) as HTMLElement[]) {
      b.classList.toggle("is-active", b.dataset.mode === active);
    }
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
    this.refreshState();
    this.api.changed();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.backend.dispose();
    this.canvas.remove();
    this.gizmoBar.remove();
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
        this.refreshState();
      } else if (e.code === "BracketLeft") {
        this.adjustDepth(1);
      } else if (e.code === "BracketRight") {
        this.adjustDepth(-1);
      } else if (e.code === "KeyF") {
        this.frameAll();
      } else if (this.api.settings().tool === "object" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // W / E / R: mover, rotar, escalar. La fila de teclas estandar en 3D -la
        // misma que Blender, Unity o Maya-. Solo con la herramienta de objetos,
        // para no robarle la W a nada del lienzo.
        if (e.code === "KeyW") {
          this.api.setGizmoMode("move");
          e.stopPropagation();
        } else if (e.code === "KeyE") {
          this.api.setGizmoMode("rotate");
          e.stopPropagation();
        } else if (e.code === "KeyR") {
          this.api.setGizmoMode("scale");
          e.stopPropagation();
        } else if ((e.code === "Delete" || e.code === "Backspace") && this.api.selectedObject()) {
          this.api.deleteObject();
          e.stopPropagation();
        }
      }
    };
    const keyUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") {
        this.space = false;
        if (this.live) {
          e.stopPropagation();
          this.refreshState();
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
      this.refreshState();
      return;
    }

    // El borrador del lapiz llega como boton 5; Alt hace lo mismo con cualquier
    // puntero. Se mira ANTES de descartar los botones que no son el izquierdo, y
    // borra un trazo entero de un golpe. Con la herramienta de objetos no: alli
    // Alt no deberia borrar trazos a la espalda de quien esta moviendo un cubo.
    if (
      this.api.settings().tool !== "object" &&
      (e.button === 5 || (e.button === 0 && e.altKey))
    ) {
      e.preventDefault();
      this.eraseAt(e);
      return;
    }

    if (e.button !== 0) return;
    e.preventDefault();
    this.beginGesture(e);
  }

  /**
   * Marca (o quita) el punto de anclaje del ajuste.
   *
   * Es el punto del que arrancan los trazos cuando la continuacion esta puesta en
   * "Anclaje": dibujar en abanico desde un mismo origen. Volver a marcar en el
   * mismo sitio lo quita, para no tener que ir al panel a deshacerlo.
   */
  private markAnchor(p: V3): void {
    const actual = this.api.settings().snap.anchor;
    const mismo = actual !== null && distancia(actual, p) < 1e-3;
    this.api.setAnchor(mismo ? null : p);
    this.api.status(
      mismo
        ? "Anclaje quitado"
        : `Anclaje en (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`,
    );
    this.dirty = true;
  }

  private onMove(e: PointerEvent): void {
    if (this.controls.navigating) {
      const r = this.rect();
      this.controls.move(e.clientX - r.left, e.clientY - r.top, this.mods(e));
      this.dirty = true;
      return;
    }
    if (!this.gesture) {
      // Sin gesto en marcha, con la herramienta de objetos se sigue el raton para
      // resaltar el eje del gizmo que hay debajo: la pista visual de que se puede
      // agarrar. Barato -un picking de tres ejes- y solo cuando toca.
      this.updateHoverAxis(e);
      return;
    }
    e.preventDefault();
    this.moveGesture(e);
  }

  /** Resalta el eje del gizmo bajo el cursor, para la herramienta de objetos. */
  private updateHoverAxis(e: PointerEvent): void {
    if (this.api.settings().tool !== "object") {
      if (this.hoverAxis !== null) {
        this.hoverAxis = null;
        this.dirty = true;
      }
      return;
    }
    const id = this.api.selectedObject();
    const obj = id ? this.api.doc().objectById(id) : undefined;
    const axis = obj
      ? pickAxis(this.api.settings().gizmo, this.rayAt(e), obj.transform.position, this.gizmoSize())
      : null;
    if (axis !== this.hoverAxis) {
      this.hoverAxis = axis;
      this.dirty = true;
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.controls.navigating) {
      this.controls.end();
      this.refreshState();
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
    this.refreshState();
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
    const tool = this.api.settings().tool;
    if (tool === "object") {
      this.beginObject(e);
      return;
    }
    if (tool === "smooth") {
      this.beginEdit(e);
      return;
    }

    const brush = this.api.brush();
    const invert =
      brush.invertErase && brush.mode !== "erase" && !brush.asMatter && !brush.asAqua && !brush.asRaster;
    if (brush.mode === "erase" || (invert && brush.mode === "stroke")) {
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
    if (g.kind === "gizmo") {
      this.moveObject(e);
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
      // Un clic seco con Mayusculas no es un trazo: es marcar el anclaje. Se
      // descarta lo que hubiera en el constructor y se marca el punto. El umbral
      // es corto a proposito -el temblor de un clic normal no llega ni a un
      // pixel-, asi que no se come ningun trazo por error.
      if (g.maybeAnchor && g.travelled < ANCHOR_CLICK_SLOP) {
        this.builder.cancel();
        this.lastRaw = null;
        this.tail = null;
        this.markAnchor(g.anchor);
        this.refreshState();
        return;
      }
      const stroke = this.builder.finalize();
      this.builder.cancel();
      this.tail = null;
      this.lastRaw = null;
      if (!stroke) return;
      history.begin();
      // La mejora al soltar se aplica ANTES de guardar: lo que entra en el
      // documento es ya lo definitivo, asi que deshacerlo es un solo paso.
      this.api.doc().addStroke3D(this.refine(stroke));
      history.commit("Trazo en el espacio");
      this.dirty = true;
      this.refreshState();
      this.api.changed();
      return;
    }

    if (g.kind === "fill") {
      this.outline.cancel();
      this.tail = null;
      this.closeFill(g);
      this.refreshState();
      return;
    }

    if (g.kind === "pull") {
      this.outline.cancel();
      this.tail = null;
      this.closePull(g);
      this.refreshState();
      return;
    }

    if (g.kind === "gizmo") {
      this.endObject(g);
      this.refreshState();
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
    this.refreshState();
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
      this.refreshState();
    }
  }

  // ---------------------------------------------------------------- trazo

  private beginStroke(e: PointerEvent): void {
    const raw = this.worldPoint(e);
    if (!raw) return;

    const brush = this.api.brush();
    this.builder.settings = brush;
    this.builder.setZoom(1);
    const planeNormal = this.planeNormal();

    // De donde arranca el trazo y con que direccion sale lo decide el ajuste:
    // puede engancharse al extremo de otro trazo, a la rejilla o a un anclaje, y
    // traer consigo la tangente para que la union no haga pico.
    const snap = this.api.settings().snap;
    const arranque = resolveStart(raw, snap, this.api.doc().strokes3d, this.camera);
    const anchor = arranque.point;
    this.lastRaw = { ...raw };
    this.gesture = {
      kind: "stroke",
      planeNormal,
      anchor,
      tangent: arranque.tangent,
      travelled: 0,
      maybeAnchor: e.shiftKey,
    };

    const doc = this.api.doc();
    const sample = this.sampleOf(e, anchor);
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
    const g = this.gesture;
    if (!g || g.kind !== "stroke") return;
    const samples = this.coalescedSamples(e);
    if (samples.length === 0) return;

    // Cada muestra se ajusta con el avance que llevaba el trazo AL LLEGAR a ella,
    // no con el mismo para todas: la tangente pesa mucho al principio y nada al
    // final, y aplicarles el mismo avance apelotonaria un gesto rapido en un solo
    // punto. El avance se mide sobre los puntos CRUDOS, que son los del gesto; si
    // se midiera sobre los ya ajustados, el eje lo falsearia.
    // Con Mayusculas sostenida, el eje del panel se sustituye por la horizontal de
    // la vista mientras dure el gesto. Es el bloqueo temporal de toda la vida, y
    // no pisa el ajuste permanente: al soltar, vuelve el del panel.
    const snap = this.api.settings().snap;
    const eje: SnapAxis = e.shiftKey ? "view-x" : snap.axis;
    const dir = axisDirection(eje, this.camera, v3());
    const ajustadas: Sample3D[] = [];
    let avance = g.travelled;
    for (const s of samples) {
      if (this.lastRaw) avance += distancia(this.lastRaw, s);
      this.lastRaw = { x: s.x, y: s.y, z: s.z };
      const punto = this.snapPoint(g.anchor, s, avance, dir);
      ajustadas.push({ ...s, x: punto.x, y: punto.y, z: punto.z });
    }
    this.gesture = { ...g, travelled: avance };

    this.tail = ajustadas[ajustadas.length - 1];
    this.builder.push(ajustadas);
    this.dirty = true;
  }

  /**
   * Lleva un punto del puntero a donde manda el ajuste.
   *
   * El orden de los dos pasos importa: primero se endereza la direccion hacia la
   * tangente del trazo enganchado y despues se lleva al eje. Al reves, el ultimo
   * paso dejaria el punto fuera del eje, que es lo que el usuario ha pedido de
   * forma explicita.
   */
  private snapPoint(anchor: V3, p: V3, travelled: number, dir: V3 | null): V3 {
    const g = this.gesture;
    const snap = this.api.settings().snap;
    const tang = g?.kind === "stroke" ? g.tangent : null;
    const girado = blendTangent(
      anchor,
      p,
      tang,
      travelled,
      snap.tangentBlend,
      snap.tangent ? 1 : 0,
    );
    return constrainToAxis(anchor, girado, dir);
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
    const planeNormal = this.planeNormal();
    const brush = this.api.brush();
    const invert =
      brush.invertErase && brush.mode !== "erase" && !brush.asMatter && !brush.asAqua && !brush.asRaster;
    const erasing = invert && brush.mode === "fill";
    this.gesture = {
      kind: "fill",
      planeNormal,
      outline: [p.x, p.y, p.z],
      // Mismo criterio de muestreo que el constructor: medio radio. Un contorno
      // con puntos mas juntos que eso solo engorda la triangulacion.
      minStep: Math.max(0.55, brush.size * 0.25),
      erasing,
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
  private closeFill(g: { planeNormal: V3; outline: number[]; erasing: boolean }): void {
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

    // "Usar como borrador" con Relleno: el contorno recorta en vez de crear.
    if (g.erasing) {
      const poly: V3[] = [];
      for (let i = 0; i < count; i++) poly.push(v3(g.outline[i * 3]!, g.outline[i * 3 + 1]!, g.outline[i * 3 + 2]!));
      const history = this.api.history();
      history.begin();
      const changed = this.eraseWithWorldPolygon(poly);
      if (changed) {
        history.commit("Borrar con relleno");
        this.dirty = true;
        this.refreshState();
        this.api.changed();
      } else {
        history.abort();
        this.api.status("El borrado no toco nada");
      }
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
    const brush = this.api.brush();
    const invert =
      brush.invertErase && brush.mode !== "erase" && !brush.asMatter && !brush.asAqua && !brush.asRaster;
    const erasing = invert && brush.mode === "pull";
    this.gesture = { kind: "pull", origin, u, w, a, b: { ...a }, shape, erasing };
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
    erasing: boolean;
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
    const planeNormal = this.planeNormal();
    if (outlineArea(outline, puntos.length, planeNormal) < MIN_FILL_AREA) {
      this.api.status("Arrastre: el recorrido no llega a formar una figura");
      return;
    }

    if (g.erasing) {
      const history = this.api.history();
      history.begin();
      const changed = this.eraseWithWorldPolygon(puntos);
      if (changed) {
        history.commit("Borrar con arrastre");
        this.dirty = true;
        this.refreshState();
        this.api.changed();
      } else {
        history.abort();
        this.api.status("El borrado no toco nada");
      }
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
    const planeNormal = this.planeNormal();
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

  // -------------------------------------------------------------- objetos

  /**
   * Rayo del mundo que sale por un punto de pantalla. Lo usa el gizmo y el
   * picking de objetos: proyectar el cursor en el espacio.
   */
  private rayAt(e: PointerEvent): Ray {
    const r = this.rect();
    const ndcX = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
    const { origin, dir } = screenRay(this.camera, ndcX, ndcY, r.width / Math.max(1, r.height));
    return { origin: { ...origin }, dir: { ...dir } };
  }

  /** Tamano del gizmo en el mundo, para el objeto seleccionado. */
  private gizmoSize(): number {
    return gizmoWorldSize(this.camera.distance);
  }

  /**
   * Empieza un gesto con la herramienta de objetos.
   *
   * Si hay un objeto seleccionado y el cursor agarra un eje de su gizmo, empieza a
   * transformar. Si no, hace picking: selecciona el objeto bajo el cursor, o
   * deselecciona si no hay ninguno. Mover la camara sigue siendo con el boton
   * central o el derecho, asi que aqui solo llega el izquierdo.
   */
  private beginObject(e: PointerEvent): void {
    const ray = this.rayAt(e);
    const doc = this.api.doc();
    const sel = this.api.selectedObject();
    const mode = this.api.settings().gizmo;

    if (sel) {
      const obj = doc.objectById(sel);
      if (obj) {
        const axis = pickAxis(mode, ray, obj.transform.position, this.gizmoSize());
        if (axis) {
          this.api.history().begin();
          this.gesture = { kind: "gizmo", objectId: sel, grab: beginGizmo(mode, axis, obj.transform, ray) };
          return;
        }
      }
    }

    // Sin eje agarrado: picking. El objeto cuya esfera envolvente corta el rayo
    // mas cerca de la camara.
    const hit = this.pickObject(ray);
    this.api.selectObject(hit);
    this.dirty = true;
    this.refreshState();
  }

  /** Transforma el objeto agarrado siguiendo el cursor. */
  private moveObject(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.kind !== "gizmo") return;
    const t = dragGizmo(g.grab, this.rayAt(e));
    this.api.doc().setObjectTransform(g.objectId, t);
    this.dirty = true;
    this.refreshState();
    this.api.changed();
  }

  /** Cierra la transformacion: un solo paso de historial para todo el arrastre. */
  private endObject(g: Gesture & { kind: "gizmo" }): void {
    void g;
    this.api.history().commit("Transformar objeto");
    this.api.changed();
  }

  /**
   * Objeto bajo el cursor, por su esfera envolvente.
   *
   * Barato y suficiente para seleccionar: la esfera que encierra la primitiva a su
   * escala. El que la corte mas cerca de la camara gana. Un picking por triangulo
   * seria mas fino, pero para agarrar un objeto y moverlo la esfera basta y no se
   * nota la diferencia.
   */
  private pickObject(ray: Ray): string | null {
    const doc = this.api.doc();
    let best: string | null = null;
    let bestT = Infinity;
    for (const o of doc.objects3d) {
      if (o.hidden || !doc.layerVisible(o.layerId)) continue;
      const c = o.transform.position;
      const radius = objectRadius(o);
      const t = raySphere(ray, c, radius);
      if (t !== null && t < bestT) {
        bestT = t;
        best = o.id;
      }
    }
    return best;
  }

  /** Inserta una primitiva en la capa del espacio, delante de la camara. */
  insertPrimitive(kind: PrimitiveKind): void {
    const doc = this.api.doc();
    const layer = doc.scene3dTarget();
    // Delante del punto de mira: a la vista, no en un rincon del espacio.
    const at = v3(this.camera.px, this.camera.py, this.camera.pz);
    const obj = makeObject(kind, uid(), layer.id, {
      transform: {
        position: at,
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
    const history = this.api.history();
    history.begin();
    doc.addObject3D(obj);
    history.commit("Insertar objeto");
    this.api.selectObject(obj.id);
    this.dirty = true;
    this.refreshState();
    this.api.changed();
  }

  // ------------------------------------------------------------- borrador

  /**
   * Borra lo que toca el borrador a lo largo del gesto.
   *
   * Se barre el camino entre la posicion anterior y la actual en pasos de medio
   * margen. Sin ese barrido, un gesto rapido deja huecos entre muestra y muestra
   * y el borrador perdona justo lo que se queria quitar.
   */
  /**
   * Borra a lo largo del gesto de la goma, de forma libre.
   *
   * Tanto los trazos como las manchas (relleno y arrastre) se cortan por donde
   * pasa la goma, con su forma -no se llevan enteros-:
   *  - **Trazos**: se parten en los tramos que la goma no toca.
   *  - **Manchas**: se les resta la region de la goma. Morder un borde las recorta,
   *    cruzarlas de lado a lado las parte en dos, y morder el centro les deja un
   *    agujero. Es una resta de poligonos de verdad.
   */
  private eraseAlong(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.kind !== "erase") return;
    const r = this.rect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const to = { x: ((e.clientX - r.left) / w) * 2 - 1, y: -(((e.clientY - r.top) / h) * 2 - 1) };
    const from = this.eraseFrom ?? to;

    // Trazos: se parte lo que la goma cruza entre la posicion anterior y la actual.
    if (this.erasePartialStrokes(from, to)) g.erasing = true;
    // Manchas: se les resta la region barrida por la goma en el mismo tramo.
    if (this.carveFills(from, to)) g.erasing = true;

    this.eraseFrom = to;
    if (g.erasing) {
      this.dirty = true;
      this.refreshState();
      this.api.changed();
    }
  }

  /**
   * Resta a cada mancha la region que la goma barre entre `from` y `to`.
   *
   * Todo ocurre en PANTALLA, que es donde la goma esta definida, y luego se
   * devuelve al plano de la mancha. Por mancha:
   *  1. Se proyectan sus anillos -contorno y agujeros- a pantalla.
   *  2. Se construye la huella de la goma -dos circulos y el rectangulo entre
   *     ellos, unidos- como poligono.
   *  3. Se resta esa huella de la mancha con un recorte de poligonos de verdad.
   *     El resultado puede ser varias piezas, cada una con sus agujeros.
   *  4. Cada pieza se devuelve al plano de la mancha lanzando un rayo por cada
   *     vertice y cortandolo con el plano -asi la perspectiva sale exacta-.
   *
   * Trabaja en coordenadas de pantalla escaladas (`CARVE_SCALE`) porque el recorte
   * de poligonos pierde precision con numeros muy pequenos como los de NDC.
   */
  private carveFills(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
    const r = this.rect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const aspect = w / h;
    const vp = viewProjection(this.camera, aspect);
    const doc = this.api.doc();
    const eraseRad = (Math.max(ERASE_SLOP, this.api.brush().size * 0.5) / h) * 2;
    const S = 1000; // escala para dar precision al recorte de poligonos
    const eraser = eraserFootprint(from, to, eraseRad, S);

    let changed = false;
    for (const fill of [...doc.fills3d]) {
      if (!doc.layerVisible(fill.layerId)) continue;

      const outer = projectRingScaled(vp, fill.outline, fill.count, S);
      if (!outer) continue; // algun vertice detras de la camara: no se toca
      // Descarte rapido: si la caja del contorno no roza el rastro de la goma.
      if (!bboxNearSegment(outer, from.x * S, from.y * S, to.x * S, to.y * S, eraseRad * S)) {
        continue;
      }

      const subjectRings: number[][][] = [outer];
      let bad = false;
      if (fill.holes) {
        for (const hole of fill.holes) {
          const hr = projectRingScaled(vp, hole, hole.length / 3, S);
          if (!hr) {
            bad = true;
            break;
          }
          subjectRings.push(hr);
        }
      }
      if (bad) continue;

      const before = ringsArea(subjectRings);
      let result: number[][][][];
      try {
        result = polygonClipping.difference(
          [subjectRings] as unknown as Parameters<typeof polygonClipping.difference>[0],
          [eraser] as unknown as Parameters<typeof polygonClipping.difference>[0],
        ) as unknown as number[][][][];
      } catch {
        continue; // un recorte degenerado no debe tumbar el gesto
      }
      const after = ringsAreaMulti(result);
      // Si no se quito area apreciable, la goma no toco de verdad esta mancha.
      if (before - after < Math.abs(before) * 1e-4) continue;

      const plane = this.fillPlane(fill);
      const nuevas: Fill3D[] = [];
      for (const poly of result) {
        const outerData = this.unprojectRing(poly[0], S, plane, aspect);
        if (!outerData || outerData.count < 3) continue;
        const holes: Float32Array[] = [];
        for (let hi = 1; hi < poly.length; hi++) {
          const hd = this.unprojectRing(poly[hi], S, plane, aspect);
          if (hd && hd.count >= 3) holes.push(hd.data);
        }
        nuevas.push(
          makeFill(uid(), outerData.data, outerData.count, {
            color: fill.color,
            layerId: fill.layerId,
            planeNormal: fill.planeNormal,
            holes,
          }),
        );
      }
      doc.replaceFill3DMany(fill.id, nuevas);
      changed = true;
    }
    return changed;
  }

  /** Borra con el contorno de mundo `poly` (cerrado) proyectado a pantalla. */
  private eraseWithWorldPolygon(poly: readonly V3[]): boolean {
    if (poly.length < 3) return false;
    const r = this.rect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const aspect = w / h;
    const vp = viewProjection(this.camera, aspect);
    const S = 1000;
    const cutter: number[][] = [];
    for (const p of poly) {
      const pr = projectPoint(vp, p.x, p.y, p.z);
      if (pr.w <= 0) return false;
      cutter.push([pr.x * S, pr.y * S]);
    }
    cutter.push([cutter[0]![0]!, cutter[0]![1]!]);
    let changed = false;
    if (this.carveFillsWithPoly(cutter, S, vp, aspect)) changed = true;
    if (this.carveStrokesWithPoly(cutter, S, vp)) changed = true;
    return changed;
  }

  private carveFillsWithPoly(
    cutter: number[][],
    scale: number,
    vp: Float32Array,
    aspect: number,
  ): boolean {
    const doc = this.api.doc();
    const cutterBox = bboxOfRing(cutter);
    let changed = false;
    for (const fill of [...doc.fills3d]) {
      if (!doc.layerVisible(fill.layerId)) continue;
      const outer = projectRingScaled(vp, fill.outline, fill.count, scale);
      if (!outer) continue;
      if (!bboxesOverlap(bboxOfRing(outer), cutterBox)) continue;
      const subjectRings: number[][][] = [outer];
      let bad = false;
      if (fill.holes) for (const hole of fill.holes) {
        const hr = projectRingScaled(vp, hole, hole.length / 3, scale);
        if (!hr) { bad = true; break; }
        subjectRings.push(hr);
      }
      if (bad) continue;
      const before = ringsArea(subjectRings);
      let result: number[][][][];
      try {
        result = polygonClipping.difference(
          [subjectRings] as unknown as Parameters<typeof polygonClipping.difference>[0],
          [[cutter]] as unknown as Parameters<typeof polygonClipping.difference>[0],
        ) as unknown as number[][][][];
      } catch { continue; }
      const after = ringsAreaMulti(result);
      if (before - after < Math.abs(before) * 1e-4) continue;
      const plane = this.fillPlane(fill);
      const nuevas: Fill3D[] = [];
      for (const poly2 of result) {
        const outerData = this.unprojectRing(poly2[0], scale, plane, aspect);
        if (!outerData || outerData.count < 3) continue;
        const holes: Float32Array[] = [];
        for (let hi = 1; hi < poly2.length; hi++) {
          const hd = this.unprojectRing(poly2[hi], scale, plane, aspect);
          if (hd && hd.count >= 3) holes.push(hd.data);
        }
        nuevas.push(makeFill(uid(), outerData.data, outerData.count, { color: fill.color, layerId: fill.layerId, planeNormal: fill.planeNormal, holes }));
      }
      doc.replaceFill3DMany(fill.id, nuevas);
      changed = true;
    }
    return changed;
  }

  private carveStrokesWithPoly(cutter: number[][], scale: number, vp: Float32Array): boolean {
    const tanHalf = Math.tan(this.camera.fovY * 0.5);
    const doc = this.api.doc();
    const cutterBox = bboxOfRing(cutter);
    let changed = false;
    for (const stroke of [...doc.strokes3d]) {
      if (!doc.layerVisible(stroke.layerId)) continue;
      if (stroke.count < 2) continue;
      const c = boundsCenter(stroke.bounds);
      const pc = projectPoint(vp, c.x, c.y, c.z);
      if (pc.w > 0) {
        const scrR = boundsRadius(stroke.bounds) / pc.w / tanHalf * scale;
        const b = {
          minX: pc.x * scale - scrR, minY: pc.y * scale - scrR,
          maxX: pc.x * scale + scrR, maxY: pc.y * scale + scrR,
        };
        if (!bboxesOverlap(b, cutterBox)) continue;
      }
      const built = this.densifyWithPoly(stroke, vp, cutter, scale, tanHalf);
      if (!built.any) continue;
      doc.replaceStroke3DMany(stroke.id, this.runsFromSamples(stroke, built.data, built.flags));
      changed = true;
    }
    return changed;
  }

  private densifyWithPoly(
    stroke: Stroke3D,
    vp: Float32Array,
    cutter: number[][],
    scale: number,
    tanHalf: number,
  ): { data: number[]; flags: boolean[]; any: boolean } {
    const STEP_PX = 5;
    const d = stroke.data;
    const out: number[] = [];
    const flags: boolean[] = [];
    let any = false;
    const isInside = (x: number, y: number, z: number, rad: number): boolean => {
      const p = projectPoint(vp, x, y, z);
      if (p.w <= 0) return false;
      const sx = p.x * scale, sy = p.y * scale, r = (rad / p.w / tanHalf) * scale;
      if (pointInPoly2D(cutter, sx, sy)) return true;
      // Borde engordado al radio: roza el contorno aunque el centro quede fuera.
      for (let i = 0, j = cutter.length - 1; i < cutter.length; j = i++) {
        if (distPointToSegment2D(sx, sy, cutter[j][0]!, cutter[j][1]!, cutter[i][0]!, cutter[i][1]!) <= r) return true;
      }
      return false;
    };
    for (let i = 0; i < stroke.count - 1; i++) {
      const oa = i * POINT_FLOATS, ob = (i + 1) * POINT_FLOATS;
      const pa = projectPoint(vp, d[oa]!, d[oa + 1]!, d[oa + 2]!);
      const pb = projectPoint(vp, d[ob]!, d[ob + 1]!, d[ob + 2]!);
      let subs = 1;
      if (pa.w > 0 && pb.w > 0) {
        const scrPx = Math.hypot(pb.x - pa.x, pb.y - pa.y) * 0.5 * this.rect().height;
        subs = Math.min(256, Math.max(1, Math.ceil(scrPx / STEP_PX)));
      }
      const kStart = i === 0 ? 0 : 1;
      for (let k = kStart; k <= subs; k++) {
        const u = k / subs;
        for (let f = 0; f < POINT_FLOATS; f++) out.push(d[oa + f]! + (d[ob + f]! - d[oa + f]!) * u);
        const base = out.length - POINT_FLOATS;
        const hit = isInside(out[base]!, out[base + 1]!, out[base + 2]!, out[base + RADIUS_OFFSET]!);
        flags.push(hit);
        if (hit) any = true;
      }
    }
    return { data: out, flags, any };
  }

  /** Plano de una mancha: un punto suyo y su normal. */
  private fillPlane(fill: { outline: Float32Array; count: number; planeNormal: V3 | null }): {
    point: V3;
    normal: V3;
  } {
    const point = v3(fill.outline[0]!, fill.outline[1]!, fill.outline[2]!);
    const normal = fill.planeNormal
      ? { ...fill.planeNormal }
      : outlineNormal(fill.outline, fill.count, v3());
    return { point, normal };
  }

  /**
   * Devuelve al mundo un anillo de pantalla escalada, sobre el plano de la mancha.
   *
   * Cada vertice lanza un rayo por su punto de pantalla y se corta con el plano:
   * como la mancha es plana, ese corte es unico y recupera la posicion exacta pese
   * a la perspectiva. Se quita el vertice de cierre que repite el primero.
   */
  private unprojectRing(
    ring: number[][],
    scale: number,
    plane: { point: V3; normal: V3 },
    aspect: number,
  ): { data: Float32Array; count: number } | null {
    const n = ring.length >= 2 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.length - 1
      : ring.length;
    if (n < 3) return null;
    const data = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ndcX = ring[i]![0] / scale;
      const ndcY = ring[i]![1] / scale;
      const ray = screenRay(this.camera, ndcX, ndcY, aspect);
      const hit = rayPlane({ origin: ray.origin, dir: ray.dir }, plane.point, plane.normal);
      if (!hit) return null;
      data[i * 3] = hit.x;
      data[i * 3 + 1] = hit.y;
      data[i * 3 + 2] = hit.z;
    }
    return { data, count: n };
  }

  /**
   * Parte los trazos que la goma cruza entre `from` y `to` (en NDC).
   *
   * El trazo se guarda como pocos puntos de control -una recta son dos o tres-, y
   * la cinta se interpola entre ellos. Por eso NO basta con quitar puntos: la goma
   * caeria entre dos puntos lejanos y no cortaria nada. Se **densifica** el trazo
   * -se recorre cada segmento a pasos finos en pantalla- y se marca cada muestra
   * segun caiga o no en el rastro de la goma (una capsula: el segmento `from`-`to`
   * engordado a su radio). Los tramos de muestras que sobreviven se vuelven trazos
   * nuevos en el sitio del original, insertando el corte justo donde pasa la goma.
   * Asi cortar por el medio deja dos trozos y recortar una punta la acorta.
   */
  private erasePartialStrokes(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
    const r = this.rect();
    const h = Math.max(1, r.height);
    const vp = viewProjection(this.camera, Math.max(1, r.width) / h);
    const doc = this.api.doc();
    // Radio de la goma en NDC: su tamano en pixeles, llevado al espacio -1..1. El
    // minimo de `ERASE_SLOP` evita que una goma fina no agarre nada.
    const eraseRad = (Math.max(ERASE_SLOP, this.api.brush().size * 0.5) / h) * 2;
    const tanHalf = Math.tan(this.camera.fovY * 0.5);

    let changed = false;
    // Copia de la lista: se va a modificar mientras se recorre.
    for (const stroke of [...doc.strokes3d]) {
      if (!doc.layerVisible(stroke.layerId)) continue;
      if (stroke.count < 2) continue;

      // Descarte rapido: si ni la esfera envolvente del trazo roza el rastro de la
      // goma, no se densifica -que es lo caro-. Es lo que deja barato pasar la goma
      // por una escena con muchos trazos.
      const c = boundsCenter(stroke.bounds);
      const pc = projectPoint(vp, c.x, c.y, c.z);
      if (pc.w > 0) {
        const scrR = boundsRadius(stroke.bounds) / pc.w / tanHalf;
        if (distPointToSegment2D(pc.x, pc.y, from.x, from.y, to.x, to.y) > eraseRad + scrR) {
          continue;
        }
      }

      const built = this.densifyWithErase(stroke, vp, from, to, eraseRad, tanHalf);
      if (!built.any) continue;
      doc.replaceStroke3DMany(stroke.id, this.runsFromSamples(stroke, built.data, built.flags));
      changed = true;
    }
    return changed;
  }

  /**
   * Densifica un trazo a pasos finos en pantalla y marca que muestras borra la goma.
   *
   * Devuelve las muestras como floats empaquetados -el mismo formato del trazo- y
   * una bandera por muestra. Interpolar los nueve floats (posicion, normal, radio,
   * presion, tiempo) mantiene el grosor y el perfil del trazo en los trozos que
   * quedan; la normal se rehace luego, asi que su valor interpolado da igual.
   */
  private densifyWithErase(
    stroke: Stroke3D,
    vp: Float32Array,
    from: { x: number; y: number },
    to: { x: number; y: number },
    eraseRad: number,
    tanHalf: number,
  ): { data: number[]; flags: boolean[]; any: boolean } {
    const STEP_PX = 5;
    const d = stroke.data;
    const out: number[] = [];
    const flags: boolean[] = [];
    let any = false;

    const sample = (x: number, y: number, z: number, rad: number): void => {
      const p = projectPoint(vp, x, y, z);
      let erased = false;
      if (p.w > 0) {
        const rNdc = rad / p.w / tanHalf;
        erased = distPointToSegment2D(p.x, p.y, from.x, from.y, to.x, to.y) <= eraseRad + rNdc;
      }
      flags.push(erased);
      if (erased) any = true;
    };

    for (let i = 0; i < stroke.count - 1; i++) {
      const oa = i * POINT_FLOATS;
      const ob = (i + 1) * POINT_FLOATS;
      // Cuantas subdivisiones: por la longitud del segmento en pantalla.
      const pa = projectPoint(vp, d[oa]!, d[oa + 1]!, d[oa + 2]!);
      const pb = projectPoint(vp, d[ob]!, d[ob + 1]!, d[ob + 2]!);
      let subs = 1;
      if (pa.w > 0 && pb.w > 0) {
        const scrPx = Math.hypot(pb.x - pa.x, pb.y - pa.y) * 0.5 * this.rect().height;
        subs = Math.min(256, Math.max(1, Math.ceil(scrPx / STEP_PX)));
      }
      // El primer punto del trazo entra una vez; luego cada segmento aporta sus
      // subdivisiones sin repetir el extremo que comparte con el vecino.
      const kStart = i === 0 ? 0 : 1;
      for (let k = kStart; k <= subs; k++) {
        const u = k / subs;
        for (let f = 0; f < POINT_FLOATS; f++) {
          out.push(d[oa + f]! + (d[ob + f]! - d[oa + f]!) * u);
        }
        const base = out.length - POINT_FLOATS;
        sample(out[base]!, out[base + 1]!, out[base + 2]!, out[base + RADIUS_OFFSET]!);
      }
    }
    return { data: out, flags, any };
  }

  /**
   * Construye los trazos que sobreviven de las muestras densificadas y sus marcas.
   *
   * Cada tramo de muestras seguidas sin borrar, de dos o mas, es un trazo nuevo.
   * Los sueltos se descartan -una muestra no es una cinta-, y si no sobrevive
   * ninguna el trazo desaparece, que es lo correcto cuando la goma lo cubre entero.
   */
  private runsFromSamples(stroke: Stroke3D, flat: readonly number[], flags: readonly boolean[]): Stroke3D[] {
    const runs: Stroke3D[] = [];
    const n = flags.length;
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const alive = i < n && !flags[i];
      if (alive && start < 0) start = i;
      else if (!alive && start >= 0) {
        if (i - start >= 2) runs.push(this.sliceSamples(stroke, flat, start, i));
        start = -1;
      }
    }
    return runs;
  }

  /** Un trazo nuevo con las muestras `[i0, i1)` del buffer densificado. */
  private sliceSamples(stroke: Stroke3D, flat: readonly number[], i0: number, i1: number): Stroke3D {
    const n = i1 - i0;
    const data = new Float32Array(flat.slice(i0 * POINT_FLOATS, i1 * POINT_FLOATS));
    // Los marcos de la cinta se recalculan: el tramo cortado tiene otros extremos.
    computeFrames(data, n, stroke.planeNormal ?? null);
    return {
      id: uid(),
      brush: stroke.brush,
      color: stroke.color,
      layerId: stroke.layerId,
      data,
      count: n,
      bounds: boundsOf(data, n),
      seed: stroke.seed,
      planeNormal: stroke.planeNormal ? { ...stroke.planeNormal } : null,
    };
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

  /**
   * Id de la mancha bajo un punto de pantalla, o `null`.
   *
   * A diferencia del trazo, una mancha es grande y plana: su esfera envolvente
   * borraria de mas -bastaria acercarse-, asi que se proyecta su contorno a
   * pantalla y se hace un test de punto-en-poligono. Solo acierta donde de verdad
   * hay relleno. Entre varias que se solapan, la mas cercana a la camara. Cubre a
   * la vez el relleno y el arrastre: los dos son `Fill3D`.
   */
  private pickFill(ndcX: number, ndcY: number): string | null {
    const r = this.rect();
    const h = Math.max(1, r.height);
    const vp = viewProjection(this.camera, Math.max(1, r.width) / h);
    const doc = this.api.doc();

    let bestId: string | null = null;
    let bestDepth = Infinity;
    for (const f of doc.fills3d) {
      if (!doc.layerVisible(f.layerId)) continue;
      if (f.count < 3 || f.count > MAX_OUTLINE_POINTS) continue;

      // Se proyecta el contorno a NDC. Si algun vertice queda detras de la camara,
      // se omite la mancha: un poligono con puntos invertidos no da un test fiable.
      const xs = this.pickScratchX;
      const ys = this.pickScratchY;
      let behind = false;
      let depthSum = 0;
      for (let i = 0; i < f.count; i++) {
        const o = i * 3;
        const p = projectPoint(vp, f.outline[o]!, f.outline[o + 1]!, f.outline[o + 2]!);
        if (p.w <= 0) {
          behind = true;
          break;
        }
        xs[i] = p.x;
        ys[i] = p.y;
        depthSum += p.w;
      }
      if (behind) continue;

      // Punto en poligono por lanzamiento de rayo: se cuenta cuantas aristas cruza
      // una semirrecta horizontal desde el cursor. Impar = dentro.
      let inside = false;
      for (let i = 0, j = f.count - 1; i < f.count; j = i++) {
        const xi = xs[i]!;
        const yi = ys[i]!;
        const xj = xs[j]!;
        const yj = ys[j]!;
        if ((yi > ndcY) !== (yj > ndcY) && ndcX < ((xj - xi) * (ndcY - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (!inside) continue;

      const depth = depthSum / f.count;
      if (depth < bestDepth) {
        bestDepth = depth;
        bestId = f.id;
      }
    }
    return bestId;
  }

  /** Borra lo que haya bajo el cursor -trazo o mancha-. Devuelve si borro algo. */
  private eraseAt(e: PointerEvent): boolean {
    const r = this.rect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    const ndcX = ((e.clientX - r.left) / w) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / h) * 2 - 1);
    const strokeId = this.pickStroke(ndcX, ndcY);
    if (strokeId) {
      this.deleteSpaceItem(() => this.api.doc().removeStroke3D(strokeId), "Borrar en el espacio");
      return true;
    }
    const fillId = this.pickFill(ndcX, ndcY);
    if (fillId) {
      this.deleteSpaceItem(() => this.api.doc().removeFill3D(fillId), "Borrar en el espacio");
      return true;
    }
    return false;
  }

  /** Quita del documento lo que borre `remove`, con su paso por el historial. */
  private deleteSpaceItem(remove: () => boolean, label: string): void {
    const history = this.api.history();
    history.begin();
    remove();
    history.commit(label);
    this.dirty = true;
    this.refreshState();
    this.api.changed();
  }

  /** Punto de mundo del plano de dibujo bajo el puntero. */
  private worldPoint(e: PointerEvent): V3 | null {
    const r = this.rect();
    if (r.width <= 0 || r.height <= 0) return null;
    const ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -(((e.clientY - r.top) / r.height) * 2 - 1);
    const aspect = r.width / Math.max(1, r.height);
    const s = this.api.settings();
    const anchor = s.snap.anchor;

    // Dos ejes independientes deciden donde cae el trazo:
    //  - el PLANO de dibujo da la orientacion de la superficie (hacia la camara,
    //    uno del mundo, o el del ancla);
    //  - la COLOCACION la mueve en profundidad (en el plano, en el origen, en el
    //    ancla, o pegada al trazo que haya debajo).
    const plane = drawPlane(s.drawPlane, this.camera, { depth: this.depth, anchor });

    // Modo "sobre el trazo": la profundidad sale del trazo que esta debajo del
    // cursor. Si no hay ninguno a tiro, se cae al plano, que es el respaldo
    // razonable: dibujar en el aire a la profundidad de la vista.
    if (s.placement.mode === "stroke") {
      const ray = screenRay(this.camera, ndcX, ndcY, aspect);
      const t = strokeDepthAt(
        this.api.doc().strokes3d,
        ray.origin,
        ray.dir,
        s.placement.radius,
        s.placement.target,
      );
      if (t !== null) return alongRay(ray.origin, ray.dir, t);
      return planePoint(plane, this.camera, ndcX, ndcY, aspect);
    }

    // Los demas modos solo desplazan el plano en profundidad.
    const movido = {
      point: placedPlanePoint(s.placement.mode, plane.point, anchor),
      normal: plane.normal,
    };
    return planePoint(movido, this.camera, ndcX, ndcY, aspect);
  }

  /** Normal del plano de dibujo activo, para que el trazo la guarde. */
  private planeNormal(): V3 {
    return planeNormalFor(this.api.settings().drawPlane, this.camera, this.api.settings().snap.anchor);
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

  /**
   * Avisa a la interfaz de que el estado del visor cambio.
   *
   * El visor ya no tiene HUD propio. Lo que hay que saber -el modo del puntero,
   * cuantos trazos y manchas hay, las llamadas de dibujado y la profundidad del
   * plano- va en la barra de estado, con el resto de la informacion del editor:
   * dos sitios diciendo lo mismo es ruido, y ademas el de abajo tapaba el dibujo.
   */
  private refreshState(): void {
    this.api.refresh();
  }
}

/** Radio del trazo en su punto medio, para pruebas y depuracion. */
export const midRadius = (stroke: Stroke3D): number =>
  radiusAt(stroke.data, Math.floor(stroke.count / 2));
