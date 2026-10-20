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

import chipsCss from "../src/styles-radial-chips.css?raw";
import { App } from "../src/ui/app";
import { buildRoot } from "../src/ui/hotbox/menu";

declare const globalThis: any;
declare const process: { exitCode?: number; cwd(): string };

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

// En los CARRILES el tamaño no crece con el nivel: una tira del carril 1 mide lo mismo
// que una del carril 0. En el aro la banda sí crece con el nivel (es lo que hace el
// anillo), pero al enderezar esa diferencia tiene que desaparecer: el largo se mide
// contra un radio de referencia fijo, no contra el `mid` del nivel.
{
  const byLevel = new Map<number, number>();
  for (const c of [...ring, ...lanes]) byLevel.set(c.level, 2 * c.halfLen);
  const lens = [...byLevel.values()];
  ok(
    "en tira todos los carriles miden lo mismo (el tamaño no crece por nivel)",
    new Set(lens.map((l) => Math.round(l))).size === 1,
    `nivel 0: ${lens[0].toFixed(1)}px, nivel 1: ${(lens[1] ?? lens[0]).toFixed(1)}px`,
  );

  // Y no depende del carril en que esté: subir un trozo de nivel no lo estira.
  const probe = lanes[0];
  const before = 2 * probe.halfLen;
  probe.setLevel(0);
  const atLevel0 = 2 * probe.halfLen;
  probe.setLevel(1);
  ok(
    "el largo de un trozo no cambia al moverlo de carril",
    Math.abs(atLevel0 - before) < 1e-9,
    `${before.toFixed(1)}px → ${atLevel0.toFixed(1)}px`,
  );
}

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

// -------------------------------------------------- forma del núcleo (hub)
// La forma del núcleo sigue al modo del grupo: círculo de materia con anillos (que
// ondula) y cuadrado de esquinas redondeadas con tiras (que también tiembla). En los
// dos casos SOLO se mueve el contorno: si la animación tocara width/height, los dos
// botones de dentro (hijos flex) se recolocarían y parecería que se mueven solos.
{
  // El paquete de la suite vive en node_modules/.drawi-smoke, asi que la CSS del
  // proyecto se trae con el import `?raw` de Vite (resuelto al empaquetar) en vez de
  // leerla con node:fs, que arrastraria los tipos de Node a un proyecto sin ellos.
  const css = chipsCss;

  // Saca el cuerpo de un @keyframes por nombre, contando llaves para no cortar en la
  // primera que aparezca dentro.
  const keyframesBody = (name: string): string | null => {
    const at = css.indexOf(`@keyframes ${name}`);
    if (at < 0) return null;
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) return css.slice(open + 1, i);
      }
    }
    return null;
  };

  const circle = keyframesBody("rm-hub-blob");
  const square = keyframesBody("rm-hub-square");

  ok("el círculo del núcleo tiene su ondulado", !!circle, circle ? "rm-hub-blob presente" : "(ausente)");
  ok("el cuadrado del núcleo tiene su temblor de borde", !!square, square ? "rm-hub-square presente" : "(ausente)");

  // El círculo es el de siempre: solo radios orbitando el 50%, sin tocar la caja.
  ok(
    "el ondulado del círculo solo mueve el radio",
    !!circle && !/\b(width|height)\s*:/.test(circle) && /border-radius/.test(circle),
    circle ? "solo border-radius" : "(sin cuerpo)",
  );

  // La clave: el cuadrado mueve las esquinas y NO la caja. Animar el tamaño
  // recolocaría los botones de dentro (que es el fallo que se vio).
  ok(
    "el temblor del cuadrado NO toca la caja (los botones no se mueven)",
    !!square && !/\b(width|height)\s*:/.test(square),
    square ? (/\b(width|height)\s*:/.test(square) ? "anima width/height" : "solo el contorno") : "(sin cuerpo)",
  );
  ok(
    "y mueve las cuatro esquinas con desfase (no un radio uniforme)",
    !!square &&
      /border-radius:\s*\d+px\s+\d+px\s+\d+px\s+\d+px\s*;/.test(square) &&
      new Set((square.match(/border-radius:\s*([^;]+);/g) ?? []).map((d) => d.trim())).size > 2,
    square ? `${new Set((square.match(/border-radius:\s*([^;]+);/g) ?? []).map((d) => d.trim())).size} paradas distintas` : "(sin cuerpo)",
  );

  // El cuadrado también tiene que quedarse quieto con "reducir movimiento", y el
  // círculo conservar su forma redonda (que ya traía de antes).
  const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
  ok(
    "con reducir-movimiento el cuadrado se queda quieto y cuadrado",
    /\.rm-hub\.is-block\s*\{[^}]*animation:\s*none/.test(reduced) && /\.rm-hub\.is-block\s*\{[^}]*border-radius:\s*16px/.test(reduced),
    "sin temblor, cuadrado base",
  );
  ok(
    "y el círculo conserva su forma redonda",
    /\.rm-hub\s*\{[^}]*border-radius:\s*50%/.test(reduced),
    "redondo",
  );
}

