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
import type { StrokeBatch } from "../scene3d/batch";
import { eyeOf, forwardOf, viewProjection, type Camera3DState } from "../scene3d/camera3d";
import { boundsRadius } from "../scene3d/types";
import {
  createRibbonGeometry,
  createRibbonMaterial,
  disposeRibbon,
  syncRibbonGeometry,
  type RibbonGeometry,
} from "./ribbon";

interface BatchEntry {
  mesh: THREE.Mesh;
  ribbon: RibbonGeometry;
  material: THREE.ShaderMaterial;
  batch: StrokeBatch;
}

export interface BackendStats {
  /** Lotes dibujados: es exactamente el numero de llamadas de dibujado. */
  drawCalls: number;
  instances: number;
  /** Bytes residentes en la GPU. */
  bytes: number;
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
  private readonly mat = new THREE.Matrix4();
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
  sync(batches: readonly StrokeBatch[], opacityOf: (layerId: string) => number): void {
    if (!this.renderer) return;
    const live = new Set<string>();

    for (const batch of batches) {
      if (batch.ranges.length === 0) continue;
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

      entry.material.uniforms.uOpacity.value = opacityOf(batch.layerId);
    }

    for (const [key, entry] of [...this.entries]) {
      if (live.has(key)) continue;
      this.destroyEntry(entry);
      this.entries.delete(key);
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

    for (const entry of this.entries.values()) {
      const u = entry.material.uniforms;
      (u.uViewProjection.value as THREE.Matrix4).copy(this.mat);
      (u.uCameraPos.value as THREE.Vector3).set(eye.x, eye.y, eye.z);
    }

    renderer.render(this.scene, this.dummy);
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
    return { drawCalls: this.entries.size, instances, bytes };
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
    this.renderer?.dispose();
    this.renderer = null;
    this.available = false;
  }

  private destroyEntry(entry: BatchEntry): void {
    this.scene.remove(entry.mesh);
    disposeRibbon(entry.ribbon);
    entry.material.dispose();
  }

  private readonly vpScratch = new Float32Array(16);
  private readonly eyeScratch = { x: 0, y: 0, z: 0 };
  private readonly fwdScratch = { x: 0, y: 0, z: 0 };
}
