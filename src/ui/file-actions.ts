import type { Editor } from "../app/editor";
import { DEFAULT_EXPORT, download, exportPng, exportSvg, timestampName, type ExportOptions } from "../io/export";
import type { Loading } from "./busy";
import {
  canPickFiles,
  ensureWritePermission,
  forgetFile,
  pickProjectFile,
  pickSaveTarget,
  readFileText,
  recallFile,
  rememberFile,
  writeText,
  type BoundFile,
  type PickedProject,
} from "../io/file-handle";
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
 *
 * Guardar tiene dos caminos. Donde el navegador deja elegir un archivo y escribir
 * en el (Chrome, Edge, la app instalada), el documento queda vinculado a ese
 * archivo y cada guardado posterior escribe encima, sin dialogo y sin copias: es el
 * comportamiento de Photopea. Donde no (Firefox, Safari), se descarga una copia
 * nueva, que es lo unico que se puede hacer. El resto de este archivo es el mismo
 * en ambos casos.
 */

/** El archivo local al que esta vinculado el documento, si lo esta. */
let bound: BoundFile | null = null;

export function projectText(editor: Editor): string {
  return serializeProject({
    doc: editor.doc,
    brush: editor.brush,
    camera: editor.camera.state,
  });
}

/** Serializa el proyecto, con la acuarela viva ya pasada a raster. */
function bakedText(editor: Editor): string {
  // La acuarela viva está en la GPU y en coordenadas de pantalla: antes de
  // serializar se hornea a un ráster de mundo, que es lo que sabe viajar en el
  // archivo. Si no, el .drawi saldría sin ella.
  editor.bakeAllAquaLayers();
  return projectText(editor);
}

/**
 * Guarda el proyecto.
 *
 * Con un archivo vinculado, escribe encima de él: eso es todo el sentido de esto.
 * Sin él, o sin la API del navegador, pasa por `saveProjectAs`.
 */
export async function saveProject(editor: Editor): Promise<string> {
  // Sin la API no hay archivo que recordar: se descarga, como antes.
  if (!canPickFiles()) return downloadProject(editor);

  if (bound) {
    const target = bound;
    // El permiso se comprueba ANTES de hornear y de serializar. El navegador solo
    // deja pedirlo dentro del gesto que lo desencadenó -una tecla, un clic- y esa
    // activación caduca a los pocos segundos, mientras que hornear la acuarela y
    // serializar un proyecto grande pueden tardar más que eso.
    if (await ensureWritePermission(target.handle, true)) {
      try {
        await writeText(target.handle, bakedText(editor));
        return `Guardado en ${target.name}`;
      } catch (err) {
        // El archivo ya no está donde estaba (lo movieron o lo borraron por
        // fuera): el vínculo caduca y se ofrece elegir destino otra vez.
        unbind();
        return saveProjectAs(editor, `No se pudo escribir en ${target.name}: ${describe(err)}`);
      }
    }
    // Permiso denegado: se olvida el vínculo antes que insistir con él.
    unbind();
  }
  return saveProjectAs(editor);
}

/**
 * Guarda pidiendo destino, y vincula el documento al archivo elegido.
 *
 * `notice` es el aviso que explica por qué se está preguntando (se perdió el
 * permiso, el archivo ya no está...). Va delante del resultado para que la barra de
 * estado cuente la historia entera y no solo el final.
 */
export async function saveProjectAs(editor: Editor, notice?: string): Promise<string> {
  // El diálogo se abre ANTES de hornear y de serializar, por lo mismo que en
  // `saveProject`: el navegador exige activación transitoria para abrirlo y
  // después de un horneado largo ya no la habría.
  if (!canPickFiles()) return downloadProject(editor, notice);

  const suggested = `${sanitize(editor.doc.meta.name)}.drawi`;
  let handle: FileSystemFileHandle | null;
  try {
    handle = await pickSaveTarget(suggested);
  } catch (err) {
    return `${prefix(notice)}No se pudo elegir el archivo: ${describe(err)}`;
  }
  if (!handle) return `${prefix(notice)}Guardado cancelado`;

  try {
    await writeText(handle, bakedText(editor));
  } catch (err) {
    return `${prefix(notice)}No se pudo escribir ${handle.name}: ${describe(err)}`;
  }
  bind(editor, handle, true);
  return `Guardado en ${handle.name}`;
}

/**
 * Abre un proyecto.
 *
 * `loading` se avisa en cuanto el archivo está elegido y hasta que termina de
 * aplicarse: ese es el rato en el que la app trabaja y no atiende. Mientras el
 * diálogo nativo está abierto no se avisa, porque ahí manda el sistema y la app no
 * está haciendo nada; tapar la pantalla mientras alguien busca su archivo sería
 * ruido, no información.
 */
export async function openProject(editor: Editor, loading?: Loading): Promise<string> {
  if (canPickFiles()) {
    let picked: PickedProject | null;
    try {
      picked = await pickProjectFile();
    } catch (err) {
      return `No se pudo abrir: ${describe(err)}`;
    }
    if (!picked) return "Apertura cancelada";
    return applyWithLoading(editor, picked.text, picked.handle, loading);
  }
  const picked = await pickFile(".drawi,application/json");
  if (!picked) return "Apertura cancelada";
  return applyWithLoading(editor, picked.text, null, loading);
}

