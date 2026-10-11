/**
 * Backend de render 3D sobre three.js.
 *
 * Que aporta three.js aqui y que no, porque conviene tenerlo claro:
 *
 *  - **Aporta** el contexto WebGL, la gestion de buffers y programas, el
 *    instanciado, y -mas adelante- sombras, posprocesado y exportacion glTF.
 *  - **No aporta** la proyeccion ni el dibujado de la cinta: el shader es propio y
 *    la matriz de vista-proyeccion tambien, porque vive en `camera3d.ts` y esta
 *    cubierta por pruebas. Se pasa como uniforme en vez de dejar que three la
 *    derive, para que lo que se dibuja sea exactamente lo que se prueba.
 *
 * El lienzo se compone como una capa mas: se dibuja aqui y el compositor 2D lo
 * recoge con `drawImage`, igual que hace el campo de materia. Por eso el contexto
 * pide alfa y alfa premultiplicado, y por eso se conserva el buffer de dibujado:
 * sin el, el lienzo quedaria vacio al leerlo despues del fotograma.
 *
 * Contexto propio y no el del campo de materia: aquel pide `depth: false` y
 * `antialias: false`, que son banderas de pase 2D e incompatibles con un render 3D
 * que necesita profundidad y bordes suavizados.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { INSTANCE_FLOATS, packSegments, segmentsOf, type StrokeBatch } from "../scene3d/batch";
import type { FillBatch } from "../scene3d/fill";
import { packLights, type Light3D } from "../scene3d/lights";
import { eyeOf, forwardOf, viewProjection, type Camera3DState } from "../scene3d/camera3d";
import { boundsRadius, type Stroke3D } from "../scene3d/types";
import { v3, type V3 } from "../scene3d/vec3";
import {
  bindInstances,
  createRibbonGeometry,
  createRibbonMaterial,
  disposeRibbon,
  emptyRibbonGeometry,
  syncRibbonGeometry,
  type RibbonGeometry,
} from "./ribbon";
import {
  createFillGeometry,
  createFillMaterial,
  syncFillGeometry,
  type FillGeometry,
} from "./fill";
import {
  createFloorGrid,
  disposeFloorGrid,
  updateFloorGrid,
  type FloorGrid,
  type GridOptions,
} from "./grid";
import {
  createObjectEntry,
  disposeObjectEntry,
  objectRevision,
  applyObject,
  type ObjectEntry,
} from "./objects";
import type { Object3D } from "../scene3d/objects";
import { AXIS_COLORS, type GizmoAxis as GizmoAxisName, type GizmoMode } from "../scene3d/gizmo";

/** Lo que hace falta para dibujar el gizmo: donde, de que tamano y que resaltar. */
export interface GizmoDraw {
  center: V3;
  size: number;
  mode: GizmoMode;
  /** Eje bajo el cursor, resaltado en blanco. */
  hover: GizmoAxisName | null;
}

/**
 * Piezas de un eje del gizmo, en coordenadas unitarias -el grupo las escala-.
 *
 * El grosor no es decorativo y costo verlo: con la varilla a 0.016 y la punta a
 * 0.06, a la escala a la que se planta el gizmo en pantalla ambos caian por debajo
 * del pixel, y el manipulador se veia como bolitas sueltas unidas por hilos. Las
 * medidas de abajo estan puestas para que a esa misma escala la varilla tenga un
 * par de pixeles de ancho y la punta se lea como una flecha o un cubo.
 *
 * Cada pieza nace apuntando +Y -de donde salen las geometrias de three- y se
 * ORIENTA Y COLOCA sobre su eje con la misma rotacion. El fallo que esto corrige:
 * poner `position.y` y despues rotar la malla NO mueve la pieza -`position` es del
 * padre, la rotacion gira la geometria sobre su origen-, asi que las tres varillas
 * quedaban apiladas en el eje Y, solo giradas, y las puntas de X y Z aparecian
 * amontonadas en la punta de la Y. Al rotar tambien el vector de posicion, cada
 * brazo sale por su eje.
 */
const buildGizmoAxis = (mode: GizmoMode, axis: GizmoAxisName): THREE.Mesh[] => {
  const color = AXIS_COLORS[axis];
  const mat = (): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });

  // Orienta la pieza de +Y a su eje Y COLOCA su centro a distancia `d` sobre ese
  // mismo eje. La rotacion y la traslacion van juntas: sin esto las puntas de X y
  // Z saltaban a la punta de la Y.
  const place = (m: THREE.Mesh, d: number): void => {
    if (axis === "x") {
      m.rotation.z = -Math.PI / 2;
      m.position.set(d, 0, 0);
    } else if (axis === "z") {
      m.rotation.x = Math.PI / 2;
      m.position.set(0, 0, d);
    } else {
      m.position.set(0, d, 0);
    }
  };

  if (mode === "rotate") {
    // Aro en el plano perpendicular al eje: un toro de tubo fino, como el de
    // `TransformControls` de three. Delgado pero con cuerpo, no un alambre.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.022, 8, 72), mat());
    // El toro nace en el plano XY (normal Z); se gira para que su normal sea el eje.
    if (axis === "x") ring.rotation.y = Math.PI / 2;
    else if (axis === "y") ring.rotation.x = Math.PI / 2;
    return [ring];
  }

  const meshes: THREE.Mesh[] = [];
  // Varilla fina, como la de un gizmo de editor 3D de verdad: del centro a 0.82.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.82, 10), mat());
  place(shaft, 0.41);
  meshes.push(shaft);

  // Punta: cono esbelto para mover, cubo pequeno para escalar. Al final del brazo.
  const tip =
    mode === "scale"
      ? new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat())
      : new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.2, 16), mat());
  place(tip, mode === "scale" ? 0.9 : 0.92);
  meshes.push(tip);
  return meshes;
};

