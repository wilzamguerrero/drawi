/**
 * Verificacion del pincel RASTER en un navegador de verdad.
 *
 * Las pruebas de humo construyen la app sobre un DOM simulado, pero ese shim no
 * rasteriza de verdad: `drawImage` no pinta pixeles que se puedan leer. El
 * pincel raster es, justamente, estampar sobre pixeles, asi que la unica forma
 * de saber si cae una huella es con un navegador delante que pinte y DEJE LEER
 * el lienzo.
 *
 * No forma parte de `npm test`: necesita un Chrome descargado y arrancar un
 * servidor. Se ejecuta a mano con `node scripts/verify-raster.mjs`.
 *
 * Mismo patron que `verify-render3d.mjs`: sirve el build de produccion, abre la
 * pagina, enciende el modo raster, arrastra el raton por el lienzo de tinta y
 * cuenta los pixeles pintados.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4178;
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
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 760, deviceScaleFactor: 1 });

  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(URL, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(() => !!window.__drawiEditor, { timeout: 30000 });

  const settle = () =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  /** Cuenta los pixeles no transparentes del lienzo de tinta. */
  const readInk = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const c = document.querySelector("canvas.layer-ink");
              const tmp = document.createElement("canvas");
              tmp.width = c.width;
              tmp.height = c.height;
              const ctx = tmp.getContext("2d");
              ctx.drawImage(c, 0, 0);
              const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
              let opaque = 0;
              for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) opaque++;
              resolve({ total: (d.length / 4) | 0, opaque });
            }),
          );
        }),
    );

  // --- 1. Encender el pincel raster ------------------------------------------
  const setup = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.setTool("brush");
    ed.setColor("#1030ff");
    ed.setBrush({
      asRaster: true,
      asAqua: false,
      asMatter: false,
      mode: "stroke",
      dynamics: "constant",
      size: 30,
      opacity: 1,
      rasterFlow: 1,
      rasterSpacing: 0.1,
      rasterHardness: 0.9,
      smoothing: 0,
      streamline: 0,
    });
    return {
      asRaster: ed.brush.asRaster,
      rasterActive: ed.rasterBrushActive,
      items: ed.doc.items.length,
      rasterLayers: ed.doc.rasterLayers.length,
    };
  });
  ok("el modo raster se activa", setup.asRaster === true && setup.rasterActive === true, JSON.stringify(setup));
  ok("el documento arranca sin capa raster", setup.rasterLayers === 0);

  const before = await readInk();

  // --- 2. Arrastrar el raton por el lienzo, como una persona -----------------
  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas.layer-ink").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  ok("el lienzo de tinta tiene tamano", box.w > 100 && box.h > 100, `${Math.round(box.w)}x${Math.round(box.h)}`);

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  await page.mouse.move(cx - 180, cy);
  await page.mouse.down();
  // A medio gesto, con el puntero apoyado y SIN soltar, el lienzo ya tiene que
  // estar pintado: es lo que distingue el trazo en vivo del que solo aparece al
  // soltar. Antes de arreglarlo, aqui habia cero pixeles.
  for (let i = 1; i <= 18; i++) await page.mouse.move(cx - 180 + i * 10, cy + Math.sin(i * 0.4) * 40);
  const mid = await readInk();
  ok("a medio gesto el trazo ya se ve (en vivo)", mid.opaque - before.opaque > 800, `+${mid.opaque - before.opaque} pixeles con el lapiz apoyado`);
  for (let i = 19; i <= 36; i++) await page.mouse.move(cx - 180 + i * 10, cy + Math.sin(i * 0.4) * 40);
  await page.mouse.up();
  await settle();

  const after = await readInk();
  const result = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    const layer = ed.doc.rasterLayers[0];
    const canvas = layer ? ed.rasterCanvasFor(layer.id, false) : null;
    return {
      rasterLayers: ed.doc.rasterLayers.length,
      items: ed.doc.items.length,
      activeKind: ed.doc.activeLayer ? ed.doc.activeLayer.kind : null,
      hasCanvas: !!canvas,
      canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
      hasRect: !!(layer && layer.rasterRect && layer.rasterRect.w > 0),
    };
  });

  // --- 3. Lo que de verdad decide si se ve algo: los pixeles -----------------
  const painted = after.opaque - before.opaque;
  ok("el trazo pinta pixeles en el lienzo", painted > 2000, `${before.opaque} -> ${after.opaque} (+${painted})`);
  ok("nacio UNA capa raster", result.rasterLayers === 1, JSON.stringify(result));
  ok("y es la capa activa", result.activeKind === "raster", String(result.activeKind));
  ok("la capa tiene su bitmap vivo y su caja de mundo", result.hasCanvas && result.hasRect, result.canvasSize ?? "sin lienzo");
  ok("el pincel raster NO deja tinta vectorial", result.items === 0, `${result.items} items`);

  // --- 4. Apagar la capa quita el dibujo de la pantalla ----------------------
  const layerId = await page.evaluate(() => window.__drawiEditor.doc.rasterLayers[0].id);
  await page.evaluate((id) => window.__drawiEditor.setLayer(id, { visible: false }), layerId);
  await settle();
  const hidden = await readInk();
  ok("apagar la capa raster quita su dibujo", hidden.opaque < after.opaque * 0.1, `${after.opaque} -> ${hidden.opaque}`);
  await page.evaluate((id) => window.__drawiEditor.setLayer(id, { visible: true }), layerId);
  await settle();
  const shown = await readInk();
  ok("y volver a encenderla lo devuelve", Math.abs(shown.opaque - after.opaque) < after.opaque * 0.1, `${shown.opaque} vs ${after.opaque}`);

  // --- 5. Biblioteca de pinceles ---------------------------------------------
  const presets = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    const list = ed.state.rasterPresets;
    if (list.length) ed.applyRasterPreset(list[list.length - 1].id);
    return { count: list.length, active: ed.state.rasterPresetId };
  });
  ok("hay pinceles de fabrica en la biblioteca", presets.count >= 5, `${presets.count} presets`);

  // --- 6. Importar un .abr sintetico (v1, una punta 4x4 de cobertura plena) ---
  const abr = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    const bytes = [];
    const u16 = (n) => bytes.push((n >> 8) & 255, n & 255);
    const u32 = (n) => bytes.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    u16(1); // version
    u16(1); // count
    u16(2); // type: sampled
    const data = [];
    const d16 = (n) => data.push((n >> 8) & 255, n & 255);
    const d32 = (n) => data.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    d32(0); // misc
    d16(25); // spacing %
    data.push(0); // antialias
    d16(0); d16(0); d16(4); d16(4); // bounds cortos
    d32(0); d32(0); d32(4); d32(4); // bounds largos (4x4)
    d16(8); // depth
    data.push(0); // compression: raw
    for (let i = 0; i < 16; i++) data.push(0); // gris 0 -> cobertura 255
    u32(data.length);
    for (const b of data) bytes.push(b);
    const before = ed.state.rasterPresets.length;
    const n = ed.importAbrBuffer(new Uint8Array(bytes).buffer, "test");
    return { n, before, after: ed.state.rasterPresets.length };
  });
  ok("importar un .abr sintetico añade una punta", abr.n === 1 && abr.after === abr.before + 1, JSON.stringify(abr));

  // --- 7. Guardar hornea el bitmap de la capa raster a dataURL ---------------
  const flat = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.flattenRasterLayers();
    const layer = ed.doc.rasterLayers[0];
    return {
      hasSrc: !!(layer && layer.rasterSrc && layer.rasterSrc.startsWith("data:image")),
      rect: !!(layer && layer.rasterRect && layer.rasterRect.w > 0),
    };
  });
  ok("guardar hornea el bitmap de la capa a rasterSrc", flat.hasSrc && flat.rect, JSON.stringify(flat));

  // --- 8. Reset a un pincel redondo limpio para las pruebas de modo ----------
  await page.evaluate(() => {
    const ed = window.__drawiEditor;
    const round = ed.state.rasterPresets[0];
    if (round) ed.applyRasterPreset(round.id);
    ed.setBrush({
      asRaster: true, asMatter: false, asAqua: false, invertErase: false,
      mode: "stroke", dynamics: "constant", size: 30, opacity: 1,
      rasterFlow: 1, rasterSpacing: 0.1, rasterHardness: 0.95, rasterRoundness: 1,
      rasterScatter: 0, rasterScatterCount: 1, rasterSizeJitter: 0, smoothing: 0, streamline: 0,
    });
  });

  const stroke = async (pts) => {
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const n = Math.max(6, Math.round(Math.hypot(bx - ax, by - ay) / 8));
      for (let k = 1; k <= n; k++) await page.mouse.move(ax + (bx - ax) * (k / n), ay + (by - ay) * (k / n));
    }
    await page.mouse.up();
    await settle();
  };

  // --- 8a. Modo Relleno: el área cerrada se rellena de píxeles ---------------
  const fillBefore = await readInk();
  await page.evaluate(() => window.__drawiEditor.setBrush({ mode: "fill" }));
  await stroke([[cx + 120, cy - 160], [cx + 260, cy - 160], [cx + 260, cy - 40], [cx + 120, cy - 40], [cx + 120, cy - 160]]);
  const fillAfter = await readInk();
  ok("el modo Relleno rellena un área con el pincel ráster", fillAfter.opaque - fillBefore.opaque > 3000, `+${fillAfter.opaque - fillBefore.opaque} px`);

  // --- 8b. Modo Arrastre: la forma estirada cae sobre la capa ----------------
  const pullBefore = await readInk();
  await page.evaluate(() => window.__drawiEditor.setBrush({ mode: "pull" }));
  await stroke([[cx - 300, cy + 120], [cx - 180, cy + 200]]);
  const pullAfter = await readInk();
  ok("el modo Arrastre estampa una forma ráster", pullAfter.opaque - pullBefore.opaque > 500, `+${pullAfter.opaque - pullBefore.opaque} px`);

  // --- 8c. Alt / usar como goma: el trazo ráster borra -----------------------
  const eraseBefore = await readInk();
  await page.evaluate(() => window.__drawiEditor.setBrush({ mode: "stroke", invertErase: true }));
  await stroke([[cx + 120, cy - 100], [cx + 260, cy - 100]]);
  await page.evaluate(() => window.__drawiEditor.setBrush({ invertErase: false }));
  const eraseAfter = await readInk();
  ok("con 'usar como goma' el trazo ráster borra", eraseAfter.opaque < eraseBefore.opaque, `${eraseBefore.opaque} -> ${eraseAfter.opaque}`);

  // --- 8d. Modo Borrador (pincel) sobre la capa ráster -----------------------
  const berBefore = await readInk();
  await page.evaluate(() => window.__drawiEditor.setBrush({ mode: "erase", eraseMode: "brush", size: 40 }));
  await stroke([[cx + 130, cy - 150], [cx + 250, cy - 50]]);
  const berAfter = await readInk();
  ok("el modo Borrador abre el bitmap de la capa ráster", berAfter.opaque < berBefore.opaque, `${berBefore.opaque} -> ${berAfter.opaque}`);
  await page.evaluate(() => window.__drawiEditor.setBrush({ mode: "stroke" }));

  const shot = process.env.SHOT || path.join(root, "verificacion-raster.png");
  await page.screenshot({ path: shot });
  console.log("Captura guardada en " + shot);

  const errors = logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
  ok("no hubo errores en la consola del navegador", errors.length === 0, errors.slice(0, 3).join(" | "));
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
console.log(fails ? "RASTER: HAY FALLOS" : "RASTER: TODO EN VERDE");
process.exit(fails ? 1 : 0);
