/**
 * Prueba de integracion de la interfaz.
 *
 * Construye la aplicacion entera sobre el DOM simulado de dom-shim.mjs y la
 * conduce por la misma ruta que seguiria una persona: eventos de puntero
 * reales sobre el lienzo, clics en todos los botones, cambios en todos los
 * controles del inspector. No comprueba pixeles (no hay con que pintarlos);
 * comprueba que nada revienta y que el estado del documento cambia como debe.
 *
 * Cubre en concreto lo que no se puede ver desde una prueba numerica: el
 * cableado entre la UI, el editor y las herramientas.
 */

import { App } from "../src/ui/app";
import { exportSvg } from "../src/io/export";
import { exportVector, newDocument, projectText, saveProject, autosave, restoreAutosave } from "../src/ui/file-actions";
import { parseProject } from "../src/io/project";

declare const globalThis: any;

// El tsconfig usa `"types": []` a proposito: la aplicacion se compila contra el
// DOM y nada mas. Las suites si corren en Node, asi que declaran aqui lo unico
// que tocan de el en vez de arrastrar @types/node a todo el proyecto.
declare const process: { exitCode?: number };

const out: string[] = [];
const ok = (label: string, cond: boolean, extra = ""): void => {
  out.push(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) globalThis.__failed = true;
};
const noThrow = (label: string, fn: () => unknown): unknown => {
  try { const v = fn(); ok(label, true); return v; }
  catch (e) { ok(label, false, String((e as Error).message ?? e)); return null; }
};

const root = document.createElement("div");
const app = new App(root);
const ed = app.editor;

const flat: any[] = [];
const walk = (n: any): void => { flat.push(n); (n.childNodes ?? []).forEach(walk); };
walk(root);
const host = flat.find((n) => (n.className ?? "").includes("canvas-host"));
const send = (type: string, x: number, y: number, pressure: number, extra: any = {}) => {
  const ev = new (globalThis.PointerEvent)(type, { clientX: x, clientY: y, pressure, target: host, ...extra });
  for (const [node, t, fn] of globalThis.__listeners) if (t === type && (node === host || node === globalThis.window)) fn(ev);
};

// Material real con el que exportar: tinta + materia.
ed.setTool("brush");
send("pointerdown", 180, 180, 0.3);
for (let i = 1; i <= 30; i++) send("pointermove", 180 + i * 5, 180 + Math.sin(i * 0.5) * 40, 0.2 + i * 0.025);
send("pointerup", 330, 190, 0);
ed.setTool("shape");
for (const [x, y] of [[420, 300], [470, 330], [445, 380]] as [number, number][]) {
  send("pointerdown", x, y, 0.5); send("pointermove", x + 55, y + 55, 0.5); send("pointerup", x + 55, y + 55, 0);
}
ok("escena con tinta y materia", ed.state.items > 0 && ed.state.bodies >= 3, `${ed.state.items} trazos / ${ed.state.bodies} cuerpos`);

// --- Modos de trazo (lo que el usuario pidio anadir) ---
for (const dyn of ["constant", "pressure", "velocity", "pressure-velocity", "tilt"] as const) {
  noThrow(`trazo dinamico: ${dyn}`, () => {
    ed.setBrush({ dynamics: dyn });
    ed.setTool("brush");
    send("pointerdown", 100, 400, 0.15);
    for (let i = 1; i <= 20; i++) send("pointermove", 100 + i * 9, 400 + i * 2, 0.15 + i * 0.04, { tiltX: i * 2, tiltY: 10 });
    send("pointerup", 280, 440, 0);
    return ed.state.brush.dynamics;
  });
}
ok("los cinco modos dejaron trazo", ed.state.items >= 6, `${ed.state.items} items`);

