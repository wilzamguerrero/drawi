import type { SceneDocument } from "../scene/document";
import { snapshotBody, restoreBody, type BodySnapshot } from "../scene/document";
import type { InkItem } from "../scene/types";
import type { SceneLayer } from "../scene/layer";
import { normalizeSymmetry as normalizeSymmetryState, type SymmetryState } from "../symmetry/symmetry";
import { DEFAULT_WORLD, type WorldSettings } from "../physics/world";
import { DEFAULT_FIELD_STYLE, type FieldStyle } from "../render/field-gl";
import type { BrushSettings } from "../stroke/types";
import type { ShapeDef } from "../physics/shapes";
import { DEFAULT_CAMERA_3D, type Camera3DState } from "../scene3d/camera3d";
import { outlineBounds, type Fill3D } from "../scene3d/fill";
import type { V3 } from "../scene3d/vec3";
import { POINT_FLOATS, boundsOf, type Stroke3D } from "../scene3d/types";

/**
 * v1: tinta plana sin capas. v2: modelo de capas (`layers` + `activeLayerId`);
 * los `items` siguen planos, ahora cada uno con su `layerId`. v3: la materia
 * deja de ser una pseudo-capa única: cada cuerpo lleva `layerId` y puede haber
 * varias capas de materia (o ninguna). v4: alcance de cohesion configurable.
 * v6: capas de acuarela (`kind: "aqua"`), que viajan dentro de `layers` con su
 * pigmento ya horneado en `aquaBaked` (PNG) y el rectángulo de mundo que ocupa.
 * v7: capas del espacio (`kind: "scene3d"`) con sus trazos en `strokes3d` y sus
 * manchas rellenas en `fills3d`, mas el punto de vista del visor en `camera3d`.
 */
export const PROJECT_VERSION = 7;

export interface ProjectFile {
  format: "drawi";
  version: number;
  name: string;
  background: string;
  items: InkItem[];
  /** Capas (v2+). Ausente en proyectos v1: se migran al abrir. */
  layers?: SceneLayer[];
  activeLayerId?: string;
  /** Trazos del espacio (v7+). Ausente en proyectos anteriores. */
  strokes3d?: Stroke3DFile[];
  /** Manchas rellenas del espacio (v7+). */
  fills3d?: Fill3DFile[];
  /** Punto de vista del visor espacial (v7+). */
  camera3d?: Camera3DState;
  bodies: BodySnapshot[];
  symmetry: SymmetryState;
  world: WorldSettings;
  field: FieldStyle;
  brush: BrushSettings;
  shape: ShapeDef;
  camera: { x: number; y: number; zoom: number; rotation: number };
}

export interface SerializeInput {
  doc: SceneDocument;
  brush: BrushSettings;
  camera: { x: number; y: number; zoom: number; rotation: number };
}

// ------------------------------------------------------------ trazos 3D --

/**
 * Un trazo del espacio tal como viaja en el archivo.
 *
 * `data` va en base64 y no como lista de numeros: son 36 bytes por punto, que
 * escritos de la forma obvia ocupan unos 250 caracteres cada uno. Un trazo de mil
 * puntos pasa de 36 kB a 250 kB solo por escribirlos asi.
 */