// ------------------------------------------- sacar UN trozo de su grupo (Ctrl+click)
// Los botones de mover sacan el ARO/NIVEL entero, así que un trozo en medio de una
// fila de cuatro no tenía ninguna vía para salir solo. Ctrl+click lo separa.
{
  const detId = "grp-detach";
  const row = spawnRing(4, 0, { groupId: detId, cx: 1800, cy: 900, level: 0 });
  spawnRing(2, 0, { groupId: detId, cx: 1800, cy: 900, level: 1 });
  chips.cycleGroupMode(detId); // todo el grupo a tiras horizontales
  chips.refreshHandles();
  ok("el grupo de cuatro pasó a una fila", row.every((c: any) => c.mode === "strip"), `${row[0].mode}/${row[0].axis}`);

  // El del MEDIO (no un extremo): es el caso que no tenía salida.
  const victim = row[1];
  const beforeAt = victim.visualCenter();
  const beforeGroup = victim.groupId;

  const ctrlDown = (chip: any): void => {
    const ev = new (globalThis.PointerEvent)("pointerdown", {
      clientX: beforeAt.x, clientY: beforeAt.y, ctrlKey: true,
    });
    const sector = chip.sectorPath as any;
    for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointerdown" && n === sector) fn(ev);
  };
  ctrlDown(victim);

  ok("Ctrl+click saca el trozo a un grupo propio", victim.groupId !== beforeGroup, victim.groupId);
  ok("y el grupo viejo conserva el resto (4 de la fila + 2 del otro carril)", chips.groupMembers(beforeGroup).length === 5, `${chips.groupMembers(beforeGroup).length} (eran 6)`);
  ok("el suelto queda en su propio nivel 0", victim.level === 0, `nivel ${victim.level}`);

  // Lo importante: NO salta. Se queda exactamente donde el usuario lo veía.
  const afterAt = victim.visualCenter();
  ok(
    "el trozo suelto se queda donde estaba (no salta)",
    Math.abs(afterAt.x - beforeAt.x) < 1 && Math.abs(afterAt.y - beforeAt.y) < 1,
    `(${beforeAt.x.toFixed(0)}, ${beforeAt.y.toFixed(0)}) → (${afterAt.x.toFixed(0)}, ${afterAt.y.toFixed(0)})`,
  );

  // Los que quedan se recompactan: no dejan hueco donde estaba el sacado.
  const rest = chips.groupMembers(beforeGroup).filter((c: any) => c.level === 0);
  const boxes = rest
    .map((c: any) => ({ p: c.visualCenter(), half: c.halfLen }))
    .sort((a: any, b: any) => a.p.x - b.p.x);
  let worst = Infinity;
  for (let i = 1; i < boxes.length; i++) {
    worst = Math.min(worst, boxes[i].p.x - boxes[i].half - (boxes[i - 1].p.x + boxes[i - 1].half));
  }
  ok("la fila restante se recompacta sin hueco", worst >= 6.9, `hueco mínimo ${worst.toFixed(2)}px`);

  // Ctrl+click sobre un trozo ya suelto no hace nada (no hay nada que separar).
  const aloneGroup = victim.groupId;
  ctrlDown(victim);
  ok("Ctrl+click sobre un trozo ya suelto no lo rompe", victim.groupId === aloneGroup, "sigue igual");
}

