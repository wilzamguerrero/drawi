import type { SceneDocument } from "../scene/document";
import { snapshotBody, restoreBody, type BodySnapshot } from "../scene/document";
import type { InkItem } from "../scene/types";
import type { SymmetryState } from "../symmetry/symmetry";
import type { WorldSettings } from "../physics/world";
import type { FieldStyle } from "../render/field-gl";
import type { BrushSettings } from "../stroke/types";
import type { ShapeDef } from "../physics/shapes";

export const PROJECT_VERSION = 1;

export interface ProjectFile {
  format: "drawi";
  version: number;
  name: string;
  background: string;
  items: InkItem[];
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
  doc.items = file.items;
  doc.symmetry = { ...file.symmetry };
  doc.physics.settings = { ...file.world, gravity: { ...file.world.gravity } };
  doc.field = { ...file.field };
  doc.shape = { ...file.shape };
  doc.physics.clear();
  for (const b of file.bodies) doc.physics.add(restoreBody(b));
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