// --- Modos de pincel de Webchemy ---
for (const mode of ["stroke", "fill", "pull"] as const) {
  noThrow(`modo de pincel: ${mode}`, () => {
    ed.setBrush({ mode });
    send("pointerdown", 600, 150, 0.4);
    for (let i = 1; i <= 16; i++) send("pointermove", 600 + i * 7, 150 + i * 9, 0.5);
    send("pointerup", 712, 294, 0);
  });
}
noThrow("modificadores degradado + splat", () => {
  ed.setBrush({ mode: "stroke", gradient: true, splat: true });
  send("pointerdown", 700, 500, 0.4);
  for (let i = 1; i <= 14; i++) send("pointermove", 700 - i * 8, 500 - i * 6, 0.6);
  send("pointerup", 588, 416, 0);
  ed.setBrush({ gradient: false, splat: false });
});

// --- La seccion Forma solo ofrece lo que la pieza activa usa ---
// "Redondeo" no hace nada en una estrella y "Lados" no hace nada en una caja.
// Si el control sigue visible, el usuario arrastra el deslizador y no ocurre
// nada: la interfaz estaria mintiendo. La interfaz se repinta en un frame, asi
// que hay que esperarlo antes de mirar.
const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
const ctrlHidden = (label: string): boolean | null => {
  for (const n of flat) {
    if (n.className !== "slider-label" || n.textContent !== label) continue;
    let p: any = n.parentNode;
    while (p && !p.classList?.contains("ctrl-slider")) p = p.parentNode;
    if (p) return p.classList.contains("is-hidden");
  }
  return null;
};

ed.setTool("shape");
// Que control debe verse en cada forma, segun lo que la geometria usa de verdad.
const expectVisible: Record<string, string[]> = {
  circle: [],
  box: ["Proporcion", "Redondeo"],
  ngon: ["Lados", "Redondeo"],
  star: ["Lados", "Radio interior"],
  capsule: ["Proporcion"],
};
const everyCtrl = ["Proporcion", "Lados", "Radio interior", "Redondeo"];
let shapeUiErr = "";
for (const [kind, visible] of Object.entries(expectVisible)) {
  ed.setShape({ kind: kind as any });
  await frame();
  for (const label of everyCtrl) {
    const hidden = ctrlHidden(label);
    if (hidden === null) { shapeUiErr ||= `no encuentro el control "${label}"`; continue; }
    const should = !visible.includes(label);
    if (hidden !== should) {
      shapeUiErr ||= `${kind}: "${label}" ${hidden ? "oculto" : "visible"} y deberia estar ${should ? "oculto" : "visible"}`;
    }
  }
}
ok("la seccion Forma se adapta a la pieza", shapeUiErr === "", shapeUiErr || `${Object.keys(expectVisible).length} formas revisadas`);
ed.setShape({ kind: "ngon" });

// --- Las cuatro simetrias, dibujando de verdad en cada una ---
for (const [mode, count] of [["none", 1], ["mirror", 1], ["radial", 8], ["kaleido", 6]] as [any, number][]) {
  noThrow(`dibujo con simetria ${mode}`, () => {
    ed.setSymmetry({ mode, count, x: 400, y: 300, visible: true });
    send("pointerdown", 250, 250, 0.4);
    for (let i = 1; i <= 12; i++) send("pointermove", 250 + i * 6, 250 + i * 4, 0.5);
    send("pointerup", 322, 298, 0);
  });
}

// --- Arrastrar el gizmo de simetria con la herramienta dedicada ---
noThrow("arrastrar el eje de simetria", () => {
  ed.setTool("symmetry");
  send("pointerdown", 400, 300, 0.5);
  send("pointermove", 520, 360, 0.5);
  send("pointerup", 520, 360, 0);
});