// -------------------------------------------------- anclaje del núcleo (hub)
// El núcleo debe quedar FUERA de las baldosas: con anillos en el hueco interior, y
// con tiras al lado del PRIMER carril (nivel 0). Antes se colocaba midiendo los
// CENTROS de las baldosas y restaba un margen fijo, así que caía dentro.
{
  const hubId = "grp-hub";
  const cx = 1500;
  const cy = 500;
  // Dos niveles: hace falta más de uno para que exista núcleo.
  spawnRing(2, -Math.PI / 2, { groupId: hubId, cx, cy, level: 0 });
  spawnRing(2, -Math.PI / 2, { groupId: hubId, cx, cy, level: 1 });
  chips.refreshHandles();

  const hub = chips.hubs.get(hubId);
  ok("el grupo de prueba tiene núcleo", !!hub, hub ? "presente" : "(ausente)");

  if (hub) {
    const hubBox = () => {
      const x = Number.parseFloat(hub.el.style.left);
      const y = Number.parseFloat(hub.el.style.top);
      const s = 76; // HUB_SIZE
      return { x0: x - s / 2, y0: y - s / 2, x1: x + s / 2, y1: y + s / 2 };
    };
    const members = chips.groupMembers(hubId);
    const overlaps = (): boolean => {
      const h = hubBox();
      for (const m of members) {
        const p = m.visualCenter();
        if (m.mode === "strip") {
          const bx = m.axis === "v"
            ? { x0: p.x - m.halfBand, y0: p.y - m.halfLen, x1: p.x + m.halfBand, y1: p.y + m.halfLen }
            : { x0: p.x - m.halfLen, y0: p.y - m.halfBand, x1: p.x + m.halfLen, y1: p.y + m.halfBand };
          if (h.x0 < bx.x1 && h.x1 > bx.x0 && h.y0 < bx.y1 && h.y1 > bx.y0) return true;
        }
      }
      return false;
    };

    // 1) En ARO vive en el centro del grupo.
    const h0 = hubBox();
    ok(
      "en aro el núcleo vive en el centro del grupo",
      Math.abs((h0.x0 + h0.x1) / 2 - cx) < 1 && Math.abs((h0.y0 + h0.y1) / 2 - cy) < 1,
      `(${((h0.x0 + h0.x1) / 2).toFixed(0)}, ${((h0.y0 + h0.y1) / 2).toFixed(0)})`,
    );
    // La forma sigue al modo: con anillos el círculo de materia de siempre (ondula),
    // con tiras el cuadrado de esquinas redondeadas (que también tiembla). El círculo
    // NO debe llevar `.is-block`.
    ok("en aro el núcleo conserva su forma circular", !hub.el.classList.contains("is-block"), "sin .is-block");

    // 2) En tira horizontal queda a la IZQUIERDA del primer nivel, sin taparlo.
    chips.cycleGroupMode(hubId);
    ok(
      "el grupo pasó a tiras horizontales",
      members.every((m: any) => m.mode === "strip" && m.axis === "h"),
      `${members[0].mode}/${members[0].axis}`,
    );
    ok("en tira el núcleo pasa a cuadrado redondeado", hub.el.classList.contains("is-block"), "con .is-block");
    ok("en tira horizontal el núcleo NO se solapa con las baldosas", !overlaps(), "fuera de la fila");
    const hH = hubBox();
    const leftmost = Math.min(
      ...members.filter((m: any) => m.mode === "strip").map((m: any) => m.visualCenter().x - m.halfLen),
    );
    ok(
      "y está a la izquierda del borde del primer nivel",
      hH.x1 <= leftmost + 0.5,
      `borde del núcleo ${hH.x1.toFixed(0)} ≤ fila ${leftmost.toFixed(0)}`,
    );

    // 3) En tira vertical queda ARRIBA del primer nivel, sin taparlo.
    chips.cycleGroupMode(hubId);
    ok(
      "el grupo pasó a tiras verticales",
      members.every((m: any) => m.mode === "strip" && m.axis === "v"),
      `${members[0].mode}/${members[0].axis}`,
    );
    ok("en tira vertical el núcleo NO se solapa con las baldosas", !overlaps(), "fuera de la columna");
    const hV = hubBox();
    const topmost = Math.min(
      ...members.filter((m: any) => m.mode === "strip").map((m: any) => m.visualCenter().y - m.halfLen),
    );
    ok(
      "y está por encima del borde del primer nivel",
      hV.y1 <= topmost + 0.5,
      `borde del núcleo ${hV.y1.toFixed(0)} ≤ columna ${topmost.toFixed(0)}`,
    );

    // 4) Al volver a aro, regresa al centro (no se queda pegado al lado) Y recupera el
    //    círculo: la forma es estado del grupo, no algo que se quede pegado.
    chips.cycleGroupMode(hubId);
    const hA = hubBox();
    ok(
      "al volver a aro el núcleo regresa al centro del grupo",
      Math.abs((hA.x0 + hA.x1) / 2 - cx) < 1 && Math.abs((hA.y0 + hA.y1) / 2 - cy) < 1,
      `(${((hA.x0 + hA.x1) / 2).toFixed(0)}, ${((hA.y0 + hA.y1) / 2).toFixed(0)})`,
    );
    ok("y recupera la forma circular al volver a aro", !hub.el.classList.contains("is-block"), "sin .is-block");

    // 5) Arrastrar el grupo: el núcleo acompaña conservando su sitio (antes saltaba
    //    al centro del grupo, metiéndose dentro de las baldosas).
    chips.cycleGroupMode(hubId); // → tiras horizontales
    const beforeHub = hubBox();
    const beforeCenter = members[0].cx;
    const moveTo = (x: number, y: number): void => {
      const ev = new (globalThis.PointerEvent)("pointermove", { clientX: x, clientY: y });
      for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointermove" && n === globalThis.window) fn(ev);
    };
    const hubMove = (() => {
      const stack = [hub.el];
      while (stack.length) {
        const n = stack.pop();
        if (n?.classList?.contains?.("rm-hub-move")) return n;
        for (const c of n?.childNodes ?? []) if (c?.classList) stack.push(c);
      }
      return null;
    })();
    if (hubMove) {
      const downEv = new (globalThis.PointerEvent)("pointerdown", { clientX: 0, clientY: 0, timeStamp: 90000 });
      for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointerdown" && n === hubMove) fn(downEv);
      moveTo(70, 40);

      // Se mide DURANTE el arrastre: es cuando el núcleo se salía de su sitio. Si se
      // mide tras soltar, un re-anclaje posterior lo devuelve a su sitio y el fallo
      // queda invisible (que es justo lo que pasaba).
      const during = hubBox();
      const duringCx = (during.x0 + during.x1) / 2;
      const beforeCx = (beforeHub.x0 + beforeHub.x1) / 2;
      ok(
        "mientras se arrastra, el núcleo acompaña al grupo (no salta al centro)",
        Math.abs(duringCx - (beforeCx + 70)) < 1.5,
        `Δx ${(duringCx - beforeCx).toFixed(0)} (esperado 70)`,
      );
      ok("mientras se arrastra, el núcleo no se mete en las baldosas", !overlaps(), "fuera de la fila");

      const upEv = new (globalThis.PointerEvent)("pointerup", { clientX: 70, clientY: 40 });
      for (const [n, ty, fn] of globalThis.__listeners) if (ty === "pointerup" && n === globalThis.window) fn(upEv);

      const afterHub = hubBox();
      ok(
        "tras soltar, el núcleo sigue acompañando al grupo",
        Math.abs((afterHub.x0 + afterHub.x1) / 2 - (beforeCx + 70)) < 1.5,
        `Δx ${(((afterHub.x0 + afterHub.x1) / 2) - beforeCx).toFixed(0)} (esperado 70)`,
      );
      ok("y el grupo también se movió", Math.abs(members[0].cx - (beforeCenter + 70)) < 1.5, `Δx ${(members[0].cx - beforeCenter).toFixed(0)}`);
      ok("tras arrastrar, el núcleo sigue sin solaparse", !overlaps(), "conserva su sitio al lado");
    }
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