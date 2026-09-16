import type { Editor } from "../app/editor";
import { DEFAULT_EXPORT, download, exportPng, exportSvg, timestampName, type ExportOptions } from "../io/export";
import {
  applyProject,
  clearLocal,
  loadLocal,
  parseProject,
  pickFile,
  saveLocal,
  serializeProject,
} from "../io/project";

/**
 * Acciones de archivo.
 *
 * Toda la entrada/salida vive aqui y no en los componentes: la barra superior
 * solo dice "guardar" y el editor no sabe que existen los archivos. Cada accion
 * devuelve texto de estado para que la barra inferior informe sin inventarse
 * mensajes propios.
 */

export function projectText(editor: Editor): string {
  return serializeProject({
    doc: editor.doc,
    brush: editor.brush,
    camera: editor.camera.state,
  });
}

export function saveProject(editor: Editor): string {
  const name = sanitize(editor.doc.meta.name);
  download(projectText(editor), `${name}.drawi`, "application/json");
  return `Proyecto guardado como ${name}.drawi`;
}

export async function openProject(editor: Editor): Promise<string> {
  const picked = await pickFile(".drawi,application/json");
  if (!picked) return "Apertura cancelada";
  try {
    const file = parseProject(picked.text);
    applyProject(editor.doc, file);
    editor.brush = { ...editor.brush, ...file.brush };
    editor.camera.state = file.camera;
    editor.history.clear();
    editor.reload();
    return `Abierto: ${file.name}`;
  } catch (err) {
    return `No se pudo abrir: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function exportImage(
  editor: Editor,
  options: Partial<ExportOptions> = {},
): Promise<string> {
  const opt = { ...DEFAULT_EXPORT, ...options };
  const blob = await exportPng(editor.doc, opt);
  const name = timestampName(sanitize(editor.doc.meta.name), "png");
  download(blob, name, "image/png");
  return `PNG exportado (x${opt.scale})`;
}

export function exportVector(editor: Editor, options: Partial<ExportOptions> = {}): string {
  const svg = exportSvg(editor.doc, options);
  const name = timestampName(sanitize(editor.doc.meta.name), "svg");
  download(svg, name, "image/svg+xml");
  return "SVG exportado";
}

export function newDocument(editor: Editor): string {
  editor.clearAll();
  editor.setName("Sin titulo");
  editor.resetView();
  editor.history.clear();
  clearLocal();
  editor.reload();
  return "Lienzo nuevo";
}

/** Vuelca el autoguardado al almacenamiento local. */
export function autosave(editor: Editor): void {
  saveLocal(projectText(editor));
}

/**
 * Restaura el autoguardado al arrancar.
 *
 * Un fallo aqui no puede impedir que la app abra: si el JSON quedo a medias por
 * un cierre brusco, se descarta y se empieza en limpio.
 */
export function restoreAutosave(editor: Editor): boolean {
  const text = loadLocal();
  if (!text) return false;
  try {
    const file = parseProject(text);
    if (file.items.length === 0 && file.bodies.length === 0) return false;
    applyProject(editor.doc, file);
    editor.brush = { ...editor.brush, ...file.brush };
    editor.camera.state = file.camera;
    editor.reload();
    return true;
  } catch {
    clearLocal();
    return false;
  }
}

const sanitize = (name: string): string =>
  name
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "drawi";