export interface Stroke3DFile {
  id: string;
  brush: string;
  color: string;
  layerId: string;
  count: number;
  seed: number;
  /** `count * POINT_FLOATS` floats en base64, 4 bytes cada uno. */
  data: string;
  /** Normal del plano de dibujo (v7+). Ausente si el trazo se hizo en el aire. */
  planeNormal?: V3 | null;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Tabla inversa, construida una vez. */
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/**
 * Base64 propio, y no `btoa`/`atob`, por dos motivos.
 *
 * `btoa` no existe fuera del navegador -y las pruebas de interfaz corren en
 * Node-, y el atajo de siempre, `String.fromCharCode(...bytes)`, revienta el
 * limite de argumentos en cuanto el trazo pasa de unos miles de puntos. Esto no
 * depende del entorno y no tiene tope.
 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(n >> 18) & 63] +
      B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] +
      B64_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64_ALPHABET[(n >> 18) & 63] +
      B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] +
      "=";
  }
  return out;
};

export const base64ToBytes = (text: string): Uint8Array => {
  // El relleno no aporta bits: se descuenta y el ultimo byte sale solo.
  let len = text.length;
  while (len > 0 && text.charCodeAt(len - 1) === 61) len--;

  const out = new Uint8Array((len * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) throw new Error("El trazo del espacio viene con datos corruptos");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
};

export const encodeStroke3D = (s: Stroke3D): Stroke3DFile => {
  const floats = s.data.subarray(0, s.count * POINT_FLOATS);
  return {
    id: s.id,
    brush: s.brush,
    color: s.color,
    layerId: s.layerId,
    count: s.count,
    seed: s.seed,
    planeNormal: s.planeNormal ? { ...s.planeNormal } : null,
    data: bytesToBase64(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength)),
  };
};

/**
 * Una mancha rellena tal como viaja en el archivo.
 *
 * Solo se guarda su CONTORNO: los triangulos son geometria derivada y se
 * reconstruyen al abrir, igual que los segmentos de un trazo se reconstruyen de
 * sus puntos. Guardarlos seria una segunda fuente de verdad que se desvia en
 * cuanto se toque el algoritmo de triangulacion.
 */
export interface Fill3DFile {
  id: string;
  color: string;
  layerId: string;
  count: number;
  /** `count * 3` floats en base64: el contorno cerrado. */
  outline: string;
  planeNormal?: V3 | null;
}

export const encodeFill3D = (f: Fill3D): Fill3DFile => {
  const floats = f.outline.subarray(0, f.count * 3);
  return {
    id: f.id,
    color: f.color,
    layerId: f.layerId,
    count: f.count,
    planeNormal: f.planeNormal ? { ...f.planeNormal } : null,
    outline: bytesToBase64(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength)),
  };
};

export const decodeFill3D = (f: Fill3DFile): Fill3D => {
  const count = Math.max(0, Math.floor(f.count));
  const outline = new Float32Array(count * 3);
  new Uint8Array(outline.buffer).set(base64ToBytes(f.outline).subarray(0, outline.byteLength));
  return {
    id: f.id,
    color: f.color,
    layerId: f.layerId,
    outline,
    count,
    bounds: outlineBounds(outline, count),
    planeNormal: f.planeNormal ? { ...f.planeNormal } : null,
  };
};

export const decodeStroke3D = (f: Stroke3DFile): Stroke3D => {
  const count = Math.max(0, Math.floor(f.count));
  // El array se copia a uno nuevo en vez de verse sobre los bytes decodificados:
  // `Float32Array` exige un desplazamiento multiplo de 4 y aqui no hay forma de
  // garantizarlo sin depender de como reserve el motor.
  const data = new Float32Array(count * POINT_FLOATS);
  new Uint8Array(data.buffer).set(base64ToBytes(f.data).subarray(0, data.byteLength));
  return {
    id: f.id,
    brush: f.brush,
    color: f.color,
    layerId: f.layerId,
    data,
    count,
    // La caja envolvente es derivada: se recalcula en vez de guardarla, para no
    // tener una segunda fuente de verdad que pueda desviarse de los puntos.
    bounds: boundsOf(data, count),
    seed: f.seed,
    planeNormal: f.planeNormal ? { ...f.planeNormal } : null,
  };
};

/**
 * Proyecto en JSON.
 *
 * Se guarda la geometria vectorial, no un bitmap: el archivo se reabre con la
 * misma nitidez a cualquier zoom, la materia vuelve exactamente donde estaba
 * (posicion, angulo y velocidad) y el historial puede seguir desde ahi.
 */
export function serializeProject({ doc, brush, camera }: SerializeInput): string {
  const file: ProjectFile = {
    format: "drawi",
    version: PROJECT_VERSION,
    name: doc.meta.name,
    background: doc.meta.background,
    items: doc.items,
    layers: doc.layers,
    activeLayerId: doc.activeLayerId,
    strokes3d: doc.strokes3d.map(encodeStroke3D),
    fills3d: doc.fills3d.map(encodeFill3D),
    camera3d: { ...doc.camera3d },
    bodies: doc.bodies.map(snapshotBody),
    symmetry: { ...doc.symmetry },
    world: { ...doc.physics.settings, gravity: { ...doc.physics.settings.gravity } },
    field: { ...doc.field },
    brush: { ...brush },
    shape: { ...doc.shape },
    camera: { ...camera },
  };
  return JSON.stringify(file);
}

