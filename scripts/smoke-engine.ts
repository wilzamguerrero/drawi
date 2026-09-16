/**
 * Pruebas numericas del motor.
 *
 * Aqui no hay DOM: se comprueban las piezas que producen geometria y
 * movimiento, porque son las que fallan de forma silenciosa. Un contorno mal
 * cerrado, un filtro que introduce retraso o un colisionador de distinto tamano
 * que la forma dibujada no lanzan ninguna excepcion; simplemente hacen que la
 * aplicacion se sienta mal. Cada bloque mide la magnitud concreta que delata
 * ese fallo, para que la prueba diga "4.7px de retraso" y no solo "falla".
 */

import { OneEuroVec2 } from "../src/stroke/filter";
import { strokeOutline } from "../src/stroke/outline";
import { StrokeBuilder, type WorldSample } from "../src/stroke/builder";
import { DEFAULT_BRUSH, type BrushSettings, type StrokeDynamics } from "../src/stroke/types";
import { DEFAULT_SYMMETRY, symmetryTransforms, type SymmetryMode } from "../src/symmetry/symmetry";
import { DEFAULT_SHAPE, boundingRadius, colliderVerts, outlinePolygon, type ShapeDef, type ShapeKind } from "../src/physics/shapes";
import { sampleFieldDistance } from "../src/physics/sdf";
import { fieldContours } from "../src/physics/marching";
import { PhysicsWorld, createBody, type Body } from "../src/physics/world";

// El tsconfig usa `"types": []` a proposito: la aplicacion se compila contra el
// DOM y nada mas. Las suites si corren en Node, asi que declaran aqui lo unico
// que tocan de el en vez de arrastrar @types/node a todo el proyecto.
declare const process: { exitCode?: number };

const out: string[] = [];
let failed = false;
const ok = (label: string, cond: boolean, extra = ""): void => {
  out.push(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};
const f = (n: number, d = 3): string => n.toFixed(d);
const shape = (patch: Partial<ShapeDef>): ShapeDef => ({ ...DEFAULT_SHAPE, ...patch });

// ------------------------------------------------- trazo: forma y dinamicas --

/** Reproduce un gesto: recta larga con la presion subiendo de 0.1 a 0.95. */
const gesture = (dynamics: StrokeDynamics, speedPxPerMs: number): ReturnType<StrokeBuilder["finalize"]> => {
  const settings: BrushSettings = {
    ...DEFAULT_BRUSH,
    dynamics,
    size: 30,
    minRatio: 0.15,
    smoothing: 0.3,
    streamline: 0.2,
    // Afilado y ruido apagados: aqui se mide la dinamica, no los extremos.
    taperIn: 0,
    taperOut: 0,
    jitter: 0,
  };
  const b = new StrokeBuilder(settings);
  const step = 6;
  const n = 60;
  const at = (i: number): WorldSample => ({
    x: 100 + i * step,
    y: 300,
    pressure: 0.1 + (i / n) * 0.85,
    tilt: (i / n) * 60,
    azimuth: 0,
    t: (i * step) / speedPxPerMs,
    predicted: false,
  });
  b.begin(at(0), 12345);
  for (let i = 1; i <= n; i++) b.push([at(i)], true);
  return b.finalize();
};

{
  const pts = gesture("pressure", 0.5);
  ok("el trazo produce puntos", pts.length > 10, `${pts.length} puntos`);
  ok("los puntos son finitos", pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.r)));

  const r0 = pts[Math.floor(pts.length * 0.1)].r;
  const r1 = pts[Math.floor(pts.length * 0.9)].r;
  ok("la presion ensancha el trazo", r1 > r0 * 1.8, `radio ${f(r0, 2)} -> ${f(r1, 2)}`);

  const flat = gesture("constant", 0.5);
  const fr = flat.map((p) => p.r);
  const spread = Math.max(...fr) - Math.min(...fr);
  ok("el modo constante mantiene el ancho", spread < 0.5, `variacion ${f(spread, 3)}px`);

  // Velocidad: el mismo gesto lento y rapido debe dar anchos distintos.
  const slow = gesture("velocity", 0.05);
  const fast = gesture("velocity", 3);
  const avg = (a: { r: number }[]): number => a.reduce((s, p) => s + p.r, 0) / a.length;
  ok("la velocidad cambia el ancho", Math.abs(avg(slow) - avg(fast)) > 1,
     `lento ${f(avg(slow), 2)} vs rapido ${f(avg(fast), 2)}`);

  const tilted = gesture("tilt", 0.5);
  ok("la dinamica de inclinacion produce trazo", tilted.length > 10 && tilted.every((p) => p.r > 0));

  // El contorno cerrado a partir de esos puntos.
  const poly = strokeOutline(pts);
  ok("el contorno se cierra", poly.length > 20, `${poly.length} vertices`);
  ok("el contorno es finito", poly.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)));
  const splat = strokeOutline(pts, { splat: true });
  ok("el modificador splat da menos vertices", splat.length < poly.length, `${splat.length} vs ${poly.length}`);
}

