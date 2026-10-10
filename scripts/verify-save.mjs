/**
 * Verificacion del guardado sobre el mismo archivo, en un navegador de verdad.
 *
 * La parte nueva del guardado -el archivo vinculado- no la puede cubrir la suite de
 * humo: alli no existe `showSaveFilePicker`, asi que solo se ejercita la descarga.
 * Y tampoco se puede probar a mano de forma repetible, porque el dialogo nativo es
 * del sistema y no hay forma de automatizarlo.
 *
 * La salida es doblar la API desde dentro de la pagina: se sustituyen los selectores
 * por funciones que devuelven un archivo falso en memoria y anotan cada llamada. Asi
 * se comprueba lo que de verdad importa y que ningun doble podria disimular:
 *
 *  - que el primer guardado PIDE destino y el segundo ya no (escribe encima);
 *  - que abrir un `.drawi` lo vincula, de modo que el primer Ctrl+S sobrescribe;
 *  - que "Nuevo" suelta el vinculo en vez de escribir sobre el archivo anterior;
 *  - que el velo de carga aparece y se va al abrir, y que mientras esta puesto el
 *    teclado no llega a la app.
 *
 * No forma parte de `npm test`: necesita un Chrome descargado y arrancar un servidor.
 * Se ejecuta a mano con `node scripts/verify-save.mjs`.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4399;
const URL = `http://localhost:${PORT}`;

const results = [];
const ok = (label, cond, extra = "") => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  return cond;
};

const waitForServer = async (url, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* todavia no */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

/**
 * El doble de la File System Access API, instalado ANTES de que cargue la app.
 *
 * El archivo falso guarda lo que se le escribe en un mapa de la propia pagina, para
 * poder leerlo despues desde la prueba y comparar el JSON con lo que el documento
 * serializa.
 */
const FAKE_FS = () => {
  const state = {
    saves: [],
    opens: [],
    closeCount: 0,
    lastWrite: "",
    lastCloseName: "",
    files: new Map(),
    openName: "abierto.drawi",
  };
  window.__fs = state;

  const makeHandle = (name) => ({
    kind: "file",
    name,
    async getFile() {
      return { text: async () => state.files.get(name) ?? "" };
    },
    async createWritable() {
      let pending = "";
      return {
        async write(data) {
          pending += typeof data === "string" ? data : "";
        },
        async close() {
          state.files.set(name, pending);
          state.lastWrite = pending;
          state.lastCloseName = name;
          state.closeCount++;
        },
        async abort() {},
      };
    },
    async queryPermission() {
      return "granted";
    },
    async requestPermission() {
      return "granted";
    },
    async isSameEntry() {
      return false;
    },
  });

  window.showSaveFilePicker = async (options) => {
    const name = options?.suggestedName ?? "sin-titulo.drawi";
    state.saves.push(name);
    return makeHandle(name);
  };
  window.showOpenFilePicker = async () => {
    state.opens.push(state.openName);
    return [makeHandle(state.openName)];
  };
};

/** Un Ctrl/Cmd+S de verdad, por el camino del teclado. */
const chord = async (page, key, shift = false) => {
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
};

/*
 * El servidor se arranca llamando a Vite directamente, y no por `npm run dev`, por
 * dos motivos que costaron un rato:
 *
 *  - `npm` añade un proceso intermedio que en Windows no muere al matar al padre, y
 *    el servidor se queda vivo ocupando el puerto para la siguiente ejecución.
 *  - Vite, sin `--strictPort`, si el puerto está ocupado sube al siguiente libre. Y
 *    como los puertos de alrededor pueden tener servidores de vista previa
 *    olvidados (que sirven `dist/`, o sea el build viejo), la prueba acabaria
 *    midiendo una aplicacion que no es la que se acaba de escribir. Con
 *    `--strictPort` falla en vez de mentir, y ademas se comprueba abajo que lo que
 *    responde es el servidor de desarrollo.
 */
