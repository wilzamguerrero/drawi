/**
 * Archivo local vinculado: elegir, escribir encima y recordarlo.
 *
 * Hasta ahora guardar era descargar: se creaba un Blob, un `<a download>` y el
 * navegador dejaba `dibujo.drawi`, luego `dibujo (1).drawi`, `dibujo (2).drawi`...
 * El archivo del disco nunca se actualizaba, porque un `<input type=file>` solo
 * sabe leer. La File System Access API resuelve eso: el navegador entrega un
 * `FileSystemFileHandle` que se puede volver a escribir cuando haga falta, sin
 * dialogo y sin copias. Es lo que hace Photopea, y es lo que hace que la app
 * instalada se sienta como un programa de escritorio.
 *
 * Aqui vive SOLO el trato con esa API y con IndexedDB. El formato del proyecto y
 * el editor no aparecen por ningun lado: de eso se ocupa `file-actions`.
 *
 * Nada de este modulo toca `window` ni `indexedDB` al importarse -todo esta dentro
 * de funciones, con salida temprana si no existen-, porque las pruebas de humo
 * corren en Node, donde no hay ni lo uno ni lo otro. Tampoco se declaran dobles de
 * la API en el DOM simulado, a proposito: asi las pruebas ejercitan el camino de
 * descarga, que es el unico que existe en los navegadores sin ella.
 */

/* ------------------------------------------------------------------- tipos

   `lib.dom` todavia no declara los selectores nativos ni los metodos de permiso de
   `FileSystemHandle` (si declara `createWritable` y `getFile`, que es lo que de
   verdad se usa para escribir). Se declaran aqui, y solo aqui, en vez de repartir
   un `.d.ts` suelto por el proyecto. */

/** Un tipo aceptado en el dialogo: descripcion + extensiones agrupadas por MIME. */
export interface PickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

export interface PickerOptions {
  suggestedName?: string;
  types?: PickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
  id?: string;
}

export type PermissionState3 = "granted" | "denied" | "prompt";

/** Los dos metodos de permiso. Opcionales: no todos los motores los traen. */
interface Permissions {
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState3>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState3>;
}

/** Lo que el sistema entrega al abrir la app con un archivo (`file_handlers`). */
interface LaunchParams {
  files?: FileSystemFileHandle[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: PickerOptions) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (options?: PickerOptions) => Promise<FileSystemFileHandle[]>;
    launchQueue?: LaunchQueue;
  }
}

/** El tipo que se ofrece en los dialogos: el proyecto de drawi. */
export const DRAW_TYPE: PickerAcceptType = {
  description: "Proyecto Zence Draw",
  accept: { "application/json": [".drawi"] },
};

/* ---------------------------------------------------------------- capacidad */

/**
 * ¿El navegador sabe elegir un archivo y escribir en el?
 *
 * Se pregunta por la capacidad, nunca por el navegador: Chrome y Edge la tienen y
 * Firefox y Safari no, pero eso cambia de una version a otra y una lista de nombres
 * se queda vieja sin avisar.
 */
export function canPickFiles(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showSaveFilePicker === "function" &&
    typeof window.showOpenFilePicker === "function"
  );
}

/** Cancelar el dialogo no es un fallo: es una decision del usuario. */
const isAbort = (err: unknown): boolean =>
  (err as { name?: string } | null)?.name === "AbortError";

/**
 * Pide destino para guardar y devuelve el archivo elegido, o `null` si se cancela.
 *
 * Quien llame a esto tiene que hacerlo DENTRO del gesto del usuario (un clic, una
 * tecla): el navegador exige activacion transitoria para abrir el dialogo y la
 * caduca a los pocos segundos, asi que no se puede hornear ni serializar antes.
 */