// ------------------------------------------------------------------ filtro --

{
  // Convergencia: ante una entrada quieta el filtro debe posarse en ella.
  const conv = new OneEuroVec2(1.2, 0.02);
  let last = { x: 0, y: 0 };
  for (let i = 0; i < 200; i++) last = conv.filter(100, 50, 1 / 120);
  const err = Math.hypot(last.x - 100, last.y - 50);
  ok("el filtro converge al reposo", err < 0.5, `error ${f(err)}px`);

  // Temblor: una mano que vibra sobre una recta debe salir lisa.
  const tremor = new OneEuroVec2(1.2, 0.02);
  let maxDev = 0;
  for (let i = 0; i < 200; i++) {
    const r = tremor.filter(i * 2, 300 + Math.sin(i * 2.1) * 0.6, 1 / 60);
    if (i > 40) maxDev = Math.max(maxDev, Math.abs(r.y - 300));
  }
  ok("quita el temblor fino", maxDev < 0.3, `desviacion ${f(maxDev)}px`);

  // Retraso: en un trazo rapido y recto el retraso debe quedar acotado. Es
  // justo lo que una media movil no consigue, y la razon de usar One-Euro.
  const lagF = new OneEuroVec2(1.2, 0.02);
  let lag = 0;
  for (let i = 0; i < 200; i++) {
    const r = lagF.filter(i * 12, 0, 1 / 60);
    if (i > 40) lag = Math.max(lag, Math.abs(r.x - i * 12));
  }
  ok("el retraso esta acotado", lag < 12, `retraso maximo ${f(lag, 2)}px`);
}

// ---------------------------------------------------------------- simetria --

{
  const base = { ...DEFAULT_SYMMETRY, x: 400, y: 300, angle: 0.3, count: 6, visible: true };
  const expected: [SymmetryMode, number][] = [["none", 1], ["mirror", 2], ["radial", 6], ["kaleido", 12]];
  for (const [mode, n] of expected) {
    const ts = symmetryTransforms({ ...base, mode });
    ok(`simetria ${mode}: ${n} copias`, ts.length === n, `${ts.length}`);
    ok(`simetria ${mode}: matrices finitas`,
       ts.every((m) => [m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)));
  }
  // El origen movido debe ser punto fijo de todas las copias: si no lo es, el
  // eje "se escapa" al arrastrarlo, que es el fallo clasico de este codigo.
  const ts = symmetryTransforms({ ...base, mode: "kaleido" });
  const fixed = ts.every((m) => {
    const px = m.a * base.x + m.c * base.y + m.e;
    const py = m.b * base.x + m.d * base.y + m.f;
    return Math.hypot(px - base.x, py - base.y) < 1e-6;
  });
  ok("el origen movido es punto fijo", fixed);
}

// ------------------------------------------- coherencia entre SDF y outline --

{
  // El colisionador, el contorno que se exporta y el campo que se pinta tienen
  // que describir la MISMA forma. Si divergen, las piezas se detienen con un
  // hueco visible antes de fundirse.
  const kinds: ShapeKind[] = ["circle", "box", "ngon", "star", "capsule"];
  for (const kind of kinds) {
    const s = shape({ kind, size: 40, sides: 6, inner: 0.5, round: 4, aspect: 0.7 });
    const body = createBody(s, { x: 0, y: 0 });
    const poly = outlinePolygon(s);

    let maxErr = 0;
    for (const v of poly) maxErr = Math.max(maxErr, Math.abs(sampleFieldDistance(v.x, v.y, [body], 0)));
    ok(`SDF y contorno coinciden: ${kind}`, maxErr < 1.0, `error ${f(maxErr, 2)}px`);

    const rMax = Math.max(...poly.map((v) => Math.hypot(v.x, v.y)));
    ok(`el radio envolvente cubre ${kind}`, boundingRadius(s) >= rMax - 1e-6,
       `r=${f(boundingRadius(s), 1)} >= ${f(rMax, 1)}`);

    const verts = colliderVerts(s);
    if (verts) {
      const rColl = Math.max(...verts.map((v) => Math.hypot(v.x, v.y)));
      ok(`el colisionador cuadra con ${kind}`, Math.abs(rColl - rMax) < Math.max(2, rMax * 0.06),
         `colisionador ${f(rColl, 1)} vs dibujo ${f(rMax, 1)}`);
    } else {
      ok(`el colisionador cuadra con ${kind}`, Math.abs(boundingRadius(s) - rMax) < 1, "circulo");
    }
  }
}

// ----------------------------------------------------- fusion tipo metaball --

