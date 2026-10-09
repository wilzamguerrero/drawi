import type { Editor } from "../app/editor";
import { DEFAULT_EXPORT, download, exportPng, exportSvg, timestampName, type ExportOptions } from "../io/export";
import {
  applyProject,
  clearLocal,
  loadLocal,
  parseProject,
  pickFile,
  saveLocalLossy,
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
  // La acuarela viva está en la GPU y en coordenadas de pantalla: antes de
  // serializar se hornea a un ráster de mundo, que es lo que sabe viajar en el
  // archivo. Si no, el .drawi saldría sin ella.
  editor.bakeAllAquaLayers();
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
  // Igual que al guardar: el PNG se rasteriza en coordenadas de mundo, así que
  // la acuarela tiene que estar horneada para poder aparecer en él.
  editor.bakeAllAquaLayers();
  const blob = await exportPng(editor.doc, opt);
  const name = timestampName(sanitize(editor.doc.meta.name), "png");
  download(blob, name, "image/png");
  return `PNG exportado (x${opt.scale})`;
}

export function exportVector(editor: Editor, options: Partial<ExportOptions> = {}): string {
  const svg = exportSvg(editor.doc, options);
  const name = timestampName(sanitize(editor.doc.meta.name), "svg");
  download(svg, name, "image/svg+xml");
  // El SVG es vectorial puro: la acuarela es un ráster de fluido y no tiene
  // representación en trazos, así que se queda fuera a propósito.
  return editor.doc.aquaLayers.length > 0
    ? "SVG exportado (sin la acuarela: es un ráster)"
    : "SVG exportado";
}

export function newDocument(editor: Editor): string {
  editor.clearAll();
  // Restablece la estructura de capas: una sola de tinta y ninguna de materia
  // (esta última nace al crear el primer cuerpo), sin arrastrar las del anterior.
  editor.doc.resetLayers();
  editor.setName("Sin titulo");
  editor.resetView();
  editor.history.clear();
  clearLocal();
  editor.reload();
  return "Lienzo nuevo";
}

/**
 * Vuelca el autoguardado al almacenamiento local.
 *
 * A diferencia del guardado explícito, aquí NO se hornea la acuarela: pasar el
 * fluido a PNG cuesta décimas de segundo y el autoguardado salta cada vez que
 * se suelta el pincel. Lo que sí viaja es lo que ya estuviera horneado, y si no
 * cabe en el cupo se recorta antes que perder el autoguardado entero.
 */
export function autosave(editor: Editor): void {
  saveLocalLossy(projectText(editor));
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
    // Un autoguardado vacío no se restaura (no merece pisar el lienzo nuevo).
    // La acuarela horneada cuenta como contenido: un dibujo que solo es acuarela
    // no es un dibujo vacío.
    const hasAqua = (file.layers ?? []).some((l) => l.kind === "aqua" && l.aquaBaked);
    if (file.items.length === 0 && file.bodies.length === 0 && !hasAqua) return false;
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
    .slice(0, 48) || "zence-draw";
