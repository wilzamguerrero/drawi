import type { SceneDocument } from "../scene/document";
import { snapshotBody, restoreBody, type BodySnapshot } from "../scene/document";
import type { InkItem } from "../scene/types";
import type { SceneLayer } from "../scene/layer";
import { normalizeSymmetry as normalizeSymmetryState, type SymmetryState } from "../symmetry/symmetry";
import { DEFAULT_WORLD, type WorldSettings } from "../physics/world";
import { DEFAULT_FIELD_STYLE, type FieldStyle } from "../render/field-gl";
import type { BrushSettings } from "../stroke/types";
import type { ShapeDef } from "../physics/shapes";

/**
 * v1: tinta plana sin capas. v2: modelo de capas (`layers` + `activeLayerId`);
 * los `items` siguen planos, ahora cada uno con su `layerId`. v3: la materia
 * deja de ser una pseudo-capa única: cada cuerpo lleva `layerId` y puede haber
 * varias capas de materia (o ninguna). v4: alcance de cohesion configurable.
 * v6: capas de acuarela (`kind: "aqua"`), que viajan dentro de `layers` con su
 * pigmento ya horneado en `aquaBaked` (PNG) y el rectángulo de mundo que ocupa.
 */
export const PROJECT_VERSION = 6;

export interface ProjectFile {
  format: "drawi";
  version: number;
  name: string;
  background: string;
  items: InkItem[];
  /** Capas (v2+). Ausente en proyectos v1: se migran al abrir. */
  layers?: SceneLayer[];
  activeLayerId?: string;
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