export async function pickSaveTarget(
  suggestedName: string,
): Promise<FileSystemFileHandle | null> {
  const pick = typeof window !== "undefined" ? window.showSaveFilePicker : undefined;
  if (typeof pick !== "function") return null;
  try {
    // `call(window, ...)`: los selectores son metodos del objeto global, y sueltos
    // de el lanzan "Illegal invocation".
    return await pick.call(window, { suggestedName, types: [DRAW_TYPE] });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/** Un proyecto elegido en disco, ya leido. */
export interface PickedProject {
  handle: FileSystemFileHandle;
  name: string;
  text: string;
}

/** Pide un proyecto y lo lee. `null` si se cancela. */
export async function pickProjectFile(): Promise<PickedProject | null> {
  const pick = typeof window !== "undefined" ? window.showOpenFilePicker : undefined;
  if (typeof pick !== "function") return null;
  let handle: FileSystemFileHandle | undefined;
  try {
    const handles = await pick.call(window, { types: [DRAW_TYPE], multiple: false });
    handle = handles[0];
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
  if (!handle) return null;
  return { handle, name: handle.name, text: await readFileText(handle) };
}

/* -------------------------------------------------------- lectura y escritura */

/** Lee el contenido de un archivo ya elegido. */
export async function readFileText(handle: FileSystemFileHandle): Promise<string> {
  return await (await handle.getFile()).text();
}

/**
 * Escribe el texto ENCIMA del archivo.
 *
 * `createWritable` trabaja sobre un archivo temporal y solo lo pone en su sitio al
 * cerrar, asi que un fallo a mitad deja el original intacto. De ahi el `abort()`
 * explicito -abandonar el flujo sin cerrarlo deja el archivo bloqueado- y de ahi
 * que el error se propague en vez de tragarse: quien guarda decide si eso significa
 * perder el vinculo.
 */
export async function writeText(handle: FileSystemFileHandle, text: string): Promise<void> {
  const stream = await handle.createWritable();
  try {
    await stream.write(text);
  } catch (err) {
    try {
      await stream.abort();
    } catch {
      // Si abortar tambien falla no hay nada mas que hacer: manda el error original.
    }
    throw err;
  }
  await stream.close();
}

interface HandleWithPermissions extends Permissions, FileSystemFileHandle {}

/**
 * ¿Se puede escribir en el archivo? Con `request`, ademas se le pregunta al usuario.
 *
 * `request` solo debe llegar en `true` desde un gesto explicito de guardar. Al
 * recargar la pagina el permiso vuelve a "prompt", y pedirlo sin que nadie lo haya
 * pedido seria un dialogo caido del cielo; consultar, en cambio, no molesta a nadie.
 *
 * Un motor sin estos metodos -o un handle que no venga de un selector- se da por
 * permitido: es lo que hacia la app antes de existir todo esto, y negarse aqui
 * romperia el guardado en sitios donde escribir si funciona.
 */
export async function ensureWritePermission(
  handle: FileSystemFileHandle,
  request: boolean,
): Promise<boolean> {
  const h = handle as HandleWithPermissions;
  if (typeof h.queryPermission !== "function") return true;
  try {
    if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
    if (!request || typeof h.requestPermission !== "function") return false;
    return (await h.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- memoria del archivo

   Un `FileSystemFileHandle` se puede guardar tal cual en IndexedDB -el navegador lo
   serializa-, asi que el vinculo sobrevive a recargar la pestana y a cerrar la app
   instalada. `localStorage` no sirve: solo guarda cadenas.

   Todo esto es opcional por definicion. Si no hay IndexedDB (las pruebas corren en
   Node) o el navegador lo bloquea, se sigue guardando igual, solo que habra que
   elegir el archivo otra vez tras recargar. */

const DB_NAME = "drawi";
const DB_VERSION = 1;
const STORE = "handles";
const KEY = "project";

export interface BoundFile {
  handle: FileSystemFileHandle;
  /** Nombre del archivo en disco (`dibujo.drawi`). */
  name: string;
  /** Nombre del documento al vincularlo: distingue "es el mismo trabajo". */
  docName: string;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    // Bloqueado (otra pestana con una version vieja abierta) o fallo: se sigue sin
    // memoria. Nunca se rechaza: perder el recuerdo del archivo no es un error.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // Ignorado a proposito.
    }
  }
}

export async function rememberFile(file: BoundFile): Promise<void> {
  await withStore("readwrite", (s) => s.put(file, KEY));
}

export async function recallFile(): Promise<BoundFile | null> {
  const value = await withStore<BoundFile | undefined>("readonly", (s) => s.get(KEY));
  return value && value.handle ? value : null;
}

export async function forgetFile(): Promise<void> {
  await withStore("readwrite", (s) => s.delete(KEY));
}

/* ------------------------------------------------------- arranque del sistema

   El manifest ya declara `file_handlers`: la app instalada puede abrir un `.drawi`
   con doble clic desde el explorador. Sin escuchar aqui, esa declaracion no hacia
   nada.

   Solo existe en la app instalada de un navegador con la API; en una pestana normal
   no se llama nunca. */

export function consumeLaunchFiles(fn: (handle: FileSystemFileHandle) => void): void {
  const queue = typeof window !== "undefined" ? window.launchQueue : undefined;
  if (!queue || typeof queue.setConsumer !== "function") return;
  queue.setConsumer((params) => {
    for (const handle of params.files ?? []) {
      if (handle.kind === "file") fn(handle);
    }
  });
}
