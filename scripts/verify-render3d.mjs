/**
 * Verificacion del visor 3D en un navegador de verdad.
 *
 * Las pruebas de humo cubren la matematica y los datos, pero no pueden decir si
 * el shader compila, si las vistas intercaladas llegan a la GPU ni si algo se
 * pinta. Eso solo se sabe con un navegador delante, asi que esto abre uno, entra
 * en el modo 3D, dibuja trazos con el raton y **lee los pixeles** del lienzo.
 *
 * No forma parte de `npm test`: necesita un Chrome descargado y arrancar un
 * servidor. Se ejecuta a mano con `node scripts/verify-render3d.mjs`.
 *
 * Dos detalles que costaron un rato y conviene no perder:
 *
 *  - Hay que esperar dos fotogramas antes de leer los pixeles. El sincronizado de
 *    la GPU ocurre dentro del bucle de dibujado, asi que leer antes devuelve el
 *    estado anterior.
 *  - El lienzo solo se puede leer si el contexto se creo con
 *    `preserveDrawingBuffer`. Con los atributos por defecto el buffer se vacia al
 *    componer y la lectura sale vacia aunque se este pintando.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4177;
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

const server = spawn("npm", ["run", "preview", "--", "--port", String(PORT)], {
  cwd: root,
  shell: true,
  stdio: "ignore",
});

let browser = null;
try {
  if (!(await waitForServer(URL))) throw new Error("el servidor de vista previa no arranco");

  browser = await puppeteer.launch({
    headless: true,
    args: [
      // Sin esto un Chrome headless no tiene WebGL: hay que pedir el rasterizador
      // por software de forma explicita.
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
      "--no-sandbox",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 760, deviceScaleFactor: 1 });

  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(URL, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(() => !!window.__drawiEditor, { timeout: 30000 });

  /** Cuenta los pixeles pintados del lienzo 3D, tras dejar pasar dos fotogramas. */
  const readPixels = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const c = document.querySelector("canvas.layer-3d");
              const tmp = document.createElement("canvas");
              tmp.width = c.width;
              tmp.height = c.height;
              const ctx = tmp.getContext("2d");
              ctx.drawImage(c, 0, 0);
              const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
              let opaque = 0;
              let sum = 0;
              for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] > 8) {
                  opaque++;
                  sum += d[i] + d[i + 1] + d[i + 2];
                }
              }
              resolve({
                total: (d.length / 4) | 0,
                opaque,
                avgLuma: opaque ? Math.round(sum / (opaque * 3)) : null,
              });
            }),
          );
        }),
    );

  /** Estado 3D del editor, ya sincronizado con la GPU. */
  const readStats = async () => {
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    return page.evaluate(() => window.__drawiEditor.state.scene3d);
  };

  const settle = () =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // --- 1. El modo 3D se activa y hay contexto ---------------------------------
  const activation = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.setMode3D(true);
    const vp = ed.viewport3d;
    return {
      mode3d: ed.mode3d,
      available: ed.scene3dAvailable,
      error: vp ? vp.error : "sin visor",
      hasCanvas: !!document.querySelector("canvas.layer-3d"),
    };
  });
  ok("el modo 3D se activa", activation.mode3d === true, JSON.stringify(activation));
  ok("WebGL2 esta disponible en el navegador", activation.available === true);
  ok("el visor no reporta error", activation.error === null, String(activation.error));
  ok("el lienzo 3D existe en el DOM", activation.hasCanvas === true);

  // --- 2. Se dibuja con el raton, como lo haria una persona -------------------
  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas.layer-3d").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  ok("el lienzo 3D tiene tamano", box.w > 100 && box.h > 100,
     `${Math.round(box.w)}x${Math.round(box.h)}`);

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  const drawArc = async (index) => {
    const radius = 40 + index * 26;
    const steps = 44;
    await page.mouse.move(cx + radius, cy);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 1.6 + index * 0.4;
      await page.mouse.move(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    }
    await page.mouse.up();
  };

  for (let i = 0; i < 6; i++) await drawArc(i);

  // Un trazo apartado del racimo. Hace falta para que la prueba de borrado
  // signifique algo: sobre los arcos, que son concentricos y se tapan unos a
  // otros, quitar uno apenas cambia los pixeles aunque el borrado funcione.
  const isoY = cy - 250;
  await page.mouse.move(cx - 200, isoY);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(cx - 200 + i * 10, isoY);
  await page.mouse.up();

  const drawn = await readStats();
  const pixels = await readPixels();

  ok("los trazos llegan a la escena 3D", drawn.strokes >= 7, JSON.stringify(drawn));
  ok("las draw calls son un punado, no una por trazo", drawn.drawCalls <= 8,
     `${drawn.drawCalls} lotes para ${drawn.strokes} trazos`);
  ok("hay instancias que dibujar", drawn.instances > 0, `${drawn.instances}`);

  // --- 3. Los pixeles: lo que de verdad decide si se ve algo ------------------
  ok(
    "el lienzo 3D tiene pixeles pintados",
    pixels.opaque > 2000,
    `${pixels.opaque} de ${pixels.total} (${((pixels.opaque / pixels.total) * 100).toFixed(2)}%), ` +
      `luminancia media ${pixels.avgLuma}`,
  );

  // --- 4. Borrar con Alt, antes de mover la camara ---------------------------
  // El orden importa: tras orbitar, los trazos ya no estan donde estaban en
  // pantalla, asi que se prueba el borrador primero y encima de un trazo.
  await page.keyboard.down("Alt");
  await page.mouse.move(cx - 50, isoY);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Alt");

  const erased = await readStats();
  const pixelsAfterErase = await readPixels();

  ok("Alt borra un trazo", erased.strokes < drawn.strokes,
     `trazos ${drawn.strokes} -> ${erased.strokes}`);
  // El hueco del trazo borrado NO se recupera: ese es el diseno de "borrar no
  // compacta", el que hace que borrar y deshacer sean baratos.
  ok("borrar conserva el hueco en el buffer", erased.instances === drawn.instances,
     `${drawn.instances} instancias antes y despues`);
  // Y la prueba que de verdad importa: el trazo desaparece de la imagen.
  // El trazo aislado ocupa su propio hueco, asi que quitarlo tiene que notarse:
  // no vale que baje el contador mientras la imagen sigue igual.
  const removed = pixels.opaque - pixelsAfterErase.opaque;
  ok("borrar quita el trazo de la imagen", removed > 300,
     `${removed} pixeles menos (${pixels.opaque} -> ${pixelsAfterErase.opaque})`);

  // --- 5. La camara: orbitar cambia la imagen y no deja trazo -----------------
  const grab = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas.layer-3d");
      const tmp = document.createElement("canvas");
      tmp.width = 120;
      tmp.height = 120;
      tmp.getContext("2d").drawImage(c, 0, 0, 120, 120);
      return tmp.toDataURL();
    });

  const beforeOrbit = await grab();

  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  for (let i = 0; i < 12; i++) await page.mouse.move(cx + i * 12, cy + i * 4);
  await page.mouse.up({ button: "middle" });
  await settle();

  const afterOrbitImage = await grab();
  const afterOrbit = await readStats();

  ok("orbitar cambia la imagen", beforeOrbit !== afterOrbitImage);
  ok("orbitar NO deja un trazo", afterOrbit.strokes === erased.strokes,
     `${erased.strokes} -> ${afterOrbit.strokes}`);

  // Captura del resultado, con el modo 3D todavia activo y el dibujo delante.
  // Fuera de dist/ a proposito: `npm run build` vacia esa carpeta y la borraria.
  const shot = process.env.SHOT || path.join(root, "verificacion-3d.png");
  await page.screenshot({ path: shot });
  console.log("Captura guardada en " + shot);

  // --- 6. Volver al 2D --------------------------------------------------------
  const back = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.setMode3D(false);
    const c = document.querySelector("canvas.layer-3d");
    return { mode3d: ed.mode3d, display: getComputedStyle(c).display };
  });
  ok("se vuelve al lienzo 2D", back.mode3d === false && back.display === "none",
     JSON.stringify(back));

  const errors = logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
  ok("no hubo errores en la consola del navegador", errors.length === 0,
     errors.slice(0, 3).join(" | "));
  for (const e of errors.slice(0, 6)) console.log("  " + e);
} catch (err) {
  ok("la verificacion se ejecuto", false, err instanceof Error ? err.message : String(err));
} finally {
  if (browser) await browser.close();
  server.kill();
}

console.log(results.join("\n"));
const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - fails}/${results.length} en verde`);
console.log(fails ? "RENDER 3D: HAY FALLOS" : "RENDER 3D: TODO EN VERDE");
process.exit(fails ? 1 : 0);