/**
 * Abre el archivo con el que el sistema ha lanzado la app.
 *
 * Es el doble clic sobre un `.drawi` en el explorador, en la app instalada. El
 * handle viene dado por el navegador, así que además queda vinculado y el primer
 * Ctrl+S escribe encima.
 */
export async function openHandle(
  editor: Editor,
  handle: FileSystemFileHandle,
  loading?: Loading,
): Promise<string> {
  try {
    if (loading) await loading.begin(`Abriendo ${handle.name}`);
    return applyOpened(editor, await readFileText(handle), handle);
  } catch (err) {
    return `No se pudo abrir ${handle.name}: ${describe(err)}`;
  } finally {
    loading?.end();
  }
}

/**
 * Reengancha el archivo de la sesión anterior.
 *
 * Solo si el autoguardado restaurado es del MISMO trabajo: se compara el nombre que
 * tenía el documento al vincularse con el que trae el autoguardado. Sin esa guarda,
 * abrir la app con un dibujo suelto y pulsar Ctrl+S escribiría encima del último
 * archivo guardado, que es justo lo que no se puede permitir.
 *
 * No pide permiso: al recargar, el navegador lo deja en "preguntar", y pedirlo sin
 * que nadie haya pedido guardar sería un diálogo caído del cielo. Se pedirá —una
 * vez— en el primer guardado de verdad.
 */
export async function reattachLastFile(editor: Editor): Promise<string | null> {
  const last = await recallFile();
  if (!last || last.docName !== editor.doc.meta.name) return null;
  bound = last;
  return last.name;
}

/**
 * Aplica el proyecto elegido, tapando la app mientras lo hace.
 *
 * `await` al aviso antes de aplicarlo no es ceremonia: aplicar un proyecto es
 * sincrónico y no suelta el hilo, así que el velo tiene que estar pintado ANTES de
 * empezar o no se vería nunca.
 */
async function applyWithLoading(
  editor: Editor,
  text: string,
  handle: FileSystemFileHandle | null,
  loading?: Loading,
): Promise<string> {
  if (!loading) return applyOpened(editor, text, handle);
  await loading.begin(handle ? `Abriendo ${handle.name}` : "Abriendo proyecto");
  try {
    return applyOpened(editor, text, handle);
  } finally {
    loading.end();
  }
}

/**
 * Aplica un proyecto ya leído.
 *
 * Extraída para que abrir con el selector, abrir con el `<input type=file>` de
 * siempre y abrir desde el explorador hagan exactamente lo mismo: la única
 * diferencia es si el navegador entregó un archivo al que poder volver a escribir.
 */
function applyOpened(
  editor: Editor,
  text: string,
  handle: FileSystemFileHandle | null,
): string {
  try {
    const file = parseProject(text);
    applyProject(editor.doc, file);
    editor.brush = { ...editor.brush, ...file.brush };
    editor.camera.state = file.camera;
    editor.history.clear();
    editor.reload();
    if (handle) bind(editor, handle, false);
    else unbind();
    return `Abierto: ${file.name}`;
  } catch (err) {
    return `No se pudo abrir: ${describe(err)}`;
  }
}

/**
 * Ata el documento al archivo elegido y lo recuerda para la próxima sesión.
 *
 * Con `rename`, el documento adopta el nombre del archivo —como al "Guardar como"
 * de Photoshop— para que la barra superior diga dónde se está guardando. Al abrir
 * no: ahí manda el nombre que trae el propio proyecto.
 *
 * `setName` y `reload` emiten "dirty", así que el vínculo se registra DESPUÉS de
 * ellos: quien llama a esto es quien sabe que el guardado acaba de terminar.
 */
function bind(editor: Editor, handle: FileSystemFileHandle, rename: boolean): void {
  if (rename) editor.setName(baseName(handle.name));
  const file: BoundFile = { handle, name: handle.name, docName: editor.doc.meta.name };
  bound = file;
  void rememberFile(file);
}

/** Suelta el vínculo: el documento deja de tener archivo en disco. */
function unbind(): void {
  bound = null;
  void forgetFile();
}

/**
 * El camino de siempre: serializar y descargar.
 *
 * Es el que usan los navegadores sin la API (Firefox, Safari) y el que seguirán
 * usando: descarga una copia nueva cada vez, porque el navegador no deja escribir
 * sobre un archivo del disco sin pasar por un selector.
 */
function downloadProject(editor: Editor, notice?: string): string {
  const name = sanitize(editor.doc.meta.name);
  download(bakedText(editor), `${name}.drawi`, "application/json");
  return `${prefix(notice)}Proyecto guardado como ${name}.drawi`;
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
  // Un lienzo nuevo no hereda el archivo del anterior: si no, el primer Ctrl+S
  // escribiría el dibujo nuevo encima del que se estaba editando.
  unbind();
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

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const prefix = (notice?: string): string => (notice ? `${notice}. ` : "");

/** `dibujo.drawi` → `dibujo`. */
const baseName = (file: string): string => file.replace(/\.[^.]+$/, "") || file;

const sanitize = (name: string): string =>
  name
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "zence-draw";