const server = spawn(
  process.execPath,
  [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--port", String(PORT), "--strictPort"],
  { cwd: root, stdio: "ignore" },
);

const killServer = () => {
  if (server.exitCode !== null || server.killed) return;
  try {
    // En Windows el hijo de Vite no siempre muere con el padre: se mata el arbol.
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    server.kill();
  }
};

let browser = null;
try {
  if (!(await waitForServer(URL))) throw new Error(`el servidor de desarrollo no arranco en ${URL}`);

  // Quien responde tiene que ser el servidor de DESARROLLO (el que sirve los modulos
  // de `src/`), no un build olvidado.
  const html = await (await fetch(URL)).text();
  if (!html.includes("/@vite/client")) {
    throw new Error(`en ${PORT} responde otra cosa que no es el servidor de desarrollo`);
  }

  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 760, deviceScaleFactor: 1 });

  const logs = [];
  page.on("console", (m) => {
    if (m.type() === "error") logs.push(`[console] ${m.text()}`);
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.evaluateOnNewDocument(FAKE_FS);
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(() => !!window.__drawiEditor, { timeout: 30000 });
  // El editor arranca su bucle en el primer frame; se le da un respiro.
  await new Promise((r) => setTimeout(r, 300));

  const fs = () => page.evaluate(() => ({ ...window.__fs, files: undefined }));
  const title = () => page.evaluate(() => document.title);
  const status = () => page.evaluate(() => document.querySelector(".statusbar")?.textContent ?? "");

  // ---------------------------------------------------------------- 1. guardar

  await chord(page, "s");
  await new Promise((r) => setTimeout(r, 250));
  let s = await fs();
  ok("el primer guardado pide destino", s.saves.length === 1, s.saves.join(", "));
  ok("y lo sugiere con el nombre del documento", s.saves[0] === "Sin-titulo.drawi", s.saves[0]);
  ok("el archivo recibe el proyecto de drawi", s.lastWrite.includes('"format":"drawi"'), `${s.lastWrite.length} bytes`);
  ok("la barra de estado dice donde se guardo", (await status()).includes("Guardado en Sin-titulo.drawi"), await status());

  // --------------------------------------------------- 2. guardar otra vez

  await page.evaluate(() => window.__drawiEditor.setName("dibujo a lapiz"));
  ok("un cambio sin guardar marca el titulo", (await title()).startsWith("• "), await title());

  const before = (await fs()).closeCount;
  await chord(page, "s");
  await new Promise((r) => setTimeout(r, 250));
  s = await fs();
  ok("el segundo guardado NO vuelve a preguntar", s.saves.length === 1, `${s.saves.length} dialogos`);
  ok("y escribe otra vez en el mismo archivo", s.closeCount === before + 1 && s.lastCloseName === "Sin-titulo.drawi", `${before} -> ${s.closeCount} en ${s.lastCloseName}`);
  ok("guardar limpia la marca del titulo", !(await title()).startsWith("• "), await title());
  // Renombrar el documento no renombra el archivo -para eso esta "Guardar como"-:
  // el archivo sigue siendo el mismo y el nombre que puso la persona no se pierde.
  ok("renombrar el documento no toca el archivo", (await title()).includes("dibujo a lapiz"), await title());

  // ------------------------------------------------------------------ 3. abrir

  // Un segundo proyecto, con otro nombre, para abrirlo con Ctrl+O.
  const otro = JSON.parse((await fs()).lastWrite);
  otro.name = "Otro trabajo";
  await page.evaluate(
    (text) => {
      window.__fs.files.set("abierto.drawi", text);
      window.__fs.openName = "abierto.drawi";
    },
    JSON.stringify(otro),
  );

  // El velo: se anota cada vez que cambia de estado, sin depender de pillarlo a tiempo.
  await page.evaluate(() => {
    const el = document.querySelector(".busy");
    window.__busyLog = [];
    window.__busyWatch = new MutationObserver(() => {
      window.__busyLog.push(el.classList.contains("is-visible"));
    });
    window.__busyWatch.observe(el, { attributes: true, attributeFilter: ["class"] });
  });

  await chord(page, "o");
  await new Promise((r) => setTimeout(r, 400));
  s = await fs();
  ok("abrir pide un archivo con el selector", s.opens.length === 1, s.opens.join(", "));
  ok("el proyecto abierto reemplaza al anterior", (await title()).includes("Otro trabajo"), await title());

  const busyLog = await page.evaluate(() => {
    window.__busyWatch.disconnect();
    return window.__busyLog;
  });
  ok("el velo aparece al abrir y se va al terminar", `${busyLog}` === "true,false", `${busyLog}`);

  // El archivo abierto queda vinculado: el primer guardado ya escribe encima.
  const beforeOpenSave = (await fs()).closeCount;
  await chord(page, "s");
  await new Promise((r) => setTimeout(r, 250));
  s = await fs();
  ok("guardar tras abrir no pregunta otra vez", s.saves.length === 1, `${s.saves.length} dialogos`);
  ok("y escribe en el archivo que se abrio", s.closeCount === beforeOpenSave + 1, `${s.closeCount}`);

  // ------------------------------------------------------ 4. velo y teclado

  const teclado = await page.evaluate(async () => {
    // `is-open` lo lleva el contenedor interno (`.rm-container`), no la raiz.
    const isOpen = () => !!document.querySelector(".rm-container.is-open, .radial-menu.is-open");
    const press = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));

    await window.__drawiBusy.begin("Comprobando");
    press(); // con el velo puesto: no debe llegar
    const conVelo = isOpen();
    window.__drawiBusy.end();

    // Control: sin velo la MISMA tecla si abre el radial. Sin esto, la prueba de
    // arriba pasaria aunque el atajo estuviera roto por cualquier otro motivo.
    press();
    const sinVelo = isOpen();
    press(); // y se vuelve a cerrar, para no dejar el radial abierto
    return { conVelo, sinVelo };
  });
  ok("sin velo, la Q abre el radial", teclado.sinVelo, `${teclado.sinVelo}`);
  ok(
    "con el velo puesto el teclado no llega a la app",
    !teclado.conVelo,
    teclado.conVelo ? "el radial se abrio igual" : "",
  );

  // ------------------------------------------------------------ 5. "Nuevo"

  // Un lienzo nuevo no puede heredar el archivo anterior: el primer guardado tiene
  // que volver a preguntar, no escribir encima del trabajo que se estaba editando.
  await page.evaluate(async () => {
    const m = await import("/src/ui/file-actions.ts");
    m.newDocument(window.__drawiEditor);
  });
  await new Promise((r) => setTimeout(r, 200));
  await chord(page, "s");
  await new Promise((r) => setTimeout(r, 250));
  s = await fs();
  ok("un lienzo nuevo suelta el archivo anterior", s.saves.length === 2, `${s.saves.length} dialogos`);

  // ------------------------------------------------------- 6. "Guardar como"

  // Es el unico camino para cambiar de archivo, asi que tiene que preguntar aunque
  // el documento ya tenga uno; y a partir de ahi volver a guardar va al nuevo.
  const beforeAs = s.saves.length;
  await chord(page, "s", true);
  await new Promise((r) => setTimeout(r, 250));
  s = await fs();
  ok("Ctrl+Shift+S pide otro archivo", s.saves.length === beforeAs + 1, `${beforeAs} -> ${s.saves.length}`);

  const afterAs = s.closeCount;
  await chord(page, "s");
  await new Promise((r) => setTimeout(r, 250));
  s = await fs();
  ok(
    "y el archivo nuevo pasa a ser el de guardar",
    s.saves.length === beforeAs + 1 && s.closeCount === afterAs + 1,
    `${s.saves.length} dialogos, ${s.closeCount} escrituras`,
  );

  // ------------------------------------- 7. memoria del archivo (IndexedDB)

  const memory = await page.evaluate(async () => {
    const m = await import("/src/io/file-handle.ts");
    const fake = { handle: { kind: "file", name: "guardado.drawi" }, name: "guardado.drawi", docName: "d" };
    await m.rememberFile(fake);
    const back = await m.recallFile();
    await m.forgetFile();
    const gone = await m.recallFile();
    return { name: back?.name ?? null, docName: back?.docName ?? null, gone: gone === null };
  });
  ok("el archivo se recuerda entre sesiones", memory.name === "guardado.drawi", `${memory.name}`);
  ok("y con el nombre del documento que lo vinculo", memory.docName === "d", `${memory.docName}`);
  ok("olvidarlo lo borra de verdad", memory.gone, `${memory.gone}`);

  // ------------------------------------------------------------ 8. sin ruido

  ok("sin errores en consola", logs.length === 0, logs.slice(0, 3).join(" | "));
} catch (err) {
  ok("la verificacion corre entera", false, err instanceof Error ? err.message : String(err));
} finally {
  if (browser) await browser.close();
  killServer();
}

console.log(results.join("\n"));
const fails = results.filter((l) => l.startsWith("FAIL"));
console.log(`\n${results.length - fails.length}/${results.length} en verde`);
console.log(fails.length ? "RESULTADO: HAY FALLOS" : "RESULTADO: TODO EN VERDE");
process.exit(fails.length ? 1 : 0);