// --- Goma, boton lateral y rechazo de palma ---
noThrow("punta de goma", () => {
  ed.setTool("brush");
  send("pointerdown", 300, 300, 0.5, { buttons: 32, pointerType: "pen" });
  send("pointermove", 340, 330, 0.5, { buttons: 32, pointerType: "pen" });
  send("pointerup", 340, 330, 0, { buttons: 0, pointerType: "pen" });
});
noThrow("boton lateral del lapiz", () => {
  send("pointerdown", 300, 300, 0.5, { buttons: 2, pointerType: "pen" });
  send("pointermove", 340, 330, 0.5, { buttons: 2, pointerType: "pen" });
  send("pointerup", 340, 330, 0, { buttons: 0, pointerType: "pen" });
});
noThrow("toque tactil (posible palma)", () => {
  send("pointerdown", 300, 300, 0, { pointerType: "touch", pointerId: 77 });
  send("pointermove", 305, 305, 0, { pointerType: "touch", pointerId: 77 });
  send("pointerup", 305, 305, 0, { pointerType: "touch", pointerId: 77 });
});
ok("la lectura del lapiz se poblo", ed.state.pen !== null && ed.state.pen.kind.length > 0,
   ed.state.pen ? `${ed.state.pen.kind} p=${ed.state.pen.pressure.toFixed(2)}` : "null");

// --- Materia: mover, hornear, sembrar, muros, colisionadores ---
noThrow("mover materia con el raton", () => {
  ed.setTool("matter");
  send("pointerdown", 445, 330, 0.5);
  for (let i = 1; i <= 10; i++) send("pointermove", 445 + i * 8, 330 - i * 4, 0.5);
  send("pointerup", 525, 290, 0);
});
noThrow("sembrar materia", () => ed.seedMatter(6));
noThrow("alternar muros", () => ed.toggleWalls());
noThrow("alternar colisionadores", () => ed.toggleColliders());
noThrow("pausar y reanudar la simulacion", () => { ed.setRunning(false); ed.setRunning(true); });
const bodiesBeforeBake = ed.state.bodies;
noThrow("hornear materia a tinta", () => ed.bakeMatter());
ok("hornear vacia los cuerpos y deja tinta", ed.state.bodies === 0 && ed.state.items > 0,
   `${bodiesBeforeBake} cuerpos -> ${ed.state.bodies}, ${ed.state.items} items`);

// --- Cuentagotas ---
noThrow("cuentagotas sobre el lienzo", () => {
  ed.setTool("picker");
  send("pointerdown", 220, 200, 0.5);
  send("pointerup", 220, 200, 0);
});

// --- Vista ---
noThrow("zoom con rueda", () => {
  for (const [node, t, fn] of globalThis.__listeners) {
    if (t === "wheel" && (node === host || node === globalThis.window)) {
      fn({ deltaX: 0, deltaY: -240, clientX: 400, clientY: 300, ctrlKey: true, preventDefault() {}, target: host });
    }
  }
});
ok("la rueda cambio el zoom", Math.abs(ed.state.zoom - 1) > 1e-6, `zoom=${ed.state.zoom.toFixed(3)}`);
noThrow("restablecer la vista", () => { ed.camera.reset(); ed.emitState(); });

// --- Exportacion y proyecto ---
const svg = noThrow("exportar SVG", () => exportSvg(ed.doc)) as string | null;
ok("el SVG tiene contenido", !!svg && svg.startsWith("<svg") && svg.length > 400, `${svg?.length ?? 0} bytes`);
ok("el SVG cierra bien", !!svg && svg.trim().endsWith("</svg>"));
const svg2 = noThrow("exportar SVG desde la UI", () => exportVector(ed)) as string | null;
ok("exportVector informa del resultado", typeof svg2 === "string" && svg2.length > 0, String(svg2));

const proj = noThrow("serializar proyecto", () => projectText(ed)) as string | null;
ok("el proyecto es JSON valido", !!proj && (() => { try { JSON.parse(proj); return true; } catch { return false; } })(), `${proj?.length ?? 0} bytes`);
const parsed = noThrow("reanalizar proyecto", () => parseProject(proj!)) as any;
ok("el proyecto conserva los items", !!parsed && Array.isArray(parsed.items) && parsed.items.length === ed.state.items,
   `${parsed?.items?.length} vs ${ed.state.items}`);