interface BatchEntry {
  mesh: THREE.Mesh;
  ribbon: RibbonGeometry;
  material: THREE.ShaderMaterial;
  batch: StrokeBatch;
}

interface FillEntry {
  mesh: THREE.Mesh;
  fill: FillGeometry;
  material: THREE.ShaderMaterial;
  batch: FillBatch;
}

/**
 * Orden de dibujado que reserva cada capa: la mancha delante y, detras, sus
 * trazos. Multiplicar por dos deja hueco para el `+ 1` de la cinta.
 */
const FILL_ORDER_STEP = 2;

/**
 * Cinta provisional del trazo en curso.
 *
 * Va aparte de los lotes a proposito: el trazo vivo no pertenece al documento
 * -todavia no tiene identidad ni capa-, y meterlo en un lote obligaria a
 * reescribirlo entero al cerrarlo. Aqui es un buffer propio que se rellena con el
 * mismo empaquetado de segmentos, asi que lo que se ve mientras se dibuja y lo
 * que queda al soltar salen de la misma funcion.
 */
interface LiveEntry {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  buffer: THREE.InstancedInterleavedBuffer;
  data: Float32Array;
  color: string;
}

/** Orden de dibujado de la cinta provisional: por encima de todos los lotes. */
const LIVE_RENDER_ORDER = 1000;

/**
 * Como se pinta la capa de un lote.
 *
 * Se pasa como funcion y no como mapa porque cambiar de capa o de orden no debe
 * obligar a reconstruir nada: lo unico que hace falta es saber, al sincronizar,
 * que le toca a cada lote.
 */
export interface LayerPaint {
  /** La capa se dibuja. */
  visible: boolean;
  /** Opacidad de la capa entera (0..1). */
  opacity: number;
  /** Posicion en la pila: menor = mas abajo, se dibuja antes. */
  order: number;
}

/** Segmentos reservados para la cinta provisional. Cubre un gesto largo entero. */
const LIVE_RESERVE_SEGMENTS = 4096;

export interface BackendStats {
  /** Lotes dibujados: es exactamente el numero de llamadas de dibujado. */
  drawCalls: number;
  instances: number;
  /** Bytes residentes en la GPU. */
  bytes: number;
  /** Vertices de manchas rellenas. Van aparte de `instances`, que son segmentos
   *  de cinta: sumarlos daria un numero que no significa nada. */
  fillVertices: number;
}

/** Identidad de un lote. Tiene que coincidir con la clave de `StrokeScene`. */
const keyOf = (batch: StrokeBatch): string =>
  `${batch.layerId}|${batch.brush}|${batch.color}`;