export function parseProject(text: string): ProjectFile {
  const data = JSON.parse(text) as Partial<ProjectFile>;
  if (data.format !== "drawi") throw new Error("El archivo no es un proyecto de drawi");
  if (typeof data.version !== "number" || data.version > PROJECT_VERSION) {
    throw new Error("El proyecto viene de una version mas nueva");
  }
  if (!Array.isArray(data.items) || !Array.isArray(data.bodies)) {
    throw new Error("El proyecto esta incompleto");
  }
  return data as ProjectFile;
}

export function applyProject(doc: SceneDocument, file: ProjectFile): void {
  doc.meta.name = file.name;
  doc.meta.background = file.background;
  doc.items = (file.items as InkItem[]).slice();
  doc.symmetry = normalizeSymmetryState(file.symmetry as Partial<SymmetryState>);
  // Merge con los defaults: un proyecto anterior a un campo nuevo no debe
  // recibirlo como `undefined` (rompería el control y el render).
  doc.physics.settings = { ...DEFAULT_WORLD, ...file.world, gravity: { ...file.world.gravity } };
  doc.field = { ...DEFAULT_FIELD_STYLE, ...file.field };
  doc.shape = { ...file.shape };
  // Los trazos del espacio se cargan ANTES de `ensureLayers`, para que se ocupe
  // de los que apunten a una capa que ya no existe. Los proyectos anteriores a
  // v7 no traen ninguno y se quedan con la lista vacia.
  doc.strokes3d = Array.isArray(file.strokes3d) ? file.strokes3d.map(decodeStroke3D) : [];
  doc.fills3d = Array.isArray(file.fills3d) ? file.fills3d.map(decodeFill3D) : [];
  doc.camera3d = { ...DEFAULT_CAMERA_3D, ...(file.camera3d ?? {}) };
  // Los cuerpos entran primero para que `ensureLayers` sepa a qué capa de
  // materia reasignar los que vengan sin `layerId` (proyectos v1/v2).
  doc.physics.clear();
  for (const b of file.bodies) doc.physics.add(restoreBody(b));

  if (Array.isArray(file.layers) && file.layers.length > 0) {
    // Proyecto v2+: capas explícitas. `ensureLayers` repara cualquier hueco
    // (item huérfano, activeLayerId inválido, cuerpo sin capa de materia).
    doc.layers = file.layers;
    doc.activeLayerId = file.activeLayerId ?? "";
    doc.ensureLayers();
  } else {
    // Proyecto v1: tinta plana. Envolverla en una capa por defecto; los cuerpos
    // caen en una capa de materia que crea `ensureLayers`.
    doc.migrateFlatItems();
    doc.ensureLayers();
  }

  // Legado (<v3): el modelo antiguo forzaba una capa de materia aunque no
  // hubiera cuerpos. Se elimina si quedó vacía, para no mostrar una fila que el
  // usuario no creó. Los proyectos v3 conservan las capas tal cual.
  if ((file.version ?? 0) < 3) doc.dropEmptyMatterLayers();

  doc.inkRevision++;
}

/** Abre un selector de archivo y devuelve el texto elegido. */
export function pickFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result ?? "") });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    // Safari necesita el input en el documento para disparar el dialogo.
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 0);
  });
}

const STORAGE_KEY = "drawi:autosave";

export function saveLocal(payload: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // Cuota llena o almacenamiento bloqueado: el autoguardado es opcional.
  }
}

/**
 * Autoguardado con plan B: si el proyecto no cabe, se reintenta sin los rásteres
 * de acuarela.
 *
 * Una capa de acuarela horneada es un PNG en base64 y puede ocupar megas; el
 * cupo de `localStorage` ronda los 5 MB. Antes que perder el autoguardado
 * entero se sacrifica la acuarela, que es justo lo que menos duele: el trazo
 * vectorial es lo que no se puede reconstruir.
 */
export function saveLocalLossy(payload: string): "full" | "trimmed" | "failed" {
  try {
    localStorage.setItem(STORAGE_KEY, payload);
    return "full";
  } catch {
    // Sigue abajo.
  }
  try {
    const data = JSON.parse(payload) as ProjectFile;
    for (const l of data.layers ?? []) {
      if (l.kind !== "aqua") continue;
      delete l.aquaBaked;
      delete l.aquaRect;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return "trimmed";
  } catch {
    return "failed";
  }
}

export function loadLocal(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearLocal(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignorado a proposito.
  }
}
