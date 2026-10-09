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
import { INSTANCE_FLOATS, packSegments, segmentsOf, type StrokeBatch } from "../scene3d/batch";
import type { FillBatch } from "../scene3d/fill";
import { eyeOf, forwardOf, viewProjection, type Camera3DState } from "../scene3d/camera3d";
import { boundsRadius, type Stroke3D } from "../scene3d/types";
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
  private readonly mat = new THREE.Matrix4();
  private live: LiveEntry | null = null;
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
      this.available = true;
    } catch (err) {
      this.available = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn("[drawi] Visor 3D: fallo la inicializacion de WebGL2:", this.lastError);
    }
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
  render(cam: Camera3DState): void {
    const renderer = this.renderer;
    if (!renderer) return;

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

    // Todos los materiales del visor son shaders propios y comparten los mismos
    // uniformes de camara, asi que se recorren en un solo sitio. La cinta
    // provisional entra aqui igual: no esta en `entries` -no es un lote-, y sin
    // esto se dibujaria con la proyeccion identidad, es decir, no se veria.
    const materiales = [...this.entries.values()].map((e) => e.material);
    for (const entry of this.fillEntries.values()) materiales.push(entry.material);
    if (this.live) materiales.push(this.live.material);

    for (const material of materiales) {
      const u = material.uniforms;
      (u.uViewProjection.value as THREE.Matrix4).copy(this.mat);
      (u.uCameraPos.value as THREE.Vector3).set(eye.x, eye.y, eye.z);
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
