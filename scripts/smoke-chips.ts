/**
 * Prueba de los trozos arrancables (radial-chips) en modo aro y modo tira.
 *
 * El modo tira ya reincidio dos veces en el mismo defecto: al enderezar un aro,
 * la posicion A LO LARGO del eje se perdia y todas las baldosas de un carril se
 * dibujaban en el mismo punto (traslape). Estas comprobaciones fijan ese
 * contrato para que no vuelva:
 *
 *  - las cajas de las baldosas de un carril NO se solapan y van en fila;
 *  - estan en el orden angular del aro que se enderezo, y el regreso a aro
 *    conserva los angulos;
 *  - los carriles son paralelos y no se pisan entre si;
 *  - en tira vertical la caja es alta (el largo va en Y), no ancha.
 *
 * No comprueba pixeles (no hay con que pintarlos): comprueba la geometria que
 * decide donde cae cada baldosa, que es justo lo que se rompia.
 */

import { App } from "../src/ui/app";
import { buildRoot } from "../src/ui/hotbox/menu";

declare const globalThis: any;
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
const chips: any = (app as any).radialChips;
const ed: any = (app as any).editor;

/** Camino de indice al primer nodo `kind:"dial"` del arbol del hotbox. */
function findDialPath(): { path: number[]; id: string } | null {
  const walk = (nodes: any[], path: number[]): { path: number[]; id: string } | null => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind === "dial") return { path: [...path, i], id: n.id };
      if (n.kind === "submenu") {
        const hit = walk(n.children ?? [], [...path, i]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(buildRoot(ed, ed.state, {} as any), []);
}

/** Crea `n` trozos contiguos del mismo aro (angulos consecutivos, mismo grupo).
    El grupo y el centro se pasan por parametro para que cada caso quede AISLADO:
    dos aros que compartieran `groupId` se pisarian al renormalizar carriles. */
function spawnRing(
  n: number,
  angle0 = -Math.PI / 2,
  opts: { groupId?: string; cx?: number; cy?: number; level?: number } = {},
): any[] {
  const dial = findDialPath();
  if (!dial) throw new Error("no hay ningun dial en el arbol del hotbox");
  const gid = opts.groupId ?? `grp-${(ringSeq += 1)}`;
  const cx = opts.cx ?? 400;
  const cy = opts.cy ?? 400;
  const created: any[] = [];
  for (let i = 0; i < n; i++) {
    const amid = angle0 + i * 0.5;
    const CHIP_ANGLE = 0.82;
    const mid = 72 + 46 / 2;
    chips.spawn({
      node: { kind: "dial", id: dial.id, label: "d", min: 0, max: 1, value: 0.5, onInput: () => {} },
      path: dial.path,
      ringLevel: 1,
      angleWidth: CHIP_ANGLE,
      angleMid: amid,
      innerR: 72,
      outerR: 72 + 46,
      viewport: { x: cx + Math.cos(amid) * mid, y: cy + Math.sin(amid) * mid },
    });
    const last = [...chips.chips.values()].pop();
    if (last) created.push(last);
  }
  // Todos al mismo grupo/nivel y al centro compartido, como si los hubieran pegado.
  for (const c of created) {
    c.groupId = gid;
    c.level = opts.level ?? 0;
    c.adoptCenter(cx, cy);
  }
  chips.refreshHandles();
  return created;
}
let ringSeq = 0;

// ---------------------------------------------------------------- aro → tira

const ring = spawnRing(3);
ok("se crean los trozos del aro", ring.length === 3, `${ring.length} trozos`);

// El orden angular debe fijar el orden en la fila.
chips.cycleRingMode(ring[0]);

const centers = ring.map((c) => c.visualCenter());
const alongs = centers.map((p) => p.x);
ok(
  "en tira las baldosas se reparten a lo largo del eje (no todas en el centro)",
  new Set(alongs.map((v) => Math.round(v))).size === ring.length,
  alongs.map((v) => v.toFixed(0)).join(", "),
);
// El orden debe ser ESTRICTAMENTE el de los angulos del aro: si todos cayeran en
// el mismo punto, la comprobacion de monotonia pasaria sola, asi que se exige
// ademas que haya separacion real entre consecutivos.
const strictlyOrdered =
  (alongs.every((v, i) => i === 0 || v > alongs[i - 1]) ||
    alongs.every((v, i) => i === 0 || v < alongs[i - 1])) &&
  alongs.every((v, i) => i === 0 || Math.abs(v - alongs[i - 1]) > 1);
ok(
  "el orden en la fila es el orden angular del aro",
  strictlyOrdered,
  "angulos → " + alongs.map((v) => v.toFixed(0)).join(", "),
);
// Y el signo del avance debe seguir al de los angulos (el aro se desenrolla, no
// se voltea): angulos crecientes → posiciones crecientes.
const anglesAsc = ring.every((c: any, i: number) => i === 0 || c.a0 >= ring[i - 1].a0);
const alongsAsc = alongs.every((v, i) => i === 0 || v >= alongs[i - 1]);
ok("el aro se desenrolla sin voltearse", anglesAsc === alongsAsc, `angulos ${anglesAsc ? "↑" : "↓"} → fila ${alongsAsc ? "↑" : "↓"}`);

// Ninguna caja debe solaparse con la siguiente (hueco >= CHIP_GAP_PX - epsilon).
const spans = ring
  .map((c) => ({ c, p: c.visualCenter(), half: c.halfLen }))
  .sort((a, b) => a.p.x - b.p.x);
let minGap = Infinity;
for (let i = 1; i < spans.length; i++) {
  const gap = spans[i].p.x - spans[i].half - (spans[i - 1].p.x + spans[i - 1].half);
  minGap = Math.min(minGap, gap);
}
ok("las baldosas contiguas no se solapan", minGap >= 6.9, `hueco minimo ${minGap.toFixed(2)}px`);
ok("el hueco es el del menu (~7px)", Math.abs(minGap - 7) < 0.6, `${minGap.toFixed(2)}px`);

// El conjunto queda centrado en el centro del grupo.
const mid = (Math.min(...alongs) + Math.max(...alongs)) / 2;
ok("la fila queda centrada en el centro del grupo", Math.abs(mid - 400) < 1.0, `${mid.toFixed(2)} vs 400`);

// ------------------------------------------------------------------ vertical

chips.cycleRingMode(ring[0]); // → tira vertical
const ys = ring.map((c) => Math.round(c.visualCenter().y));
ok(
  "en tira vertical las baldosas se reparten en Y",
  new Set(ys).size === ring.length,
  ys.join(", "),
);
for (const c of ring) {
  const w = Number(c.svg.getAttribute("width"));
  const h = Number(c.svg.getAttribute("height"));
  ok(
    `la caja vertical es alta, no ancha (${w}x${h})`,
    h > w,
    "el largo va en Y",
  );
  break; // una basta: todos los trozos miden lo mismo
}

// ------------------------------------------------------------- vuelta a aro

const anglesBefore = ring.map((c) => [c.a0, c.a1]);
chips.cycleRingMode(ring[0]); // vertical → aro
ok(
  "el regreso a aro conserva los angulos",
  ring.every((c, i) => Math.abs(c.a0 - anglesBefore[i][0]) < 1e-9 && Math.abs(c.a1 - anglesBefore[i][1]) < 1e-9),
  "el aro vuelve exacto",
);
ok(
  "de vuelta en aro, todos comparten el centro del grupo",
  ring.every((c) => c.visualCenter().x === 400 && c.visualCenter().y === 400),
  "centro compartido",
);

// ------------------------------------------------------------------ carriles

const lanes = spawnRing(2, 0, { groupId: ring[0].groupId, level: 1 });
chips.cycleRingMode(lanes[0]);
chips.cycleRingMode(ring[0]); // el aro de 3, otra vez a tira horizontal

const laneY = new Set([
  ...ring.map((c) => Math.round(c.visualCenter().y)),
  ...lanes.map((c) => Math.round(c.visualCenter().y)),
]);
ok("los carriles son paralelos (cada nivel a su altura)", laneY.size === 2, [...laneY].join(", "));

const dy = Math.abs(ring[0].visualCenter().y - lanes[0].visualCenter().y);
ok("los carriles estan separados una banda + hueco", Math.abs(dy - (46 + 14)) < 1.0, `${dy.toFixed(2)}px`);

// -------------------------------------------------- baldosas de anchos distintos
// Un aro real puede tener trozos de anchos distintos (cada sector mide lo que
// mida su arco). La fila debe empaquetarlos por su longitud REAL, no por una
// medida comun: si se usara el ancho de una sola, las largas se pisarian.

{
  const mixed: any[] = [];
  for (const w of [0.4, 1.1, 0.7]) {
    chips.spawn({
      node: { kind: "dial", id: "mix", label: "m", min: 0, max: 1, value: 0.5, onInput: () => {} },
      path: findDialPath()!.path,
      ringLevel: 1,
      angleWidth: w,
      angleMid: -Math.PI / 2 + mixed.length * 1.3,
      innerR: 72,
      outerR: 72 + 46,
      viewport: { x: 700 + mixed.length * 60, y: 700 },
    });
    const c = [...chips.chips.values()].pop() as any;
    c.groupId = "grp-mix";
    c.level = 0;
    c.adoptCenter(700, 700);
    c.a0 = -Math.PI / 2 - w / 2 + mixed.length * 0.5;
    c.a1 = c.a0 + w;
    mixed.push(c);
  }
  chips.refreshHandles();
  chips.cycleRingMode(mixed[0]);

  const sizes = mixed.map((c) => 2 * c.halfLen);
  ok(
    "las baldosas de un carril conservan su largo propio (arcos distintos → largos distintos)",
    new Set(sizes.map((s) => Math.round(s))).size > 1,
    sizes.map((s) => s.toFixed(0)).join(", "),
  );

  const boxes = mixed
    .map((c) => ({ p: c.visualCenter(), half: c.halfLen }))
    .sort((a, b) => a.p.x - b.p.x);
  let gap = Infinity;
  for (let i = 1; i < boxes.length; i++) {
    gap = Math.min(gap, boxes[i].p.x - boxes[i].half - (boxes[i - 1].p.x + boxes[i - 1].half));
  }
  ok("tambien sin solaparse con largos distintos", gap >= 6.9, `hueco minimo ${gap.toFixed(2)}px`);

  const mid = (Math.min(...boxes.map((b) => b.p.x)) + Math.max(...boxes.map((b) => b.p.x))) / 2;
  ok("la fila de largos distintos queda centrada", Math.abs(mid - 700) < 1.0, `${mid.toFixed(2)} vs 700`);

  for (const c of mixed) c.destroy();
  for (const c of mixed) chips.chips.delete(c.id);
}

// ------------------------------------------------- encadenar por los lados
// Lo que pidio el usuario: en modo recto no solo se apilan carriles
// (perpendicular), tambien se encadenan trozos POR LOS LADOS, a lo largo del eje.
// Se suelta una tira nueva justo al lado de la fila existente y debe quedar
// CONTIGUA a ella, en el mismo carril, no en un carril nuevo ni encima.

const chainGroup = ring[0].groupId;
const chainHost = [...chips.chips.values()].find((c: any) => c.groupId === chainGroup && c.mode === "strip");
if (chainHost) {
  const before = [...chips.chips.values()].filter((c: any) => c.groupId === chainGroup && c.mode === "strip");
  const laneCountBefore = new Set(before.map((c: any) => c.level)).size;
  const hostCenter = chainHost.visualCenter();
  const hostLevel = chainHost.level;

  // Una tira suelta (grupo propio) que se suelta justo al lado, sobre el mismo carril.
  chips.spawn({
    node: { kind: "dial", id: "chain", label: "c", min: 0, max: 1, value: 0.5, onInput: () => {} },
    path: findDialPath()!.path,
    ringLevel: 1,
    angleWidth: 0.82,
    angleMid: -Math.PI / 2,
    innerR: 72,
    outerR: 72 + 46,
    viewport: { x: hostCenter.x, y: hostCenter.y },
  });
  const fresh = [...chips.chips.values()].pop() as any;
  fresh.mode = "strip";
  fresh.axis = "h";
  // Se coloca a un lado (a lo largo del eje), en el mismo carril que el host.
  fresh.adoptCenter(chainHost.cx, chainHost.cy);
  fresh.setLevel(hostLevel);
  const side = hostCenter.x + 2 * chainHost.halfLen + 20;
  const off = { x: side - fresh.visualCenter().x, y: 0 };
  fresh.adoptCenter(fresh.cx + off.x, fresh.cy + off.y);
  fresh.render();

  chips.trySnap(fresh);

  const after = [...chips.chips.values()].filter((c: any) => c.groupId === fresh.groupId && c.mode === "strip");
  const laneCountAfter = new Set(after.map((c: any) => c.level)).size;
  ok(
    "una tira soltada al lado se une al mismo grupo",
    fresh.groupId === chainHost.groupId,
    `grupo ${fresh.groupId === chainHost.groupId ? "compartido" : "distinto"}`,
  );
  ok(
    "se encadena por el lado (mismo carril), no abre un carril nuevo",
    fresh.level === hostLevel && laneCountAfter <= laneCountBefore,
    `nivel ${fresh.level} (host ${hostLevel}), carriles ${laneCountBefore} → ${laneCountAfter}`,
  );
  // Y las baldosas del carril siguen sin solaparse tras encadenar.
  const laneChips = [...chips.chips.values()]
    .filter((c: any) => c.groupId === chainHost.groupId && c.level === hostLevel && c.mode === "strip")
    .map((c: any) => ({ p: c.visualCenter(), half: c.halfLen }))
    .sort((a, b) => a.p.x - b.p.x);
  let chainGap = Infinity;
  for (let i = 1; i < laneChips.length; i++) {
    chainGap = Math.min(chainGap, laneChips[i].p.x - laneChips[i].half - (laneChips[i - 1].p.x + laneChips[i - 1].half));
  }
  ok(
    "tras encadenar, las baldosas del carril siguen sin solaparse",
    chainGap >= 6.9,
    `hueco minimo ${chainGap.toFixed(2)}px, ${laneChips.length} baldosas`,
  );
  // Contigüidad real: la tira nueva debe quedar pegada a OTRA del carril, con el
// mismo hueco que separa el resto (la fila se re-centra al crecer, asi que no vale
// medir contra la posicion de antes: lo que importa es que quede encadenada).
const freshC = fresh.visualCenter();
let nearestGap = Infinity;
for (const o of laneChips) {
  if (Math.abs(o.p.y - freshC.y) > 1) continue; // otro carril
  if (Math.hypot(o.p.x - freshC.x, o.p.y - freshC.y) < 1e-6) continue; // ella misma
  const gap = Math.abs(o.p.x - freshC.x) - o.half - fresh.halfLen;
  nearestGap = Math.min(nearestGap, Math.abs(gap));
}
ok(
  "la tira encadenada quedo contigua a un vecino del carril",
  Math.abs(nearestGap - 7) < 0.6,
  `hueco al vecino mas cercano ${nearestGap.toFixed(2)}px`,
);
}

// ------------------------------------------------------------ persistencia

const recs = [...chips.chips.values()].map((c: any) => c.toRecord());
ok("los registros guardan el modo", recs.every((r: any) => r.mode === "ring" || r.mode === "strip"));
ok(
  "los registros de tira guardan el orden en el carril",
  recs.filter((r: any) => r.mode === "strip").every((r: any) => Number.isFinite(r.slot)),
);

// Ida y vuelta por localStorage: al recargar, las tiras deben reaparecer EN FILA
// (no apiladas) y en el mismo orden. Es el otro camino por el que el traslape
// podia volver, porque la posicion no se guarda: se reconstruye del orden.
{
  const stripRecs = recs.filter((r: any) => r.mode === "strip");
  if (stripRecs.length > 0) {
    const before = stripRecs
      .map((r: any) => r.slot)
      .sort((a: number, b: number) => a - b);
    // Fuerza el guardado y rehace la capa desde el almacen.
    chips.save();
    const raw = JSON.parse(globalThis.localStorage.getItem("zence.radialChips.v3"));
    const restoredSlots = raw
      .filter((r: any) => r.mode === "strip")
      .map((r: any) => r.slot)
      .sort((a: number, b: number) => a - b);
    ok(
      "el orden en el carril sobrevive al guardado",
      JSON.stringify(before) === JSON.stringify(restoredSlots),
      `slots ${restoredSlots.join(", ")}`,
    );
    // Los slots son ordinales POR CARRIL (grupo+ nivel + eje), no globales: dos
    // carriles distintos empiezan los dos en 0. Lo que debe cumplirse es que dentro
    // de cada carril sean contiguos desde 0, sin huecos.
    const byLane = new Map<string, number[]>();
    for (const r of raw.filter((x: any) => x.mode === "strip")) {
      const key = `${r.groupId}|${r.level}|${r.axis}`;
      byLane.set(key, [...(byLane.get(key) ?? []), r.slot]);
    }
    const badLanes: string[] = [];
    for (const [key, slots] of byLane) {
      const sortedLane = [...slots].sort((a, b) => a - b);
      if (!sortedLane.every((s, i) => s === i)) badLanes.push(`${key}: [${sortedLane.join(",")}]`);
    }
    ok(
      "cada carril guarda ordinales contiguos desde 0",
      badLanes.length === 0,
      badLanes.length ? badLanes.join(" · ") : `${byLane.size} carriles`,
    );
  }
}

// ------------------------------------------------ el gesto: doble toque en MOVER
// El cambio de forma ya no tiene botón: lo lleva un doble toque sobre el puntico de
// MOVER (en cada chip) y sobre el MOVER del núcleo (en todo el grupo). Se comprueba
// el gesto de verdad, despachando los `pointerdown` al botón, con marcas de tiempo
// explícitas para que sea determinista.
{
  /** Busca el primer descendiente con esa clase. */
  const byClass = (root: any, cls: string): any | null => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n?.classList?.contains?.(cls)) return n;
      for (const c of n?.childNodes ?? []) if (c?.classList) stack.push(c);
    }
    return null;
  };
  /** Dispara un `pointerdown` al elemento, con la marca de tiempo dada. */
  const tapDot = (node: any, t: number): void => {
    const ev = new (globalThis.PointerEvent)("pointerdown", { clientX: 0, clientY: 0, timeStamp: t });
    for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointerdown" && n === node) fn(ev);
  };
  /** Suelta el puntero (cancela el armado del long-press y el arrastre). */
  const release = (): void => {
    const ev = new (globalThis.PointerEvent)("pointerup", { clientX: 0, clientY: 0 });
    for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointerup" && n === globalThis.window) fn(ev);
  };

  // Un grupo aislado de DOS niveles (cada uno con dos trozos), en su propio centro:
  // así el chip tiene aro propio y ademas hay núcleo, y no se toca nada de lo anterior.
  const gestId = "grp-gesto";
  const gest = spawnRing(2, -Math.PI / 2, { groupId: gestId, cx: 1000, cy: 400, level: 0 });
  spawnRing(2, -Math.PI / 2, { groupId: gestId, cx: 1000, cy: 400, level: 1 });
  chips.refreshHandles();
  const dot = byClass(gest[0].el, "rm-chip-move");
  ok("el chip expone su puntico de MOVER", !!dot, "sin botón de modo aparte");

  const beforeMode = gest[0].mode;
  tapDot(dot, 5000);
  release();
  ok("un toque suelto NO cambia la forma", gest[0].mode === beforeMode, `sigue en ${gest[0].mode}`);

  tapDot(dot, 5100); // segundo toque dentro de la ventana → doble toque
  release();
  ok(
    "el doble toque pasa de aro a tira horizontal",
    gest[0].mode === "strip" && gest[0].axis === "h",
    `${gest[0].mode}/${gest[0].axis}`,
  );
  ok(
    "el cambio de forma es del ARO entero (los dos trozos, no solo el tocado)",
    gest[1].mode === "strip" && gest[1].axis === "h",
    `${gest[1].mode}/${gest[1].axis}`,
  );

  // Y ahora el aro enderezado debe quedar EN FILA: el gesto, el cambio de modo y el
  // reparto de carriles encadenan sin solapes.
  const gs = gest
    .map((c: any) => ({ p: c.visualCenter(), half: c.halfLen }))
    .sort((a, b) => a.p.x - b.p.x);
  const gGap = gs[1].p.x - gs[1].half - (gs[0].p.x + gs[0].half);
  ok("tras el doble toque el aro queda enderezado en fila", gGap >= 6.9, `hueco ${gGap.toFixed(2)}px`);

  tapDot(dot, 6000);
  release();
  tapDot(dot, 6100);
  release();
  ok(
    "el siguiente doble toque pasa a tira vertical",
    gest[0].mode === "strip" && gest[0].axis === "v",
    `${gest[0].mode}/${gest[0].axis}`,
  );

  tapDot(dot, 7000);
  release();
  tapDot(dot, 7100);
  release();
  ok("y el siguiente vuelve a aro", gest[0].mode === "ring", `${gest[0].mode}`);

  // El doble toque NO debe romper los otros gestos de MOVER: arrastrar sigue
  // moviendo el aro, y sin desplazamiento no debe re-pegar nada (lo que sacaría el
  // nivel del grupo sin querer).
  {
    const solo = spawnRing(1, -Math.PI / 2, { groupId: "grp-arrastre", cx: 1200, cy: 700 });
    const sdot = byClass(solo[0].el, "rm-chip-move");
    const gidBefore = solo[0].groupId;
    const x0 = solo[0].cx;
    const y0 = solo[0].cy;

    // Toque quieto (primera mitad de un doble toque): no debe mover ni desenganchar.
    tapDot(sdot, 30000);
    release();
    ok(
      "un toque quieto no desplaza el aro",
      solo[0].cx === x0 && solo[0].cy === y0,
      `(${solo[0].cx}, ${solo[0].cy})`,
    );
    ok("un toque quieto no desengancha el aro de su grupo", solo[0].groupId === gidBefore, solo[0].groupId);

    // Ahora sí: arrastre real por encima de la tolerancia.
    const moveTo = (x: number, y: number): void => {
      const ev = new (globalThis.PointerEvent)("pointermove", { clientX: x, clientY: y });
      for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointermove" && n === globalThis.window) fn(ev);
    };
    const down = (x: number, y: number, t: number): void => {
      const ev = new (globalThis.PointerEvent)("pointerdown", { clientX: x, clientY: y, timeStamp: t });
      for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointerdown" && n === sdot) fn(ev);
    };
    down(0, 0, 40000);
    moveTo(60, 30);
    release();
    ok(
      "arrastrar por encima de la tolerancia sí mueve el aro",
      Math.abs(solo[0].cx - (x0 + 60)) < 1 && Math.abs(solo[0].cy - (y0 + 30)) < 1,
      `(${solo[0].cx.toFixed(0)}, ${solo[0].cy.toFixed(0)})`,
    );
    ok("y esa vez sí se re-pegó (pasó por trySnap)", solo[0].mode === "ring", `sigue en ${solo[0].mode}`);
  }

  // El núcleo lleva el mismo gesto para TODO el grupo.
  const hub = chips.hubs.get(gestId);
  ok("el grupo de dos niveles tiene núcleo", !!hub, hub ? "presente" : "(ausente)");
  if (hub) {
    const hubMove = byClass(hub.el, "rm-hub-move");
    ok("el núcleo expone su MOVER", !!hubMove, "sin botón de modo aparte");
    const members = chips.groupMembers(gestId);
    const beforeLayout = members[0].mode + "/" + members[0].axis;
    tapDot(hubMove, 20000);
    release();
    ok("un toque suelto en el núcleo no cambia el grupo", members[0].mode + "/" + members[0].axis === beforeLayout);
    tapDot(hubMove, 20100);
    release();
    const after = members.map((m: any) => m.mode + "/" + m.axis);
    ok(
      "el doble toque del núcleo cambia TODO el grupo a la vez",
      new Set(after).size === 1 && after[0] !== beforeLayout,
      `${beforeLayout} → ${after[0]}`,
    );
    ok(
      "el núcleo ya no tiene tercer botón (dos mitades)",
      hub.el.childNodes.filter((n: any) => n.classList?.contains?.("rm-hub-half")).length === 2,
      `${hub.el.childNodes.filter((n: any) => n.classList?.contains?.("rm-hub-half")).length} mitades`,
    );
  }
}

setTimeout(() => {
  noThrow("dispose", () => app.dispose());
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n${out.length - fails.length}/${out.length} en verde`);
  console.log(globalThis.__failed ? "RESULTADO: HAY FALLOS" : "RESULTADO: TODO EN VERDE");
  if (globalThis.__failed) process.exitCode = 1;
}, 80);