export class Scene3DBackend {
  readonly canvas: HTMLCanvasElement;
  available = false;
  lastError: string | null = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  /** Camara de three: solo existe porque `render` exige una. No dibuja. */
  private readonly dummy = new THREE.PerspectiveCamera();
  private readonly entries = new Map<string, BatchEntry>();
  private readonly fillEntries = new Map<string, FillEntry>();
  private readonly objectEntries = new Map<string, ObjectEntry>();
  /** Marca del punto de anclaje, si lo hay. */
  private anchorMark: THREE.LineSegments | null = null;
  private anchorAt: V3 | null = null;
  private grid: FloorGrid | null = null;
  private gizmoGroup: THREE.Group | null = null;
  /** Luz direccional de three que proyecta el mapa de sombra. */
  private keyLight: THREE.DirectionalLight | null = null;
  /** Plano del suelo que recibe las sombras con forma de los objetos. */
  private shadowFloor: THREE.Mesh | null = null;
  private shadowFloorMat: THREE.ShadowMaterial | null = null;
  /** Modo con el que esta construido el gizmo actual, para rehacerlo al cambiar. */
  private gizmoMode: GizmoMode | null = null;
  /** Firma de las luces ya repartidas: evita reempaquetarlas en cada fotograma. */
  private lightSignature = "";
  /** Luces ya empaquetadas, para reescribirlas en los materiales nuevos. */
  private packedLights: ReturnType<typeof packLights> | null = null;
  private readonly mat = new THREE.Matrix4();
  private live: LiveEntry | null = null;
  /** Si los trazos leen la profundidad (se ocultan tras objetos solidos). */
  private occludeStrokes = true;
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // Se crea el contexto AQUI y se le pasa a three, en vez de dejar que three lo
    // cree. El motivo es importante y costo un rato encontrarlo: `getContext` solo
    // atiende la primera llamada por lienzo, y las siguientes devuelven el mismo
    // contexto **ignorando los atributos**. Sondeando antes con
    // `canvas.getContext("webgl2")` el contexto quedaba creado con los atributos
    // por defecto, asi que `preserveDrawingBuffer` nunca llegaba a aplicarse: el
    // visor pintaba, pero el buffer se vaciaba al componer y el lienzo se leia
    // vacio. Una sola llamada, con los atributos definitivos.
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: true,
        depth: true,
        premultipliedAlpha: true,
        // Imprescindible: el visor se compone luego sobre el documento con
        // `drawImage`, y sin conservar el buffer el lienzo se lee vacio.
        preserveDrawingBuffer: true,
        powerPreference: "high-performance",
      }) as WebGL2RenderingContext | null;
    } catch (err) {
      gl = null;
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    if (!gl) {
      this.lastError = this.lastError ?? "WebGL2 no disponible";
      console.warn(
        "[drawi] Visor 3D: getContext('webgl2') devolvio null. " +
          "Probable aceleracion por hardware desactivada o GPU en lista de bloqueo (revisa chrome://gpu).",
      );
      return;
    }

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, context: gl });
      this.renderer.setClearAlpha(0);
      // Sombras reales por mapa de sombra, suaves (PCF) como en el visor de inre.
      // Es lo que hace que un cubo proyecte una sombra con forma de cubo y que un
      // objeto ensombrezca a otro, en vez del disco de contacto que no sabe de
      // formas. Solo afecta a los objetos solidos; los trazos no proyectan.
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // Igual que el motor y que inre: tono plano, para que el color que se ve sea
      // el que se pinta y no una version con mapeado de tonos ACES por encima.
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.setupStudio();
      this.available = true;
    } catch (err) {
      this.available = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn("[drawi] Visor 3D: fallo la inicializacion de WebGL2:", this.lastError);
    }
  }

  /**
   * Luz de estudio y entorno para el PBR de los objetos, al estilo de inre.
   *
   * Tres piezas, y ninguna sustituye a las luces del documento -esas dan la
   * direccion de la sombra y el tono-; estas son el estudio del editor:
   *
   *  - **Hemisferio** flojo, para que un objeto sin ninguna luz no sea una silueta
   *    negra.
   *  - **Direccional con sombra**, que es la que proyecta el mapa de sombra. Su
   *    direccion y color se actualizan cada fotograma desde la luz principal del
   *    documento (`applyLights`).
   *  - **Mapa de entorno** generado en memoria (`RoomEnvironment` + PMREM), sin
   *    descargar ningun HDRI: el PBR sin entorno no tiene nada que reflejar y un
   *    objeto metalico se ve plano y muerto.
   */
  private setupStudio(): void {
    const r = this.renderer;
    if (!r) return;

    const hemi = new THREE.HemisphereLight(0xcfd4ff, 0x2a2a36, 0.55);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.castShadow = true;
    // El mapa de sombra: resolucion alta para que el borde no salga a bloques, y un
    // frustum amplio que cubre el volumen de trabajo. El sesgo quita el moare de
    // sombra ('shadow acne') sin desprender la sombra del objeto.
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 2;
    const cam = key.shadow.camera;
    cam.near = 1;
    cam.far = 4000;
    cam.left = -1200;
    cam.right = 1200;
    cam.top = 1200;
    cam.bottom = -1200;
    cam.updateProjectionMatrix();
    this.scene.add(key);
    this.scene.add(key.target);
    this.keyLight = key;

    // Entorno: se cocina una vez y se asigna a la escena, asi todos los materiales
    // PBR lo usan como reflejo e iluminacion indirecta sin tocar cada material.
    const pmrem = new THREE.PMREMGenerator(r);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();

    // Suelo que RECIBE la sombra. Es un plano con `ShadowMaterial`: invisible salvo
    // donde cae una sombra, que es lo que hace que la sombra del cubo aparezca con
    // su forma sobre el suelo -no un disco-. Como en el `ShadowFloor` de inre. Va a
    // la altura del suelo (`FLOOR_Y`, que es 0) y no intercepta nada: es puro
    // receptor. Su opacidad y la suavidad del borde las gradua el usuario.
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.35, transparent: true });
    floorMat.depthWrite = false;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    floor.renderOrder = -900; // justo encima de la rejilla (-1000), debajo de todo lo demas
    floor.visible = false;
    this.scene.add(floor);
    this.shadowFloor = floor;
    this.shadowFloorMat = floorMat;
  }

  get error(): string | null {
    return this.lastError;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (!this.renderer) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
  }

  /** Enciende o apaga la oclusion de trazos por objetos solidos. */
  setOccludeStrokes(on: boolean): void {
    this.occludeStrokes = on;
  }

  /**
   * Pone la escena de la GPU al dia con los lotes.
   *
   * Es incremental a proposito: los lotes que no cambiaron no se tocan. Rehacer
   * todo en cada fotograma seria justo el trabajo que este diseno evita.
   */
  sync(batches: readonly StrokeBatch[], paintOf: (layerId: string) => LayerPaint): void {
    if (!this.renderer) return;
    const live = new Set<string>();

    for (const batch of batches) {
      if (batch.ranges.length === 0) continue;
      // Una capa oculta no entra en `live`, y la pasada de limpieza del final se
      // lleva su malla. Asi ocultar y volver a mostrar no rehace la geometria:
      // el lote sigue intacto, solo deja de dibujarse.
      const paint = paintOf(batch.layerId);
      if (!paint.visible) continue;

      const key = keyOf(batch);
      live.add(key);

      let entry = this.entries.get(key);
      if (entry && entry.batch !== batch) {
        // El lote es otro objeto con la misma identidad: se tira y se rehace.
        this.destroyEntry(entry);
        this.entries.delete(key);
        entry = undefined;
      }

      if (!entry) {
        const ribbon = createRibbonGeometry(batch);
        const material = createRibbonMaterial({ color: batch.color, opacity: 1, gloss: 0.22 });
        const mesh = new THREE.Mesh(ribbon.geometry, material);
        // El culling lo hace `cull.ts` con las esferas por trazo, que son mucho
        // mas ajustadas que la envolvente del lote entero.
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.scene.add(mesh);
        entry = { mesh, ribbon, material, batch };
        this.entries.set(key, entry);
      } else if (syncRibbonGeometry(entry.ribbon, batch)) {
        // El lote crecio y reemplazo su array: las vistas intercaladas apuntan a
        // memoria vieja, asi que hay que rehacer la geometria.
        this.destroyEntry(entry);
        const ribbon = createRibbonGeometry(batch);
        const material = createRibbonMaterial({ color: batch.color, opacity: 1, gloss: 0.22 });
        const mesh = new THREE.Mesh(ribbon.geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.scene.add(mesh);
        this.entries.set(key, { mesh, ribbon, material, batch });
        entry = this.entries.get(key) as BatchEntry;
      }

      entry.material.uniforms.uOpacity.value = paint.opacity;
      // El orden de la pila del panel manda el orden de dibujado: three ordena
      // primero por `renderOrder`, asi que basta con numerar las capas como
      // estan en la lista. Se reescribe en cada sincronizacion porque reordenar
      // las capas no toca ni un vertice. El `+ 1` es el sitio que le queda libre
      // al trazo justo por encima de las manchas de su propia capa.
      entry.mesh.renderOrder = paint.order * FILL_ORDER_STEP + 1;
    }

    for (const [key, entry] of [...this.entries]) {
      if (live.has(key)) continue;
      this.destroyEntry(entry);
      this.entries.delete(key);
    }
  }

  /**
   * Pinta la cinta provisional del trazo en curso, o la quita con `null`.
   *
   * Se llama en cada muestra del gesto. El coste es el de empaquetar los segmentos
   * y marcar el buffer: nada de rehacer la geometria salvo que el gesto crezca por
   * encima de lo reservado, que es lo que pasa como mucho una vez por trazo.
   */
  setLive(stroke: Stroke3D | null): void {
    if (!this.renderer) return;

    if (!stroke) {
      // No se destruye: el siguiente trazo reutiliza el mismo buffer y la misma
      // malla. Solo se deja de dibujar.
      if (this.live) {
        this.live.geometry.instanceCount = 0;
        this.live.mesh.visible = false;
      }
      return;
    }

    const segments = segmentsOf(stroke.count);
    if (segments <= 0) return;

    let entry = this.live;
    if (!entry) {
      entry = this.makeLiveEntry(
        new Float32Array(LIVE_RESERVE_SEGMENTS * INSTANCE_FLOATS),
        stroke.color,
      );
    }

    if (segments * INSTANCE_FLOATS > entry.data.length) {
      // El gesto crecio por encima de lo reservado. El array es nuevo, asi que las
      // vistas intercaladas apuntan a memoria vieja y hay que rehacer la
      // geometria. Es la unica reasignacion que hace un trazo, y ocurre como mucho
      // una vez por gesto.
      let cap = entry.data.length;
      while (cap < segments * INSTANCE_FLOATS) cap *= 2;
      this.destroyLive();
      entry = this.makeLiveEntry(new Float32Array(cap), stroke.color);
    }

    packSegments(entry.data, 0, stroke);
    entry.buffer.needsUpdate = true;
    entry.geometry.instanceCount = segments;
    entry.mesh.visible = true;

    if (entry.color !== stroke.color) {
      (entry.material.uniforms.uColor.value as THREE.Color).set(stroke.color);
      entry.color = stroke.color;
    }
  }

  /** Dibuja la escena. `cam` es el estado puro de `camera3d.ts`. */
  render(cam: Camera3DState, lights: readonly Light3D[] = []): void {
    const renderer = this.renderer;
    if (!renderer) return;

    this.applyLights(lights);

    const aspect = this.width / this.height;
    // Cerca y lejos derivados de la distancia: el mundo de drawi se mide en las
    // mismas unidades que el lienzo, y con valores fijos o se pierde el trazo fino
    // o aparece z-fighting al alejarse.
    const near = Math.max(0.05, cam.distance * 0.005);
    const far = Math.max(near * 200, cam.distance * 60);

    const vp = viewProjection(cam, aspect, near, far, this.vpScratch);
    this.mat.fromArray(vp);

    const eye = eyeOf(cam, this.eyeScratch);

    // La camara de three se sincroniza solo para que su `cameraPosition` y sus
    // planos coincidan; la proyeccion que se usa es la de arriba.
    this.dummy.fov = (cam.fovY * 180) / Math.PI;
    this.dummy.aspect = aspect;
    this.dummy.near = near;
    this.dummy.far = far;
    this.dummy.position.set(eye.x, eye.y, eye.z);
    const fwd = forwardOf(cam, this.fwdScratch);
    this.dummy.lookAt(eye.x + fwd.x, eye.y + fwd.y, eye.z + fwd.z);
    this.dummy.updateProjectionMatrix();
    this.dummy.updateMatrixWorld();

    // Los materiales PROPIOS del visor -cinta, manchas, rejilla, sombra de
    // contacto y la cinta provisional- comparten los mismos uniformes de camara,
    // asi que se recorren en un solo sitio. Los objetos NO entran aqui: usan
    // `MeshStandardMaterial` de three, que deriva sus matrices de la camara nativa
    // (`this.dummy`) y no tiene `uniforms` que escribir.
    const materiales: THREE.ShaderMaterial[] = [...this.entries.values()].map((e) => e.material);
    for (const entry of this.fillEntries.values()) materiales.push(entry.material);
    if (this.live) materiales.push(this.live.material);

    // Oclusion de trazos: cuando esta encendida, los trazos y manchas comprueban la
    // profundidad -asi un objeto solido delante los tapa- pero NO la escriben, para
    // seguir componiendose por capas entre si. Apagada, se dibujan siempre encima,
    // como en un lienzo plano. Es una bandera por material y se reescribe aqui, no
    // al crear, porque el usuario la cambia en vivo.
    for (const material of materiales) {
      if (material.depthTest !== this.occludeStrokes) {
        material.depthTest = this.occludeStrokes;
        material.needsUpdate = true;
      }
    }
    if (this.grid) materiales.push(this.grid.material);

    for (const material of materiales) {
      const u = material.uniforms;
      if (u.uViewProjection) (u.uViewProjection.value as THREE.Matrix4).copy(this.mat);
      if (u.uCameraPos) (u.uCameraPos.value as THREE.Vector3).set(eye.x, eye.y, eye.z);
    }

    renderer.render(this.scene, this.dummy);
  }

  /**
   * Pone las mallas de las manchas de acuerdo con sus lotes.
   *
   * Es el gemelo de `sync` para las manchas, y comparte sus dos reglas: una capa
   * oculta no entra en `live` -y la limpieza del final se lleva su malla-, y el
   * orden de la pila del panel manda el orden de dibujado.
   *
   * Las manchas de una capa van **antes** que sus trazos: una mancha es una
   * lamina de fondo y lo natural es que las lineas se lean por encima. Por eso el
   * orden va multiplicado por dos, para que quepa el trazo justo detras.
   */
  syncFills(batches: readonly FillBatch[], paintOf: (layerId: string) => LayerPaint): void {
    if (!this.renderer) return;
    const live = new Set<string>();

    for (const batch of batches) {
      if (batch.vertices === 0) continue;
      const paint = paintOf(batch.layerId);
      if (!paint.visible) continue;

      const key = `${batch.layerId}|${batch.color}`;
      live.add(key);

      let entry = this.fillEntries.get(key);
      if (entry && entry.batch !== batch) {
        this.destroyFillEntry(entry);
        this.fillEntries.delete(key);
        entry = undefined;
      }
      if (!entry) {
        const fill = createFillGeometry(batch);
        const material = createFillMaterial(batch.color, paint.opacity);
        const mesh = new THREE.Mesh(fill.geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.scene.add(mesh);
        entry = { mesh, fill, material, batch };
        this.fillEntries.set(key, entry);
      } else if (syncFillGeometry(entry.fill, batch)) {
        this.destroyFillEntry(entry);
        const fill = createFillGeometry(batch);
        const material = createFillMaterial(batch.color, paint.opacity);
        const mesh = new THREE.Mesh(fill.geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.scene.add(mesh);
        entry = { mesh, fill, material, batch };
        this.fillEntries.set(key, entry);
      }

      entry.material.uniforms.uOpacity.value = paint.opacity;
      entry.mesh.renderOrder = paint.order * FILL_ORDER_STEP;
    }

    for (const [key, entry] of [...this.fillEntries]) {
      if (live.has(key)) continue;
      this.destroyFillEntry(entry);
      this.fillEntries.delete(key);
    }
  }

  /**
   * Pone las mallas de las primitivas de acuerdo con los objetos del documento.
   *
   * Como las manchas: una capa oculta no entra -y la limpieza del final se lleva
   * su malla-. A diferencia de los trazos, cada objeto es su propia malla: son
   * pocos y cada uno tiene su geometria, asi que no hay lotes que valgan.
   *
   * El orden de dibujado los pone por DEBAJO de los trazos y las manchas de su
   * capa: un objeto es casi siempre el andamio sobre el que se dibuja, asi que las
   * lineas tienen que leerse por encima.
   */
  syncObjects(objects: readonly Object3D[], paintOf: (layerId: string) => LayerPaint): void {
    if (!this.renderer) return;
    const live = new Set<string>();

    for (const o of objects) {
      const paint = paintOf(o.layerId);
      if (!paint.visible || o.hidden) continue;
      live.add(o.id);

      let entry = this.objectEntries.get(o.id);
      // Cambiar de primitiva (cubo a esfera) es otra geometria: se rehace. Lo
      // demas -mover, color, opacidad- se actualiza en sitio.
      if (entry && entry.kind !== o.kind) {
        this.destroyObjectEntry(entry);
        this.objectEntries.delete(o.id);
        entry = undefined;
      }
      if (!entry) {
        entry = createObjectEntry(o);
        this.scene.add(entry.mesh);
        this.objectEntries.set(o.id, entry);
      } else if (entry.revision !== objectRevision(o)) {
        applyObject(entry.mesh, entry.material, o);
        entry.revision = objectRevision(o);
      }
      // La opacidad de la capa multiplica a la del objeto: ocultar a medias una
      // capa atenua todo lo suyo, objetos incluidos.
      const op = o.opacity * paint.opacity;
      entry.material.opacity = op;
      entry.material.transparent = op < 0.999;
      entry.material.depthWrite = !entry.material.transparent;
      // Muy por debajo de trazos y manchas: el andamio va al fondo de su capa.
      entry.mesh.renderOrder = paint.order * FILL_ORDER_STEP - 1;
    }

    for (const [id, entry] of [...this.objectEntries]) {
      if (live.has(id)) continue;
      this.destroyObjectEntry(entry);
      this.objectEntries.delete(id);
    }
  }

  /**
   * Gradua las sombras REALES de los objetos sobre el suelo.
   *
   * Ya no son discos de contacto: los objetos proyectan su silueta de verdad con
   * el mapa de sombra de three (configurado en `setupStudio`), y este plano la
   * recibe. Aqui solo se ajusta lo que el usuario gradua -encendido, opacidad- y
   * la suavidad del borde del mapa de sombra, que es lo que decide si la sombra
   * sale blanda o marcada. La forma y donde cae las ponen el objeto y la luz.
   *
   * `enabled` apaga el suelo receptor; `opacity` es la del `ShadowMaterial`;
   * `softness` 0..1 gradua el radio de desenfoque PCF de la luz.
   */
  syncShadows(enabled: boolean, opacity: number, softness: number): void {
    if (!this.renderer) return;
    const floor = this.shadowFloor;
    const mat = this.shadowFloorMat;
    if (floor && mat) {
      floor.visible = enabled && opacity > 0.002;
      mat.opacity = opacity;
    }
    if (this.keyLight) {
      // El radio de desenfoque del mapa de sombra: 0 = borde neto, mas = penumbra.
      // Es el equivalente "real" de la dureza del disco que habia antes.
      this.keyLight.shadow.radius = 1 + softness * 12;
    }
  }

  /**
   * Marca del punto de anclaje, o `null` para quitarla.
   *
   * Sin una marca visible, "arrancar desde el anclaje" es una opcion que no se
   * puede comprobar: el punto esta en el espacio y no se ve. Se dibuja una cruz de
   * tres ejes, que ademas dice hacia donde apunta el mundo en ese punto.
   */
  drawAnchor(p: V3 | null, size: number): void {
    if (!this.renderer) return;
    if (!p) {
      if (this.anchorMark) this.anchorMark.visible = false;
      this.anchorAt = null;
      return;
    }
    // Solo se rehace si de verdad se movio: esto se llama en cada fotograma.
    if (this.anchorAt && this.anchorAt.x === p.x && this.anchorAt.y === p.y && this.anchorAt.z === p.z) {
      if (this.anchorMark) this.anchorMark.visible = true;
      return;
    }
    this.anchorAt = { x: p.x, y: p.y, z: p.z };

    if (!this.anchorMark) {
      const geo = new THREE.BufferGeometry();
      // Tres ejes, cada uno de los dos mitades para que la cruz quede centrada.
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(18), 3),
      );
      const mat = new THREE.LineBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.9 });
      this.anchorMark = new THREE.LineSegments(geo, mat);
      this.anchorMark.frustumCulled = false;
      this.anchorMark.matrixAutoUpdate = false;
      // Por encima de todo menos del trazo en curso: la marca es una ayuda, no
      // parte del dibujo, pero tiene que verse aunque quede detras de una cinta.
      this.anchorMark.renderOrder = LIVE_RENDER_ORDER - 1;
      this.scene.add(this.anchorMark);
    }

    const attr = this.anchorMark.geometry.getAttribute("position") as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    const ejes: [number, number, number][] = [
      [size, 0, 0],
      [0, size, 0],
      [0, 0, size],
    ];
    for (let i = 0; i < 3; i++) {
      const [dx, dy, dz] = ejes[i];
      const o = i * 6;
      a[o] = p.x - dx;
      a[o + 1] = p.y - dy;
      a[o + 2] = p.z - dz;
      a[o + 3] = p.x + dx;
      a[o + 4] = p.y + dy;
      a[o + 5] = p.z + dz;
    }
    attr.needsUpdate = true;
    this.anchorMark.visible = true;
  }

  /**
   * Dibuja el gizmo de transformacion alrededor de un objeto, o lo quita.
   *
   * Es geometria de ayuda, no parte del dibujo: lineas para mover y escalar, aros
   * para rotar. El eje bajo el cursor se resalta -lo decide el llamante, que es
   * quien hace el picking-. Va por encima de todo lo demas para poder agarrarlo
   * aunque quede detras de un trazo.
   */
  /**
   * Dibuja el gizmo de transformacion alrededor de un objeto, o lo quita.
   *
   * El gizmo es geometria de verdad -flechas con punta de cono para mover, cubos
   * para escalar, aros de tubo para rotar-, no lineas sueltas: a un pixel de
   * grosor el gizmo se veia como un garabato, y lo que hace que parezca el de un
   * programa serio es que los brazos tengan cuerpo. Se construye UNA vez por modo
   * y se guarda; cada fotograma solo se recoloca -una matriz- y se recolorea el
   * eje que esta bajo el cursor. Rehacer la geometria en cada fotograma, con conos
   * y toros, era justo el desperdicio que no hace falta.
   */
  drawGizmo(gizmo: GizmoDraw | null): void {
    if (!this.renderer) return;
    if (!gizmo) {
      if (this.gizmoGroup) this.gizmoGroup.visible = false;
      return;
    }
    // Se rehace solo al cambiar de modo; mover el objeto o alejar la camara no
    // tocan la geometria, solo la matriz del grupo.
    if (!this.gizmoGroup || this.gizmoMode !== gizmo.mode) {
      this.rebuildGizmo(gizmo.mode);
      this.gizmoMode = gizmo.mode;
    }
    const group = this.gizmoGroup as THREE.Group;
    group.visible = true;

    // Matriz del grupo: lleva las piezas unitarias al centro del objeto y las
    // escala al tamano que toca. Asi el gizmo mide parecido en pantalla a
    // cualquier zoom sin recalcular ni un vertice.
    group.matrix.makeScale(gizmo.size, gizmo.size, gizmo.size);
    group.matrix.setPosition(gizmo.center.x, gizmo.center.y, gizmo.center.z);
    group.renderOrder = LIVE_RENDER_ORDER + 1;

    // Resalte del eje bajo el cursor: se aclara su color, el resto vuelve al suyo.
    for (const child of group.children) {
      const axis = child.userData.axis as GizmoAxisName;
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      const base = AXIS_COLORS[axis];
      mat.color.set(axis === gizmo.hover ? 0xffe36b : base);
      mat.opacity = axis === gizmo.hover ? 1 : 0.9;
    }
  }

  /** Construye las piezas del gizmo para un modo, en coordenadas unitarias. */
  private rebuildGizmo(mode: GizmoMode): void {
    if (this.gizmoGroup) {
      for (const child of [...this.gizmoGroup.children]) {
        this.gizmoGroup.remove(child);
        (child as THREE.Mesh).geometry.dispose();
        ((child as THREE.Mesh).material as THREE.Material).dispose();
      }
      this.scene.remove(this.gizmoGroup);
    }
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    this.gizmoGroup = group;
    this.scene.add(group);

    for (const axis of ["x", "y", "z"] as GizmoAxisName[]) {
      for (const mesh of buildGizmoAxis(mode, axis)) {
        mesh.userData.axis = axis;
        group.add(mesh);
      }
    }
  }

  /**
   * Rejilla del suelo: la enciende, la coloca bajo la camara o la aparta.
   *
   * Se llama en cada fotograma, asi que lo barato importa: mientras esta apagada
   * no se crea siquiera la malla, y encendida solo se le cambian uniformes.
   */
  syncGrid(opts: GridOptions | null): void {
    if (!this.renderer) return;
    if (!opts) {
      if (this.grid) this.grid.mesh.visible = false;
      return;
    }
    if (!this.grid) {
      this.grid = createFloorGrid();
      this.scene.add(this.grid.mesh);
    }
    updateFloorGrid(this.grid, opts);
    this.grid.mesh.visible = opts.opacity > 0.002;
  }

  /**
   * Reparte las luces del documento entre todos los materiales del visor.
   *
   * Se hace antes de dibujar y no al crear cada material, porque los materiales
   * nacen cuando aparece su primer lote: una luz cambiada con la escena ya
   * montada no llegaria a los lotes que ya existian.
   *
   * La firma evita reempaquetar en cada fotograma: las luces cambian cuando
   * alguien las toca, no sesenta veces por segundo.
   */
  /**
   * Reparte las luces del documento entre todos los materiales del visor.
   *
   * Se empaqueta una sola vez por cambio -eso lo guarda la firma-, pero se ESCRIBE
   * en todos los materiales cada vez. Es la correccion de un fallo que hacia que
   * las luces "no se vieran": un material nace cuando aparece su primer lote, con
   * los uniformes de luz en su valor plano por defecto; si la firma no habia
   * cambiado desde entonces, nunca recibia la luz de verdad, asi que cada trazo
   * nuevo salia sin iluminar y mover la luz no le hacia nada. Escribir siempre
   * cuesta unas pocas asignaciones de vector por material -un punado- y quita de
   * raiz esa clase de fallo.
   */
  private applyLights(lights: readonly Light3D[]): void {
    let firma = "";
    for (const l of lights) {
      firma += `${l.id}${l.enabled ? 1 : 0}${l.color}${l.intensity}${l.x},${l.y},${l.z};`;
    }
    if (firma !== this.lightSignature) {
      this.lightSignature = firma;
      this.packedLights = packLights(lights);
    }
    const packed = this.packedLights;
    if (!packed) return;

    // Los materiales PROPIOS -cinta, manchas, cinta provisional- llevan la luz en
    // sus uniformes. Los objetos usan `MeshStandardMaterial`, que se ilumina con
    // las luces nativas de three (el estudio) y no tiene estos uniformes.
    const materiales: THREE.ShaderMaterial[] = [...this.entries.values()].map((e) => e.material);
    for (const entry of this.fillEntries.values()) materiales.push(entry.material);
    if (this.live) materiales.push(this.live.material);

    for (const material of materiales) {
      const u = material.uniforms;
      const vec = u.uLightVec?.value as THREE.Vector4[] | undefined;
      const col = u.uLightColor?.value as THREE.Vector3[] | undefined;
      if (!vec || !col) continue;
      for (let i = 0; i < vec.length; i++) {
        vec[i].set(
          packed.positions[i * 4],
          packed.positions[i * 4 + 1],
          packed.positions[i * 4 + 2],
          packed.positions[i * 4 + 3],
        );
        col[i].set(packed.colors[i * 3], packed.colors[i * 3 + 1], packed.colors[i * 3 + 2]);
      }
      (u.uAmbient.value as THREE.Vector3).set(
        packed.ambient[0],
        packed.ambient[1],
        packed.ambient[2],
      );
    }

    // La luz direccional de three -la que proyecta el mapa de sombra sobre los
    // objetos PBR- sigue a la luz principal del documento: su direccion es la del
    // sol de la escena, para que la sombra con forma caiga hacia donde el usuario
    // puso la luz. Se coloca lejos en esa direccion y apunta al origen.
    const key = this.keyLight;
    if (key) {
      const sun = lights.find((l) => l.enabled && l.kind !== "ambient") ?? null;
      if (sun) {
        key.visible = true;
        const d = v3(sun.x, sun.y, sun.z);
        const len = Math.hypot(d.x, d.y, d.z) || 1;
        const dist = 2000;
        key.position.set((d.x / len) * dist, (d.y / len) * dist, (d.z / len) * dist);
        key.target.position.set(0, 0, 0);
        key.target.updateMatrixWorld();
        key.color.set(sun.color);
        key.intensity = 2.0 * Math.max(0, sun.intensity);
      } else {
        key.visible = false;
      }
    }
  }

  /** Esfera envolvente de todo lo dibujable, para encuadrar la vista. */
  bounds(): { cx: number; cy: number; cz: number; radius: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let any = false;

    for (const batch of this.entries.values()) {
      for (const r of batch.batch.ranges) {
        if (!r.active) continue;
        any = true;
        minX = Math.min(minX, r.cx - r.radius);
        minY = Math.min(minY, r.cy - r.radius);
        minZ = Math.min(minZ, r.cz - r.radius);
        maxX = Math.max(maxX, r.cx + r.radius);
        maxY = Math.max(maxY, r.cy + r.radius);
        maxZ = Math.max(maxZ, r.cz + r.radius);
      }
    }

    // Las manchas entran tambien: encuadrar dejandolas fuera deja media obra
    // fuera de la vista, y son justo lo que mas abulta.
    for (const entry of this.fillEntries.values()) {
      const p = entry.batch.positions;
      for (let i = 0; i + 2 < p.length; i += 3) {
        any = true;
        if (p[i] < minX) minX = p[i];
        if (p[i + 1] < minY) minY = p[i + 1];
        if (p[i + 2] < minZ) minZ = p[i + 2];
        if (p[i] > maxX) maxX = p[i];
        if (p[i + 1] > maxY) maxY = p[i + 1];
        if (p[i + 2] > maxZ) maxZ = p[i + 2];
      }
    }
    if (!any) return null;

    const b = { minX, minY, minZ, maxX, maxY, maxZ };
    return {
      cx: (minX + maxX) * 0.5,
      cy: (minY + maxY) * 0.5,
      cz: (minZ + maxZ) * 0.5,
      radius: boundsRadius(b),
    };
  }

  stats(): BackendStats {
    let instances = 0;
    let bytes = 0;
    for (const e of this.entries.values()) {
      instances += e.ribbon.geometry.instanceCount;
      bytes += e.batch.data.byteLength;
    }
    let fillVertices = 0;
    for (const e of this.fillEntries.values()) {
      fillVertices += e.batch.vertices;
      bytes += e.batch.bytes;
    }
    // Las draw calls cuentan las dos familias: son llamadas de dibujado, y quien
    // lea el numero quiere saber cuantas se hacen, no de que tipo son.
    return {
      drawCalls: this.entries.size + this.fillEntries.size,
      instances,
      bytes,
      fillVertices,
    };
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
    // La cinta provisional no cuenta en `stats()` -describe el documento, no el
    // gesto en curso-, pero si hay que soltarla: su geometria tambien vive en la
    // GPU.
    this.destroyLive();
    for (const entry of this.fillEntries.values()) this.destroyFillEntry(entry);
    this.fillEntries.clear();
    for (const entry of this.objectEntries.values()) this.destroyObjectEntry(entry);
    this.objectEntries.clear();
    if (this.anchorMark) {
      this.scene.remove(this.anchorMark);
      this.anchorMark.geometry.dispose();
      (this.anchorMark.material as THREE.Material).dispose();
      this.anchorMark = null;
    }
    if (this.grid) {
      this.scene.remove(this.grid.mesh);
      disposeFloorGrid(this.grid);
      this.grid = null;
    }
    if (this.gizmoGroup) {
      for (const child of [...this.gizmoGroup.children]) {
        const m = child as THREE.Mesh | THREE.LineSegments;
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      this.scene.remove(this.gizmoGroup);
      this.gizmoGroup = null;
    }
    // El entorno PBR es una textura cocinada; se suelta al cerrar.
    this.scene.environment?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.available = false;
  }

  private destroyEntry(entry: BatchEntry): void {
    this.scene.remove(entry.mesh);
    disposeRibbon(entry.ribbon);
    entry.material.dispose();
  }

  private makeLiveEntry(data: Float32Array, color: string): LiveEntry {
    const geometry = emptyRibbonGeometry();
    const buffer = bindInstances(geometry, data);
    const material = createRibbonMaterial({ color, opacity: 1, gloss: 0.22 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    // Por encima de todos los lotes: lo que se esta dibujando tiene que verse
    // siempre, aunque quede detras de un trazo ya cerrado y coplanar con el.
    mesh.renderOrder = LIVE_RENDER_ORDER;
    this.scene.add(mesh);
    this.live = { mesh, geometry, material, buffer, data, color };
    return this.live;
  }

  private destroyFillEntry(entry: FillEntry): void {
    this.scene.remove(entry.mesh);
    entry.fill.geometry.dispose();
    entry.material.dispose();
  }

  private destroyObjectEntry(entry: ObjectEntry): void {
    this.scene.remove(entry.mesh);
    disposeObjectEntry(entry);
  }

  private destroyLive(): void {
    const entry = this.live;
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.geometry.dispose();
    entry.material.dispose();
    this.live = null;
  }

  private readonly vpScratch = new Float32Array(16);
  private readonly eyeScratch = { x: 0, y: 0, z: 0 };
  private readonly fwdScratch = { x: 0, y: 0, z: 0 };
}