{
  const s = shape({ kind: "box", size: 30, round: 2, aspect: 1 });
  const pair = (gap: number): Body[] => [
    createBody(s, { x: -gap / 2, y: 0 }),
    createBody(s, { x: gap / 2, y: 0 }),
  ];
  const K = 60; // dentro del rango del deslizador de Fusion (0..160)
  const far = fieldContours(pair(260), K, { cell: 2 }).length;
  const near = fieldContours(pair(72), K, { cell: 2 }).length;
  ok("lejos son dos siluetas", far === 2, `${far} contornos`);
  ok("cerca se funden en una", near === 1, `${near} contorno`);

  // El puente debe ser materia de verdad: campo negativo en el punto medio.
  const close = pair(72);
  const mid = sampleFieldDistance(0, 0, close, K);
  ok("el puente entre formas es solido", mid < 0, `campo ${f(mid, 2)}`);

  // Y es la mezcla, no la cercania, lo que lo crea: sin blend siguen separadas.
  const hard = sampleFieldDistance(0, 0, close, 0);
  ok("sin mezcla no hay puente", hard > 0, `campo ${f(hard, 2)}`);

  // La promesa del deslizador es "a mas alto, se funden antes de tocarse": con
  // el par fijo, subir la mezcla tiene que acabar cerrando el puente.
  const fixed = pair(100);
  const gapField = (k: number): number => sampleFieldDistance(0, 0, fixed, k);
  ok("subir la mezcla acerca el puente", gapField(80) < gapField(20), `${f(gapField(20), 1)} -> ${f(gapField(80), 1)}`);
  const merges = [20, 40, 60, 80, 100, 120].filter((k) => gapField(k) < 0);
  ok("el rango del deslizador alcanza a fundir", merges.length > 0, `funde desde k=${merges[0]}`);
  // Y la mezcla no puede funcionar al reves: mas alto nunca debe separar.
  const monotone = [20, 40, 60, 80, 100, 120].every((k, i, a) => i === 0 || gapField(k) <= gapField(a[i - 1]) + 1e-6);
  ok("la mezcla es monotona", monotone);

  // La silueta fundida conserva las esquinas de las cajas: no es un metaball de
  // circulos disfrazado. Se comprueba que el contorno llega a las esquinas.
  const loop = fieldContours(close, 18, { cell: 1.5 })[0];
  const corner = Math.max(...loop.map((v) => Math.min(Math.abs(v.x), Math.abs(v.y))));
  ok("la fusion conserva la silueta angulosa", corner > 24, `medio-lado ${f(corner, 1)}px de 30`);
}

// ----------------------------------------------------------------- fisicas --

{
  const w = new PhysicsWorld();
  w.settings.gravity = { x: 0, y: 900 };
  w.settings.walls = true;
  w.settings.cohesion = 0;
  w.bounds = { x: 0, y: 0, w: 600, h: 400 };

  const s = shape({ kind: "box", size: 20, round: 0, aspect: 1 });
  for (let i = 0; i < 5; i++) w.add(createBody(s, { x: 300 + (i % 2) * 3, y: 340 - i * 44 }));
  const floor = w.add(createBody(shape({ kind: "box", size: 20, aspect: 10 }), { x: 300, y: 380 }, { isStatic: true }));
  const floorAt = { x: floor.pos.x, y: floor.pos.y };

  for (let i = 0; i < 600; i++) w.update(1 / 60);

  const dyn = w.bodies.filter((b) => !b.isStatic);
  ok("todo es finito tras 600 pasos",
     w.bodies.every((b) => Number.isFinite(b.pos.x) && Number.isFinite(b.pos.y) && Number.isFinite(b.angle)));
  ok("nada escapa del contenedor", dyn.every((b) => b.pos.x > -60 && b.pos.x < 660 && b.pos.y < 460),
     `y max ${f(Math.max(...dyn.map((b) => b.pos.y)), 1)}`);
  ok("los cuerpos estaticos no se mueven",
     Math.hypot(floor.pos.x - floorAt.x, floor.pos.y - floorAt.y) < 1e-6);
  const vmax = Math.max(...dyn.map((b) => Math.hypot(b.vel.x, b.vel.y)));
  ok("la pila se asienta", vmax < 20, `velocidad maxima ${f(vmax, 2)}px/s`);
}

{
  // Cohesion: dos cuerpos dentro del alcance deben buscarse y quedar pegados,
  // no superpuestos. Es el gesto que hace que la materia "se llame".
  const w = new PhysicsWorld();
  w.settings.gravity = { x: 0, y: 0 };
  w.settings.walls = false;
  w.settings.cohesion = 1;
  w.settings.sleeping = false;
  const s = shape({ kind: "circle", size: 26 });
  const a = w.add(createBody(s, { x: -55, y: 0 }));
  const b = w.add(createBody(s, { x: 55, y: 0 }));
  const d0 = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
  for (let i = 0; i < 600; i++) w.update(1 / 60);
  const d1 = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
  ok("la cohesion junta los cuerpos", d1 < d0 * 0.75, `${f(d0, 1)}px -> ${f(d1, 1)}px`);
  ok("la cohesion no los superpone", d1 > 40, `${f(d1, 1)}px (radios suman 52)`);
}

console.log(out.join("\n"));
const fails = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${out.length - fails}/${out.length} en verde`);
console.log(failed ? "MOTOR: HAY FALLOS" : "MOTOR: TODO EN VERDE");
if (failed) process.exitCode = 1;