noThrow("guardar proyecto (descarga)", () => saveProject(ed));
noThrow("autoguardado", () => autosave(ed));

// --- Historial a fondo ---
let depth = 0;
noThrow("deshacer hasta el fondo", () => { while (ed.state.history.canUndo && depth < 200) { ed.undo(); depth++; } });
ok("el historial se vacio", !ed.state.history.canUndo && depth > 3, `${depth} pasos`);
noThrow("rehacer hasta arriba", () => { let n = 0; while (ed.state.history.canRedo && n < 200) { ed.redo(); n++; } });
ok("rehacer restaura el trabajo", ed.state.items > 0, `${ed.state.items} items`);
const itemsBefore = ed.state.items;
noThrow("documento nuevo", () => newDocument(ed));
ok("el documento nuevo esta vacio", ed.state.items === 0, `${itemsBefore} -> ${ed.state.items}`);
ok("el lienzo nuevo no resucita lo anterior", restoreAutosave(ed) === false && ed.state.items === 0, `${ed.state.items} items`);

// Ronda limpia de autoguardado: dibujar, guardar, vaciar, restaurar.
ed.setTool("brush");
send("pointerdown", 150, 150, 0.4);
for (let i = 1; i <= 15; i++) send("pointermove", 150 + i * 7, 150 + i * 5, 0.5);
send("pointerup", 255, 225, 0);
const savedItems = ed.state.items;
autosave(ed);
ed.clearAll();
ok("se recupera el autoguardado", restoreAutosave(ed) && ed.state.items === savedItems, `${ed.state.items} vs ${savedItems}`);


// --- Limpiezas ---
noThrow("limpiar tinta", () => ed.clearInk());
noThrow("limpiar materia", () => ed.clearMatter());
noThrow("limpiar todo", () => ed.clearAll());
ok("el lienzo quedo vacio", ed.state.items === 0 && ed.state.bodies === 0);

// --- Popovers y selector de color (se construyen al hacer clic) ---
const buttons = flat.filter((n) => n.tagName === "BUTTON");
let opened = 0;
let popErr = "";
for (const b of buttons) {
  for (const [node, t, fn] of globalThis.__listeners) {
    if (node === b && (t === "click" || t === "pointerdown")) {
      try {
        fn({ type: t, target: b, currentTarget: b, clientX: 40, clientY: 40, button: 0, buttons: 1, preventDefault() {}, stopPropagation() {} });
        opened++;
      } catch (e) { if (!popErr) popErr = `${b.className}: ${(e as Error).message}`; }
    }
  }
}
ok("todos los botones responden al clic", popErr === "", popErr || `${opened} activaciones`);

// --- Entradas del inspector (sliders, selects, switches) ---
const inputs = flat.filter((n) => n.tagName === "INPUT" || n.tagName === "SELECT");
let inputErr = "";
let fired = 0;
for (const i of inputs) {
  for (const [node, t, fn] of globalThis.__listeners) {
    if (node === i && (t === "input" || t === "change")) {
      try {
        if (i.type === "range") i.value = String((Number(i.min || 0) + Number(i.max || 1)) / 2);
        else if (i.type === "checkbox") i.checked = !i.checked;
        fn({ type: t, target: i, currentTarget: i, preventDefault() {}, stopPropagation() {} });
        fired++;
      } catch (e) { if (!inputErr) inputErr = `${i.className || i.tagName}: ${(e as Error).message}`; }
    }
  }
}
ok("todos los controles aceptan cambios", inputErr === "", inputErr || `${fired} eventos`);

// --- Paletas ---
noThrow("cambiar de paleta", () => { for (let i = 0; i < 6; i++) ed.setPalette(i); });

setTimeout(() => {
  noThrow("dispose", () => app.dispose());
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n${out.length - fails.length}/${out.length} en verde`);
  console.log(globalThis.__failed ? "RESULTADO: HAY FALLOS" : "RESULTADO: TODO EN VERDE");
  if (globalThis.__failed) process.exitCode = 1;
}, 80);
