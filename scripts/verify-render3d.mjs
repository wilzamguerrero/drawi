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

  /**
   * Recorre la ESPINA del trazo -la fila central de lo pintado- y devuelve el alfa
   * minimo y el hueco mas largo que encuentra.
   *
   * La fila se elige por el centro de la caja de lo pintado, no por la que mas
   * tinta tiene: esa es la del borde, donde el propio antialias del contorno baja
   * el alfa y la medida dejaria de hablar de las juntas. Se mira solo el 80 %
   * central, porque en los cabos el trazo se afila y lo que se mide ahi es el
   * afilado.
   */
  const scanSpine = () =>
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
              const { width, height } = tmp;
              const d = ctx.getImageData(0, 0, width, height).data;
              const a = (x, y) => d[(y * width + x) * 4 + 3];

              let top = -1;
              let bottom = -1;
              for (let y = 0; y < height; y++) {
                let any = false;
                for (let x = 0; x < width; x++) {
                  if (a(x, y) > 8) {
                    any = true;
                    break;
                  }
                }
                if (any) {
                  if (top < 0) top = y;
                  bottom = y;
                }
              }
              if (top < 0) return resolve({ min: 0, gap: 0, span: 0 });

              const y = Math.round((top + bottom) / 2);
              let first = -1;
              let last = -1;
              for (let x = 0; x < width; x++) {
                if (a(x, y) > 8) {
                  if (first < 0) first = x;
                  last = x;
                }
              }
              const from = Math.round(first + (last - first) * 0.1);
              const to = Math.round(first + (last - first) * 0.9);
              let min = 255;
              let run = 0;
              let gap = 0;
              for (let x = from; x <= to; x++) {
                const v = a(x, y);
                if (v < min) min = v;
                if (v < 200) {
                  run++;
                  if (run > gap) gap = run;
                } else {
                  run = 0;
                }
              }
              resolve({ min, gap, span: last - first });
            }),
          );
        }),
    );

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

  // --- 2b. El trazo se ve MIENTRAS se dibuja ---------------------------------
  //
  // Es la comprobacion que decide si dibujar se siente o no: con el puntero
  // apoyado y a medio gesto, la escena todavia no tiene ningun trazo -no se ha
  // soltado- pero el lienzo ya tiene que estar pintado. Antes de la cinta
  // provisional esta medida daba cero pixeles: se dibujaba a ciegas.
  //
  // Y de paso se mide su espina. La vista previa NO esta decimada, asi que un
  // tramo recto lleva muchas juntas colineales: es justo el caso en el que dos
  // quads que comparten canto exacto dejan una costura clara al componerse.
  await page.mouse.move(cx - 150, cy - 60);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(cx - 150 + i * 14, cy - 60);

  const midGesture = await readStats();
  const midPixels = await readPixels();
  const previewSpine = await scanSpine();

  ok(
    "a medio gesto la escena todavia no tiene el trazo",
    midGesture.strokes === 0,
    `trazos ${midGesture.strokes}, lotes ${midGesture.drawCalls}`,
  );
  ok(
    "pero el lienzo ya lo esta pintando",
    midPixels.opaque > 300,
    `${midPixels.opaque} pixeles con el puntero apoyado`,
  );
  ok(
    "la vista previa no tiene costura en su espina",
    previewSpine.min >= 250 && previewSpine.gap === 0,
    `alfa minimo ${previewSpine.min}, hueco mayor ${previewSpine.gap} px en ${previewSpine.span} px`,
  );

  await page.mouse.up();
  const afterRelease = await readStats();
  ok(
    "al soltar, el trazo entra en la escena",
    afterRelease.strokes === 1,
    `trazos ${afterRelease.strokes}`,
  );

  // Se vacia para que lo que sigue parta de un lienzo limpio.
  await page.evaluate(() => window.__drawiEditor.viewport3d.clear());
  await settle();

  // --- 2c. Los codos de un zigzag no dejan muesca ----------------------------
  //
  // Con la camara de frente, un zigzag de codos rectos. En cada vertice interior
  // se mira el disco de radio mitad del ancho del trazo: es exactamente el trozo
  // que tiene que cubrir la union de los dos segmentos que concurren ahi. Sin
  // prolongarlos, el lado exterior del codo se queda sin pintar.
  await page.evaluate(() => {
    const cam = window.__drawiEditor.viewport3d.camera;
    cam.yaw = 0;
    cam.pitch = 0;
  });
  await settle();

  // El pincel se fija para que la geometria sea determinista: con el arrastre tipo
  // lazo y el suavizado por defecto la punta persigue al cursor y CORTA la esquina,
  // asi que el vertice del raton deja de estar dentro del trazo y lo que se mediria
  // es ese recorte, no la junta. Sin afilado ni ruido, el ancho es el mismo en todo
  // el recorrido, que es lo que permite deducir el radio a partir de la imagen.
  const brushBefore = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    const before = { ...ed.brush };
    ed.setBrush({
      // Pincel GRUESO a proposito. El filtro del pincel redondea el codo unos
      // pocos pixeles -una distancia que no depende del grosor-, asi que cuanto
      // mas ancho sea el trazo, mas margen queda entre el borde del disco que se
      // muestrea y el recorte. Con un pincel fino ese margen era de menos de un
      // pixel y la comprobacion pasaba o fallaba segun el fotograma.
      size: 44,
      dynamics: "constant",
      smoothing: 0,
      streamline: 0,
      jitter: 0,
      taperIn: 0,
      taperOut: 0,
    });
    return before;
  });

  const zig = [
    [cx - 260, cy - 130],
    [cx - 90, cy - 130],
    [cx - 90, cy + 40],
    [cx + 70, cy + 40],
    [cx + 70, cy - 130],
    [cx + 230, cy - 130],
  ];
  await page.mouse.move(zig[0][0], zig[0][1]);
  await page.mouse.down();
  for (let v = 1; v < zig.length; v++) {
    const [ax, ay] = zig[v - 1];
    const [bx, by] = zig[v];
    const steps = Math.max(8, Math.round(Math.hypot(bx - ax, by - ay) / 10));
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(ax + (bx - ax) * (i / steps), ay + (by - ay) * (i / steps));
    }
  }
  await page.mouse.up();

  const corners = await page.evaluate(
    ({ zig }) =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = document.querySelector("canvas.layer-3d");
            // El rectangulo se lee AQUI y no se recibe de fuera: las coordenadas de
            // `zig` son absolutas de la pagina, y el lienzo puede haberse movido
            // desde que empezo la verificacion. Con un rectangulo viejo los indices
            // salen fuera de rango y la medida pasa en falso.
            const r = c.getBoundingClientRect();
            const kx = c.width / Math.max(1, r.width);
            const ky = c.height / Math.max(1, r.height);
            const cx0 = (x) => (x - r.left) * kx;
            const cy0 = (y) => (y - r.top) * ky;

            const tmp = document.createElement("canvas");
            tmp.width = c.width;
            tmp.height = c.height;
            const ctx = tmp.getContext("2d");
            ctx.drawImage(c, 0, 0);
            const { width, height } = tmp;
            const d = ctx.getImageData(0, 0, width, height).data;
            const a = (x, y) => d[(y * width + x) * 4 + 3];

            // El grosor se mide en el primer tramo horizontal, lejos de los codos
            // y del cabo afilado, para que el radio de la ventana salga de la
            // propia imagen y no de suponer una escala.
            const col = Math.round(cx0(zig[0][0] + (zig[1][0] - zig[0][0]) * 0.45));
            let thick = 0;
            for (let y = 0; y < height; y++) {
              if (!(a(col, y) > 8)) continue;
              let run = 0;
              while (y < height && a(col, y) > 8) {
                run++;
                y++;
              }
              if (run > thick) thick = run;
            }
            // Se muestrea al 60 % del radio: el borde del disco esta a medio
            // cubrir, y el codo dibujado nunca cae exactamente sobre el vertice
            // del raton porque el filtro del pincel lo redondea. Ese 40 % de
            // margen deja fuera las dos cosas y sigue siendo una ventana enorme
            // comparada con la muesca que se persigue, que sin prolongar los
            // segmentos se come el lado exterior ENTERO del codo.
            const rad = Math.max(2, thick * 0.3);

            let holes = 0;
            let worst = 0;
            for (let v = 1; v < zig.length - 1; v++) {
              const jx = cx0(zig[v][0]);
              const jy = cy0(zig[v][1]);
              let bad = 0;
              const n = Math.ceil(rad);
              for (let dy = -n; dy <= n; dy++) {
                for (let dx = -n; dx <= n; dx++) {
                  if (dx * dx + dy * dy > rad * rad) continue;
                  const x = Math.round(jx + dx);
                  const y = Math.round(jy + dy);
                  if (x < 0 || y < 0 || x >= width || y >= height) continue;
                  // `!(v >= 200)` y no `v < 200`: un indice fuera de rango devuelve
                  // `undefined`, y `undefined < 200` es falso. Asi una coordenada
                  // mal calculada cuenta como agujero en vez de colarse.
                  if (!(a(x, y) >= 200)) bad++;
                }
              }
              holes += bad;
              if (bad > worst) worst = bad;
            }
            resolve({ thick, rad, holes, worst });
          }),
        );
      }),
    { zig },
  );

  ok(
    "los codos del zigzag quedan tapados",
    // El grosor entra en la condicion a proposito: sin el, medir sobre un lienzo
    // vacio daria cero agujeros y la comprobacion pasaria sin probar nada.
    corners.thick > 2 && corners.holes === 0,
    `groso ${corners.thick} px, radio ${corners.rad.toFixed(1)}, ` +
      `${corners.holes} pixeles sin pintar (peor codo ${corners.worst})`,
  );

  await page.evaluate(() => {
    const vp = window.__drawiEditor.viewport3d;
    vp.clear();
    vp.camera.yaw = 0.6;
    vp.camera.pitch = 0.35;
    vp.frameAll();
  });
  await page.evaluate((b) => window.__drawiEditor.setBrush(b), brushBefore);
  await settle();

  // --- 2d. La rejilla del suelo y la marca del anclaje -----------------------
  //
  // Esto es justo lo que no cubria la verificacion, y por eso se colo un fallo
  // que se veia a simple vista: la rejilla es un material SIN iluminar, asi que no
  // declara los mismos uniformes que los demas, y el bucle que reparte la camara
  // le pedia uno que no tiene. Lanzaba una excepcion en CADA fotograma, y como el
  // lienzo conserva el ultimo fotograma bueno, parecia que todo iba bien mientras
  // el visor no dibujaba nada.
  await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.clearScene3D();
    ed.setScene3D({ grid: { enabled: true, opacity: 0.9 } });
    ed.setSpaceSnap({ source: "grid", gridStep: 50 });
  });
  await settle();
  const conRejilla = await readPixels();
  ok(
    "la rejilla del suelo se dibuja",
    conRejilla.opaque > 1500,
    `${conRejilla.opaque} pixeles`,
  );

  await page.evaluate(() =>
    window.__drawiEditor.setSpaceSnap({ source: "anchor", anchor: { x: 0, y: 0, z: 0 } }),
  );
  await settle();
  const conAncla = await readPixels();
  ok(
    "y la marca del anclaje se ve",
    conAncla.opaque > 0,
    `${conAncla.opaque} pixeles`,
  );

  await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.setSpaceSnap({ source: "off", anchor: null });
    ed.setScene3D({ grid: { enabled: false, opacity: 0.55 } });
  });
  await settle();
  const sinNada = await readPixels();
  ok(
    "y al apagarlas el lienzo queda limpio",
    sinNada.opaque < 200,
    `${sinNada.opaque} pixeles`,
  );

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

  // --- 3b. Las capas del espacio existen, y su ojo manda ---------------------
  //
  // Lo que se comprueba es el contrato entero: los trazos caen en una capa de
  // verdad -no en un identificador escrito a mano-, esa capa sale en el panel con
  // su ojo, y apagarla quita la pintura de la pantalla.
  const capas = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    const space = ed.doc.layers.filter((l) => l.kind === "scene3d");
    return {
      space: space.length,
      nombre: space[0] ? space[0].name : null,
      id: space[0] ? space[0].id : null,
      todosDentro: space[0] ? ed.doc.strokes3d.every((s) => s.layerId === space[0].id) : false,
      filas: document.querySelectorAll(".layers-panel .layer-kind").length,
    };
  });
  ok(
    "los trazos caen en una capa del espacio",
    capas.space === 1 && capas.todosDentro,
    JSON.stringify(capas),
  );
  ok("y la capa se ve en el panel", capas.filas > 0, `${capas.filas} filas con glifo de tipo`);

  const apagada = await page.evaluate((id) => {
    window.__drawiEditor.setLayer(id, { visible: false });
    return window.__drawiEditor.doc.layerVisible(id);
  }, capas.id);
  await settle();
  const pixelsApagado = await readPixels();
  ok(
    "apagar la capa quita el dibujo de la pantalla",
    apagada === false && pixelsApagado.opaque < pixels.opaque * 0.1,
    `${pixels.opaque} -> ${pixelsApagado.opaque} pixeles`,
  );

  const encendida = await page.evaluate((id) => {
    window.__drawiEditor.setLayer(id, { visible: true });
    return window.__drawiEditor.doc.layerVisible(id);
  }, capas.id);
  await settle();
  const pixelsEncendido = await readPixels();
  ok(
    "y volver a encenderla lo devuelve",
    encendida === true && Math.abs(pixelsEncendido.opaque - pixels.opaque) < pixels.opaque * 0.1,
    `${pixelsEncendido.opaque} pixeles frente a ${pixels.opaque}`,
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

  // La rejilla se deja puesta para la captura: es la unica forma de mirar de un
  // vistazo como esta quedando, y un PNG que solo enseña los trazos no dice nada
  // de las funciones nuevas.
  await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.setScene3D({ grid: { enabled: false, opacity: 0.55 } });
    ed.setScene3D({ grid: { enabled: true, opacity: 0.55 } });
  });
  await settle();

  // Captura del resultado, con el modo 3D todavia activo y el dibujo delante.
  // Fuera de dist/ a proposito: `npm run build` vacia esa carpeta y la borraria.
  const shot = process.env.SHOT || path.join(root, "verificacion-3d.png");
  await page.screenshot({ path: shot });
  console.log("Captura guardada en " + shot);

  // --- 6. Volver al 2D --------------------------------------------------------
  //
  // Dos cosas distintas, y la distincion es el corazon del diseno: salir del
  // espacio suelta el PUNTERO -que vuelve al lienzo-, pero no aparta la IMAGEN.
  // Antes esta comprobacion afirmaba que el lienzo se ocultaba, y por eso ahora
  // falla: el contrato es el contrario a proposito, porque el espacio es una capa
  // con la que se convive y no un modo del que se sale.
  const back = await page.evaluate(() => {
    const ed = window.__drawiEditor;
    ed.setMode3D(false);
    const c = document.querySelector("canvas.layer-3d");
    const cs = getComputedStyle(c);
    return {
      mode3d: ed.mode3d,
      display: cs.display,
      pointer: cs.pointerEvents,
      strokes: ed.state.scene3d.strokes,
    };
  });
  ok(
    "al salir del espacio el puntero vuelve al lienzo",
    back.mode3d === false && back.pointer === "none",
    JSON.stringify(back),
  );
  ok(
    "y el espacio sigue a la vista, porque tiene trazos",
    back.strokes > 0 && back.display !== "none",
    `trazos ${back.strokes}, display ${back.display}`,
  );

  // Y el caso contrario: sin nada que enseñar, el lienzo se aparta. Es lo que
  // evita componer un lienzo WebGL a pantalla completa para no enseñar nada.
  const vaciado = await page.evaluate(() => {
    window.__drawiEditor.clearScene3D();
    return window.__drawiEditor.state.scene3d.strokes;
  });
  await settle();
  const oculto = await page.evaluate(() =>
    getComputedStyle(document.querySelector("canvas.layer-3d")).display,
  );
  ok(
    "sin nada en el espacio, su lienzo se aparta",
    vaciado === 0 && oculto === "none",
    `trazos ${vaciado}, display ${oculto}`,
  );

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
