/**
 * Pruebas del motor 3D.
 *
 * Igual que la suite del motor 2D, aqui no hay DOM ni WebGL: se comprueban las
 * piezas que producen datos, porque son las que fallan en silencio. Una cinta
 * que se retuerce, una decimacion que se come una curva o un radio que deja de
 * coincidir con el del lienzo no lanzan ninguna excepcion; simplemente hacen que
 * el dibujo se vea mal.
 *
 * Cada bloque mide la magnitud concreta que delata el fallo, para que el
 * resultado diga "0.31 rad de torsion" y no solo "falla".
 */

import { DEFAULT_BRUSH, type BrushSettings } from "../src/stroke/types";
import { StrokeBuilder, type WorldSample } from "../src/stroke/builder";
import { Stroke3DBuilder } from "../src/scene3d/builder";
import { computeFrames } from "../src/scene3d/frames";
import { simplifyStroke } from "../src/scene3d/simplify";
import {
  MIN_JOINT_RATIO,
  COMPACT_THRESHOLD,
  IA_EXT,
  IA_POS,
  IA_RAD,
  IB_EXT,
  IB_POS,
  IB_RAD,
  INSTANCE_FLOATS,
  StrokeScene,
  jointExtensions,
  packSegments,
  segmentsOf,
} from "../src/scene3d/batch";
import { cullBatch, frustumOf, screenRadiusPx, sphereVisible } from "../src/scene3d/cull";
import {
  DEFAULT_CAMERA_3D,
  MAX_PITCH,
  cameraFrustum,
  eyeOf,
  forwardOf,
  frameSphere,
  orbit,
  pan,
  projectPoint,
  rightOf,
  upOf,
  viewProjection,
  zoom,
  type Camera3DState,
} from "../src/scene3d/camera3d";
import {
  CameraController3D,
  NO_MODIFIERS,
  navigatesWith,
  pansWith,
  rayToCameraPlane,
  rayToDepthPlane,
  rayToPlane,
  screenToRay,
  snapDepth,
  type Modifiers3D,
} from "../src/scene3d/controls3d";
import {
  boundsOf,
  boundsRadius,
  POINT_BYTES,
  POINT_FLOATS,
  POS_OFFSET,
  PRESSURE_OFFSET,
  RADIUS_OFFSET,
  TIME_OFFSET,
  type Sample3D,
  type Stroke3D,
} from "../src/scene3d/types";
import { v3, type V3 } from "../src/scene3d/vec3";
import { falloff, pullStroke, relaxStroke, touches } from "../src/scene3d/relax";
import {
  FillScene,
  makeFill,
  outlineArea,
  outlineNormal,
  trianglesArea,
  triangulateOutline,
} from "../src/scene3d/fill";
import { SceneDocument } from "../src/scene/document";

// El tsconfig usa `"types": []` a proposito: la aplicacion se compila contra el
// DOM y nada mas. Esta suite si corre en Node, asi que declara aqui lo unico que
// toca de el en vez de arrastrar @types/node a todo el proyecto.
declare const process: { exitCode?: number };

const out: string[] = [];
let failed = false;
const ok = (label: string, cond: boolean, extra = ""): void => {
  out.push(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};
const f = (n: number, d = 4): string => n.toFixed(d);

// ------------------------------------------------------------ utilidades --

/** Ángulo entre dos vectores, en radianes. */
const angleBetween = (a: V3, b: V3): number => {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la < 1e-12 || lb < 1e-12) return 0;
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, c)));
};

const readVec = (data: Float32Array, i: number, offset: number): V3 => {
  const o = i * POINT_FLOATS + offset;
  return v3(data[o], data[o + 1], data[o + 2]);
};

const settings = (patch: Partial<BrushSettings> = {}): BrushSettings => ({
  ...DEFAULT_BRUSH,
  size: 30,
  minRatio: 0.15,
  smoothing: 0.3,
  streamline: 0.2,
  taperIn: 0,
  taperOut: 0,
  jitter: 0,
  ...patch,
});

const sample3 = (x: number, y: number, z: number, i: number, pressure = 0.5): Sample3D => ({
  x,
  y,
  z,
  pressure,
  tilt: 0,
  azimuth: 0,
  t: i * 8,
  predicted: false,
});

/** Hélice de `n` puntos: el caso que delata una cinta que se retuerce. */
const helix = (n: number, radius = 120, turns = 2.5, rise = 320): Sample3D[] => {
  const pts: Sample3D[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const a = u * turns * Math.PI * 2;
    pts.push(sample3(Math.cos(a) * radius, u * rise - rise / 2, Math.sin(a) * radius, i));
  }
  return pts;
};

/** Círculo en el plano XY (z constante). */
const circle = (n: number, radius = 100): Sample3D[] => {
  const pts: Sample3D[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / (n - 1)) * Math.PI * 2;
    pts.push(sample3(Math.cos(a) * radius, Math.sin(a) * radius, 0, i));
  }
  return pts;
};

/** Construye un trazo 3D completo a partir de muestras. */
const build3d = (
  samples: Sample3D[],
  st: BrushSettings,
  planeNormal: V3 | null = null,
  simplifyOpts = {},
  seed = 4242,
) => {
  const b = new Stroke3DBuilder(st);
  b.simplify = simplifyOpts;
  b.begin(samples[0], { brush: "ribbon", color: "#ffffff", layerId: "L", planeNormal }, seed);
  b.push(samples.slice(1), true);
  return b.finalize();
};

// --------------------------------------------------- marcos: sin torsion --

/**
 * El caso limpio: un trazo dibujado sobre un plano conocido debe tener la
 * normal EXACTAMENTE igual a la del plano en todos sus puntos. Cualquier
 * desviacion es torsion, y es el defecto mas visible de una cinta 3D.
 */
{
  const st = settings({ smoothing: 0, streamline: 0 });
  const s = build3d(circle(180), st, v3(0, 0, 1));
  if (!s) {
    ok("el circulo sobre un plano se construye", false);
  } else {
    let worst = 0;
    for (let i = 0; i < s.count; i++) {
      worst = Math.max(worst, angleBetween(readVec(s.data, i, 3), v3(0, 0, 1)));
    }
    ok(
      "sobre un plano la cinta queda tendida en el plano",
      worst < 1e-4,
      `desviacion max ${f(worst)} rad en ${s.count} puntos`,
    );
  }
}

/**
 * Sin plano declarado, un trazo plano debe seguir siendo plano: el eje de giro
 * entre tangentes consecutivas es perpendicular al plano, y girar un vector del
 * plano alrededor de ese eje lo deja dentro del plano. Que aparezca componente Z
 * significa que el marco esta girando sobre la tangente.
 */
{
  const st = settings({ smoothing: 0, streamline: 0 });
  const s = build3d(circle(180), st, null);
  if (!s) {
    ok("el circulo sin plano se construye", false);
  } else {
    let worstZ = 0;
    for (let i = 0; i < s.count; i++) {
      worstZ = Math.max(worstZ, Math.abs(readVec(s.data, i, 3).z));
    }
    ok(
      "sin plano declarado el trazo plano no adquiere torsion",
      worstZ < 1e-4,
      `componente Z max ${f(worstZ)}`,
    );
  }
}

/**
 * Cota rigurosa de no-torsion valida para cualquier curva: al transportar el
 * marco con el giro minimo, la normal no puede moverse mas que la propia
 * tangente, porque esa es exactamente la rotacion aplicada. Una cinta que gira
 * sobre si misma incumple la cota.
 */
{
  const st = settings({ smoothing: 0, streamline: 0 });
  const samples = helix(240);
  const s = build3d(samples, st, null);
  if (!s) {
    ok("la helice se construye", false);
  } else {
    const tan = new Float32Array(s.count * 3);
    for (let i = 0; i < s.count; i++) {
      const a = readVec(s.data, Math.max(0, i - 1), POS_OFFSET);
      const b = readVec(s.data, Math.min(s.count - 1, i + 1), POS_OFFSET);
      const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
      tan[i * 3] = (b.x - a.x) / l;
      tan[i * 3 + 1] = (b.y - a.y) / l;
      tan[i * 3 + 2] = (b.z - a.z) / l;
    }

    let worstExcess = 0;
    let flips = 0;
    for (let i = 0; i < s.count - 1; i++) {
      const t0 = v3(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]);
      const t1 = v3(tan[(i + 1) * 3], tan[(i + 1) * 3 + 1], tan[(i + 1) * 3 + 2]);
      const n0 = readVec(s.data, i, 3);
      const n1 = readVec(s.data, i + 1, 3);
      const turn = angleBetween(t0, t1);
      const moved = angleBetween(n0, n1);
      worstExcess = Math.max(worstExcess, moved - turn);
      if (n0.x * n1.x + n0.y * n1.y + n0.z * n1.z < 0) flips++;
    }
    ok(
      "la normal no gira mas de lo que gira la tangente",
      worstExcess < 1e-4,
      `exceso max ${f(worstExcess)} rad`,
    );
    ok("el marco no da la vuelta en ningun punto", flips === 0);
  }
}

/** Estabilidad numerica en curvatura alta: nada de NaN ni normales nulas. */
{
  const st = settings({ smoothing: 0, streamline: 0, size: 4 });
  const samples: Sample3D[] = [];
  for (let i = 0; i < 200; i++) {
    const a = i * 0.9;
    const r = 200 * Math.exp(-i / 90);
    samples.push(sample3(Math.cos(a) * r, Math.sin(a) * r, i * 4, i));
  }
  const s = build3d(samples, st, null);
  if (!s) {
    ok("la espiral cerrada se construye", false);
  } else {
    let bad = 0;
    let minLen = Infinity;
    for (let i = 0; i < s.count; i++) {
      const n = readVec(s.data, i, 3);
      const l = Math.hypot(n.x, n.y, n.z);
      minLen = Math.min(minLen, l);
      if (!Number.isFinite(l) || Math.abs(l - 1) > 1e-3) bad++;
    }
    ok("en espiral cerrada las normales siguen siendo unitarias", bad === 0,
       `|n| min ${f(minLen)}`);
  }
}

/** Un trazo de un solo punto no debe romper el calculo de marcos. */
{
  const data = new Float32Array([5, 6, 7, 0, 0, 0, 1, 1, 0]);
  computeFrames(data, 1, v3(0, 0, 1));
  ok(
    "un trazo de un punto toma la normal del plano",
    Math.abs(data[3]) < 1e-6 && Math.abs(data[4]) < 1e-6 && Math.abs(data[5] - 1) < 1e-6,
  );
  computeFrames(data, 1, null);
  const l = Math.hypot(data[3], data[4], data[5]);
  ok("sin plano, un punto suelto tiene normal unitaria", Math.abs(l - 1) < 1e-6);
}

// ------------------------------------------------------- decimacion --

/** Una recta no necesita mas de sus dos extremos. */
{
  const n = 300;
  const data = new Float32Array(n * POINT_FLOATS);
  for (let i = 0; i < n; i++) {
    const o = i * POINT_FLOATS;
    data[o] = i;
    data[o + 1] = 0;
    data[o + 2] = 0;
    data[o + RADIUS_OFFSET] = 5;
    data[o + PRESSURE_OFFSET] = 0.5;
  }
  const r = simplifyStroke(data, n);
  ok("una recta se reduce a sus extremos", r.count === 2, `${n} -> ${r.count} puntos`);
}

/** Una curva debe conservar su forma dentro de la tolerancia pedida. */
{
  const n = 400;
  const data = new Float32Array(n * POINT_FLOATS);
  for (let i = 0; i < n; i++) {
    const a = (i / (n - 1)) * Math.PI * 1.5;
    const o = i * POINT_FLOATS;
    data[o] = Math.cos(a) * 300;
    data[o + 1] = Math.sin(a) * 300;
    data[o + 2] = 0;
    data[o + RADIUS_OFFSET] = 6;
    data[o + PRESSURE_OFFSET] = 0.5;
  }
  const tol = 0.35;
  const r = simplifyStroke(data, n, { tolerance: tol, maxPoints: 4096 });

  // Error real: distancia de cada punto original al trozo decimado mas cercano.
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const px = data[i * POINT_FLOATS];
    const py = data[i * POINT_FLOATS + 1];
    let best = Infinity;
    for (let k = 0; k < r.count - 1; k++) {
      const ax = r.data[k * POINT_FLOATS];
      const ay = r.data[k * POINT_FLOATS + 1];
      const bx = r.data[(k + 1) * POINT_FLOATS];
      const by = r.data[(k + 1) * POINT_FLOATS + 1];
      const abx = bx - ax;
      const aby = by - ay;
      const den = abx * abx + aby * aby;
      const t = den < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / den));
      best = Math.min(best, Math.hypot(px - (ax + abx * t), py - (ay + aby * t)));
    }
    worst = Math.max(worst, best);
  }
  ok(
    "la curva decimada se mantiene dentro de la tolerancia",
    worst <= tol * 1.05,
    `error max ${f(worst, 3)} con tolerancia ${tol}, ${n} -> ${r.count} puntos`,
  );
  ok("la decimacion de una curva ahorra puntos de verdad", r.count < n * 0.5,
     `${((1 - r.count / n) * 100).toFixed(0)}% menos`);
}

/**
 * El radio tambien cuenta: un tramo recto cuyo grosor sube y baja en curva debe
 * conservar puntos aunque su geometria sea trivial. Sin el termino de radio,
 * Douglas-Peucker lo reduciria a dos puntos y el bulto de grosor se perderia.
 *
 * Ojo con el caso de prueba: una rampa LINEAL de radio la interpola la propia
 * cuerda de los extremos, asi que descartar puntos seria correcto. La variacion
 * tiene que ser curva para que la prueba signifique algo.
 */
{
  const n = 200;
  const radiusAt = (i: number): number => 5 + 10 * Math.sin((i / (n - 1)) * Math.PI);
  const make = (vary: boolean): Float32Array => {
    const data = new Float32Array(n * POINT_FLOATS);
    for (let i = 0; i < n; i++) {
      const o = i * POINT_FLOATS;
      data[o] = i * 2;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + RADIUS_OFFSET] = vary ? radiusAt(i) : 5;
      data[o + PRESSURE_OFFSET] = 0.5;
    }
    return data;
  };

  const flat = simplifyStroke(make(false), n);
  const bump = simplifyStroke(make(true), n);
  ok(
    "un cambio de grosor sobrevive a la decimacion",
    bump.count > flat.count * 3,
    `grosor constante -> ${flat.count} puntos, grosor con bulto -> ${bump.count}`,
  );

  // El radio guardado debe reproducir el original dentro de la tolerancia del
  // termino de radio, interpolando entre los puntos que si se conservaron.
  const src = make(true);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i * POINT_FLOATS];
    let lo = 0;
    for (let k = 0; k < bump.count; k++) {
      if (bump.data[k * POINT_FLOATS] <= px) lo = k;
    }
    const hi = Math.min(bump.count - 1, lo + 1);
    const ax = bump.data[lo * POINT_FLOATS];
    const bx = bump.data[hi * POINT_FLOATS];
    const ra = bump.data[lo * POINT_FLOATS + RADIUS_OFFSET];
    const rb = bump.data[hi * POINT_FLOATS + RADIUS_OFFSET];
    const t = bx - ax < 1e-9 ? 0 : (px - ax) / (bx - ax);
    worst = Math.max(worst, Math.abs(src[i * POINT_FLOATS + RADIUS_OFFSET] - (ra + (rb - ra) * t)));
  }
  ok("el radio interpolado reproduce el grosor original", worst < 1.2,
     `desvio max ${f(worst, 3)} de un bulto de 10`);
}

// ------------------------------------- coherencia entre el lienzo y el espacio --

/**
 * La prueba que justifica haber extraido `stroke/dynamics.ts`: el MISMO gesto
 * debe producir el MISMO radio en 2D y en 3D. Si esta falla, los dos motores han
 * divergido y un pincel ya no se comporta igual al entrar al espacio.
 *
 * Se dibuja el gesto con z=0 y sin decimacion efectiva, de modo que ambos
 * constructores recorran exactamente los mismos puntos.
 */
{
  const st = settings({ taperIn: 0, taperOut: 0 });
  const n = 120;
  const wave = (i: number): [number, number] => [
    60 + i * 3,
    200 + Math.sin(i * 0.35) * 45,
  ];

  const b2 = new StrokeBuilder(st);
  const first: WorldSample = {
    x: wave(0)[0],
    y: wave(0)[1],
    pressure: 0.2,
    tilt: 0,
    azimuth: 0,
    t: 0,
    predicted: false,
  };
  b2.begin(first, 12345);
  const rest: WorldSample[] = [];
  for (let i = 1; i < n; i++) {
    rest.push({
      x: wave(i)[0],
      y: wave(i)[1],
      pressure: 0.2 + (i / (n - 1)) * 0.7,
      tilt: 0,
      azimuth: 0,
      t: i * 8,
      predicted: false,
    });
  }
  b2.push(rest, true);
  const pts2 = b2.finalize();

  const s3 = build3d(
    rest.reduce<Sample3D[]>(
      (acc, w) => {
        acc.push({ ...w, z: 0 });
        return acc;
      },
      [{ ...first, z: 0 }],
    ),
    st,
    null,
    { tolerance: 1e-6, maxPoints: 4096 },
  );

  if (!s3) {
    ok("el gesto de comparacion se construye en 3D", false);
  } else {
    ok(
      "el mismo gesto da los mismos puntos en 2D y en 3D",
      s3.count === pts2.length,
      `2D ${pts2.length} vs 3D ${s3.count}`,
    );
    const m = Math.min(s3.count, pts2.length);
    let worst = 0;
    for (let i = 0; i < m; i++) {
      worst = Math.max(worst, Math.abs(s3.data[i * POINT_FLOATS + RADIUS_OFFSET] - pts2[i].r));
    }
    ok(
      "el radio coincide entre el lienzo y el espacio",
      worst < 1e-5,
      `desvio max ${f(worst, 6)}`,
    );
  }
}

// ---------------------------------------------------- conjunto y memoria --

/** El trazo debe traer su caja envolvente y cubrir radio, no solo posiciones. */
{
  const st = settings();
  const pts: Sample3D[] = [];
  for (let i = 0; i < 40; i++) pts.push(sample3(i * 10, 0, 0, i, 0.9));
  const s = build3d(pts, st, null);
  if (!s) {
    ok("el trazo de caja se construye", false);
  } else {
    const b = boundsOf(s.data, s.count);
    const r = Math.max(...Array.from({ length: s.count }, (_, i) => s.data[i * POINT_FLOATS + RADIUS_OFFSET]));
    ok("la caja incluye el radio del trazo", b.minY <= -r + 1e-3 && b.maxY >= r - 1e-3,
       `radio ${f(r, 2)}, caja Y [${f(b.minY, 2)}, ${f(b.maxY, 2)}]`);
    ok("el radio de la caja es positivo", boundsRadius(b) > 0);
  }
}

/**
 * Presupuesto de memoria medido, no supuesto: se mide cuantos puntos deja
 * realmente la decimacion y se proyecta a 20.000 trazos.
 */
{
  const st = settings();
  let total = 0;
  const count = 200;
  for (let k = 0; k < count; k++) {
    const samples: Sample3D[] = [];
    for (let i = 0; i < 320; i++) {
      const a = (i / 120) * Math.PI * 2 + k;
      samples.push(
        sample3(
          Math.cos(a) * (90 + (k % 7) * 12),
          Math.sin(a) * (90 + (k % 7) * 12),
          i * 1.5,
          i,
          0.15 + 0.7 * Math.abs(Math.sin(i * 0.13)),
        ),
      );
    }
    const s = build3d(samples, st, null);
    if (s) total += s.count;
  }
  const avg = total / count;
  const total20k = avg * 20000 * POINT_BYTES;
  ok(
    "un gesto con presion muy oscilante se queda en la mitad",
    avg < 200,
    `media ${avg.toFixed(1)} puntos de 320 muestras (${((1 - avg / 320) * 100).toFixed(0)}% menos); ` +
      "es el caso pesimo, con seis oscilaciones de grosor",
  );

  // El caso normal: un trazo que divaga sin oscilar apenas. Aqui la decimacion
  // tiene que ser mucho mas agresiva, y es el numero que representa al uso real.
  let wander = 0;
  for (let k = 0; k < count; k++) {
    const samples: Sample3D[] = [];
    for (let i = 0; i < 320; i++) {
      const u = i / 319;
      samples.push(
        sample3(
          120 * Math.sin(u * 5 + k) + i * 0.8,
          90 * Math.cos(u * 3.3 + k),
          i * 1.2,
          i,
          0.35 + 0.25 * Math.sin(i * 0.02),
        ),
      );
    }
    const s = build3d(samples, st, null);
    if (s) wander += s.count;
  }
  const avgWander = wander / count;
  ok(
    "un trazo normal se reduce a menos de un tercio",
    avgWander < 320 / 3,
    `media ${avgWander.toFixed(1)} puntos de 320 (${((1 - avgWander / 320) * 100).toFixed(0)}% menos)`,
  );
  ok(
    "20.000 trazos caben en el presupuesto de 150 MB",
    total20k < 150 * 1024 * 1024,
    `${(total20k / 1024 / 1024).toFixed(1)} MB a ${POINT_BYTES} bytes por punto`,
  );
}

// -------------------------------------------------------- determinismo --

/**
 * La misma semilla debe dar el mismo trazo: de eso depende que un pincel con
 * ruido se reconstruya identico al reabrir el documento.
 */
{
  const st = settings({ jitter: 0.6 });
  const mk = (): Sample3D[] => {
    const a: Sample3D[] = [];
    for (let i = 0; i < 90; i++) a.push(sample3(i * 4, Math.sin(i * 0.2) * 30, i, i, 0.6));
    return a;
  };
  const a = build3d(mk(), st, null, {}, 777);
  const b = build3d(mk(), st, null, {}, 777);
  const other = build3d(mk(), st, null, {}, 778);
  let same = a !== null && b !== null && a.count === b.count;
  if (same && a && b) {
    for (let i = 0; i < a.data.length; i++) {
      if (a.data[i] !== b.data[i]) {
        same = false;
        break;
      }
    }
  }
  ok("la misma semilla reconstruye el mismo trazo", same);
  // Otra semilla cambia el ruido del radio, y con el puede cambiar hasta el
  // numero de puntos que sobrevive a la decimacion: cuenta como distinto
  // cualquiera de las dos cosas.
  let differs = false;
  if (a && other) {
    if (a.count !== other.count) {
      differs = true;
    } else {
      for (let i = 0; i < a.data.length; i++) {
        if (a.data[i] !== other.data[i]) {
          differs = true;
          break;
        }
      }
    }
  }
  ok(
    "otra semilla produce otro trazo",
    a !== null && other !== null && differs,
    a && other
      ? `radio inicial ${f(a.data[RADIUS_OFFSET], 4)} vs ${f(other.data[RADIUS_OFFSET], 4)}`
      : "",
  );

  const c = new Stroke3DBuilder(st);
  const samples = mk();
  c.begin(samples[0], { brush: "ribbon", color: "#fff", layerId: "L" }, 999);
  c.push(samples.slice(1), true);
  const withSeed = c.finalize();
  ok("el trazo conserva la semilla recibida", withSeed?.seed === 999);
}

// ------------------------------------------------------------- afilado --

/** Los extremos deben quedar mas finos que el centro cuando hay afilado. */
{
  const st = settings({ taperIn: 0.2, taperOut: 0.2 });
  const pts: Sample3D[] = [];
  for (let i = 0; i < 200; i++) pts.push(sample3(i * 5, i * 0.5, 0, i, 0.8));
  const s = build3d(pts, st, null);
  if (!s) {
    ok("el trazo afilado se construye", false);
  } else {
    const rAt = (i: number): number => s.data[i * POINT_FLOATS + RADIUS_OFFSET];
    const mid = rAt(Math.floor(s.count / 2));
    ok(
      "el trazo se afila en la entrada y en la salida",
      rAt(0) < mid * 0.2 && rAt(s.count - 1) < mid * 0.2,
      `entrada ${f(rAt(0), 3)}, centro ${f(mid, 3)}, salida ${f(rAt(s.count - 1), 3)}`,
    );
  }
}

// -------------------------------------------------------------- gestos --

/** Un toque sin desplazamiento no debe generar un trazo vacio ni uno enorme. */
{
  const st = settings();
  const b = new Stroke3DBuilder(st);
  b.begin(sample3(10, 10, 10, 0), { brush: "ribbon", color: "#fff", layerId: "L" });
  b.push([sample3(10, 10, 10, 1), sample3(10.01, 10, 10, 2)]);
  const s = b.finalize();
  ok("un toque casi quieto deja un trazo minimo", s !== null && s.count === 1, `${s?.count} puntos`);
}

/** Cancelar debe dejar el constructor limpio y no devolver nada. */
{
  const b = new Stroke3DBuilder(settings());
  b.begin(sample3(0, 0, 0, 0), { brush: "ribbon", color: "#fff", layerId: "L" });
  b.push([sample3(50, 0, 0, 1)]);
  b.cancel();
  ok("tras cancelar no se finaliza nada", b.finalize() === null);
  ok("tras cancelar no quedan puntos", b.length === 0);
}

/**
 * Un gesto largo y repetido no debe reasignar el buffer en cada punto: se crece
 * por duplicacion. Se comprueba que 4.000 puntos se capturan sin perder el
 * contenido por el camino.
 *
 * El paso entre muestras (12 unidades de mundo) es mayor que el minimo que impone
 * el radio -`max(0.55 / zoom, 0.5 * r)`, con el pincel por defecto 2.5-, para que
 * lo que se mida sea el crecimiento del buffer y no el muestreo.
 */
{
  const b = new Stroke3DBuilder(settings({ streamline: 0, smoothing: 0 }));
  b.begin(sample3(0, 0, 0, 0), { brush: "ribbon", color: "#fff", layerId: "L" });
  const many: Sample3D[] = [];
  for (let i = 1; i < 4000; i++) many.push(sample3(i * 12, Math.sin(i * 0.05) * 20, 0, i));
  b.push(many, true);
  ok("el buffer crece sin perder puntos", b.length === 4000, `${b.length} puntos capturados`);
  const s = b.finalize();
  ok("el trazo largo se cierra", s !== null && s.count >= 2 && s.count <= 4000, `${s?.count} puntos`);
}

// ---------------------------------------------------------------- juntas --

/**
 * Un trazo plano en XY, con la normal del plano puesta.
 *
 * Plano a proposito: con la cinta tendida sobre XY los dos quads de una junta son
 * rectangulos coplanares, asi que la comprobacion de cobertura se puede hacer con
 * aritmetica de dos dimensiones y sin ambiguedad.
 *
 * Cada llamada se lleva un id distinto: el id es la identidad del trazo, y dos
 * trazos con el mismo id son, para la escena, el mismo trazo editado.
 */
let planarSeq = 0;
const planarStroke = (pts: readonly [number, number][], r: number): Stroke3D => {
  const data = new Float32Array(pts.length * POINT_FLOATS);
  for (let i = 0; i < pts.length; i++) {
    const o = i * POINT_FLOATS;
    data[o + POS_OFFSET] = pts[i][0];
    data[o + POS_OFFSET + 1] = pts[i][1];
    data[o + POS_OFFSET + 2] = 0;
    data[o + RADIUS_OFFSET] = r;
    data[o + PRESSURE_OFFSET] = 1;
    data[o + TIME_OFFSET] = i;
  }
  computeFrames(data, pts.length, v3(0, 0, 1));
  return {
    id: `junta-${++planarSeq}`,
    brush: "ribbon",
    color: "#000000",
    layerId: "L",
    data,
    count: pts.length,
    bounds: boundsOf(data, pts.length),
    seed: 1,
    planeNormal: v3(0, 0, 1),
  };
};

/**
 * Replica exacta de lo que hace el vertex shader: prolonga el quad por `extA` y
 * `extB` a lo largo de su tangente, y acota el radio al tramo original.
 */
const covers = (buf: Float32Array, i: number, px: number, py: number): boolean => {
  const o = i * INSTANCE_FLOATS;
  const ax = buf[o + IA_POS];
  const ay = buf[o + IA_POS + 1];
  const bx = buf[o + IB_POS];
  const by = buf[o + IB_POS + 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;

  const ux = dx / len;
  const uy = dy / len;
  const along = (px - ax) * ux + (py - ay) * uy;
  const lateral = Math.abs((px - ax) * -uy + (py - ay) * ux);

  if (along < -buf[o + IA_EXT] || along > len + buf[o + IB_EXT]) return false;
  const t = Math.min(1, Math.max(0, along / len));
  const ra = buf[o + IA_RAD];
  const rb = buf[o + IB_RAD];
  return lateral <= ra + (rb - ra) * t;
};

/** Puntos sin cubrir del disco de radio `r` alrededor de una junta. */
const uncoveredAtJoint = (
  buf: Float32Array,
  joint: number,
  cx: number,
  cy: number,
  r: number,
): number => {
  let miss = 0;
  for (let a = 0; a < 360; a += 3) {
    const rad = (a * Math.PI) / 180;
    for (const k of [0.35, 0.7, 1]) {
      const px = cx + Math.cos(rad) * r * k;
      const py = cy + Math.sin(rad) * r * k;
      if (!covers(buf, joint - 1, px, py) && !covers(buf, joint, px, py)) miss++;
    }
  }
  return miss;
};

{
  const r = 10;

  // Los extremos del trazo no se prolongan: ahi no hay vecino que rellenar y
  // hacerlo alargaria el trazo por los dos cabos.
  const recto = jointExtensions(planarStroke([[0, 0], [100, 0], [200, 0], [300, 0]], r));
  ok("los extremos del trazo no se prolongan", recto[0] === 0 && recto[3] === 0, `${recto[0]} / ${recto[3]}`);
  // Un tramo recto no tiene muesca que cerrar, pero si costura de antialias: dos
  // quads que comparten canto exacto dejan una linea clara al componerse. Por eso
  // hay un suelo.
  ok(
    "un tramo recto conserva el solape minimo",
    Math.abs(recto[1] - r * MIN_JOINT_RATIO) < 1e-6 && recto[1] > 0,
    `${f(recto[1], 4)} = ${f(r * MIN_JOINT_RATIO, 4)}`,
  );

  // Un codo de 90 grados necesita justo el radio: es la tapa redonda que cubre la
  // junta entera.
  const codo = jointExtensions(planarStroke([[0, 0], [200, 0], [200, 200]], r));
  ok("un codo de 90 grados se prolonga un radio", Math.abs(codo[1] - r) < 1e-4, f(codo[1], 4));

  // Y nunca mas: prolongar mas alla del radio solo anadiria solape.
  const agudo = jointExtensions(planarStroke([[0, 0], [200, 0], [100, 4]], r));
  ok("una vuelta atras no se prolonga mas que el radio", agudo[1] <= r + 1e-6, f(agudo[1], 4));
}

/**
 * La junta tiene que quedar tapada, y esta es la prueba que importa.
 *
 * Se barre el disco del radio alrededor de la junta y se comprueba que cada punto
 * lo cubre alguno de los dos segmentos. Ademas se repite el barrido con la
 * prolongacion a cero -que es como estaba antes- para dejar claro que la prueba
 * distingue los dos casos: si no fallara sin el arreglo, no probaria nada.
 */
for (const [nombre, grados] of [["90 grados", 90], ["20 grados", 20]] as const) {
  const r = 10;
  const rad = (grados * Math.PI) / 180;
  const stroke = planarStroke(
    [[0, 0], [200, 0], [200 + Math.cos(rad) * 200, Math.sin(rad) * 200]],
    r,
  );
  const buf = new Float32Array(segmentsOf(stroke.count) * INSTANCE_FLOATS);
  packSegments(buf, 0, stroke);

  const miss = uncoveredAtJoint(buf, 1, 200, 0, r);
  ok(`el codo de ${nombre} queda tapado`, miss === 0, `${miss} puntos sin cubrir`);

  const sinProlongar = buf.slice();
  for (let i = 0; i < segmentsOf(stroke.count); i++) {
    sinProlongar[i * INSTANCE_FLOATS + IA_EXT] = 0;
    sinProlongar[i * INSTANCE_FLOATS + IB_EXT] = 0;
  }
  const antes = uncoveredAtJoint(sinProlongar, 1, 200, 0, r);
  ok(
    `sin prolongar el codo de ${nombre} dejaba hueco`,
    antes > 0,
    `${antes} puntos sin cubrir`,
  );
}

/**
 * Las dos mitades de una junta tienen que leer el MISMO numero.
 *
 * La junta la comparten el final de un segmento y el principio del siguiente: si
 * cada uno calculara su prolongacion por su cuenta, un lado se estiraria y el otro
 * no y el solape no cuadraria.
 */
{
  const stroke = planarStroke([[0, 0], [120, 0], [120, 90], [40, 160]], 8);
  const buf = new Float32Array(segmentsOf(stroke.count) * INSTANCE_FLOATS);
  packSegments(buf, 0, stroke);
  let worst = 0;
  for (let i = 0; i + 1 < segmentsOf(stroke.count); i++) {
    const fin = buf[i * INSTANCE_FLOATS + IB_EXT];
    const inicio = buf[(i + 1) * INSTANCE_FLOATS + IA_EXT];
    worst = Math.max(worst, Math.abs(fin - inicio));
  }
  ok("las dos mitades de una junta coinciden", worst < 1e-9, `desvio ${f(worst, 6)}`);
}

// ---------------------------------------------------------------- lotes --

/**
 * La promesa del sistema de lotes: N trazos del mismo pincel y la misma capa
 * cuestan UNA draw call, no N. Se mide el numero de lotes, que es exactamente el
 * numero de draw calls.
 */
{
  const st = settings();
  const scene = new StrokeScene();
  const make = (z: number, brush: string, layerId = "L1") => {
    const pts: Sample3D[] = [];
    for (let i = 0; i < 60; i++) pts.push(sample3(i * 4, Math.sin(i * 0.2) * 20, z, i, 0.6));
    const s = build3d(pts, st, null);
    if (!s) return null;
    s.brush = brush;
    s.layerId = layerId;
    return s;
  };

  const strokes: NonNullable<ReturnType<typeof make>>[] = [];
  for (let k = 0; k < 200; k++) {
    const s = make(k * 3, k % 2 === 0 ? "ribbon" : "tube");
    if (s) strokes.push(s);
  }
  for (const s of strokes) scene.add(s);

  ok("doscientas lineas de dos pinceles son dos lotes", scene.batchCount === 2,
     `${scene.batchCount} lotes para ${strokes.length} trazos`);

  const expected = strokes.reduce((n, s) => n + segmentsOf(s.count), 0);
  ok("cada trazo aporta un segmento por par de puntos", scene.instances === expected,
     `${scene.instances} segmentos para ${strokes.length} trazos`);

  // Una capa distinta no puede compartir lote: la capa fija opacidad y fusion.
  const other = make(999, "ribbon", "L2");
  if (other) scene.add(other);
  ok("otra capa abre otro lote", scene.batchCount === 3, `${scene.batchCount} lotes`);
}

/**
 * Borrar no puede mover ni un byte de los demas trazos.
 *
 * Es la propiedad de la que depende que deshacer y borrar sean baratos: si
 * borrar compactara, habria que reescribir el buffer entero y recolocar todos los
 * rangos posteriores en cada trazo eliminado.
 */
{
  const st = settings();
  const scene = new StrokeScene();
  const pts = (z: number): Sample3D[] => {
    const a: Sample3D[] = [];
    for (let i = 0; i < 80; i++) a.push(sample3(i * 3, Math.cos(i * 0.15) * 25, z, i, 0.7));
    return a;
  };
  const a = build3d(pts(0), st, null, {}, 11);
  const b = build3d(pts(50), st, null, {}, 12);
  const c = build3d(pts(100), st, null, {}, 13);
  if (!a || !b || !c) {
    ok("los trazos de la prueba de borrado se construyen", false);
  } else {
    scene.add(a);
    scene.add(b);
    scene.add(c);
    const batch = scene.batchFor("L", "ribbon");
    if (!batch) {
      ok("el lote existe", false);
    } else {
      const removed = batch.range(b.id);
      const before = batch.data.slice(0, batch.segments * INSTANCE_FLOATS);
      const instancesBefore = batch.instances;

      scene.remove(b.id);

      const after = batch.data.slice(0, batch.segments * INSTANCE_FLOATS);
      const lo = (removed?.start ?? 0) * INSTANCE_FLOATS;
      const hi = lo + (removed?.count ?? 0) * INSTANCE_FLOATS;
      let outside = 0;
      let inside = 0;
      for (let i = 0; i < before.length; i++) {
        if (before[i] === after[i]) continue;
        if (i >= lo && i < hi) inside++;
        else outside++;
      }
      ok("borrar no toca nada fuera del trazo borrado", outside === 0,
         `${outside} de ${before.length} floats ajenos tocados`);
      // Lo unico que puede cambiar dentro del rango son los radios: si se tocara
      // una posicion o una normal, el trazo se deformaria en vez de desaparecer.
      let nonRadius = 0;
      for (let i = 0; i < before.length; i++) {
        if (before[i] === after[i]) continue;
        const within = i % INSTANCE_FLOATS;
        if (within !== IA_RAD && within !== IB_RAD) nonRadius++;
      }
      ok("borrar solo cambia radios, no geometria", nonRadius === 0,
         `${nonRadius} componentes ajenas al radio`);
      ok("borrar pone a cero los radios del trazo borrado",
         inside > 0 && inside <= (removed ? removed.count * 2 : 0),
         `${inside} radios en ${removed ? removed.count : 0} segmentos`);
      ok("borrar no libera el hueco", batch.segments === before.length / INSTANCE_FLOATS);
      ok("borrar baja las instancias dibujadas", batch.instances < instancesBefore,
         `${instancesBefore} -> ${batch.instances}`);
      ok("borrar marca desperdicio", batch.waste > 0,
         `${(batch.waste * 100).toFixed(1)}% de desperdicio`);

      // Deshacer el borrado debe devolver el trazo exactamente como estaba.
      scene.restore(b.id);
      const restored = batch.data.slice(0, batch.segments * INSTANCE_FLOATS);
      let diff = 0;
      let firstDiff = -1;
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== restored[i]) {
          if (firstDiff < 0) firstDiff = i;
          diff++;
        }
      }
      ok("restaurar devuelve el trazo identico", diff === 0,
         diff === 0
           ? ""
           : `${diff} floats distintos de ${before.length}; el primero en ${firstDiff} ` +
             `(segmento ${Math.floor(firstDiff / INSTANCE_FLOATS)}, campo ${firstDiff % INSTANCE_FLOATS}); ` +
             `el rango borrado es [${removed?.start}, ${(removed?.start ?? 0) + (removed?.count ?? 0)})`);
      ok("restaurar devuelve las instancias", batch.instances === instancesBefore);
    }
  }
}

/**
 * El borrado no compacta hasta que el desperdicio pasa del umbral, y cuando
 * compacta tiene que dejar cada rango apuntando exactamente a sus puntos.
 *
 * Un desfase de un solo punto aqui desplazaria la geometria de todos los trazos
 * siguientes, y se veria como un dibujo deformado sin que nada lance un error.
 */
{
  const st = settings();
  const scene = new StrokeScene();
  const strokes: ReturnType<typeof build3d>[] = [];
  for (let k = 0; k < 40; k++) {
    const pts: Sample3D[] = [];
    for (let i = 0; i < 60; i++) {
      pts.push(sample3(i * 3, k * 30 + Math.sin(i * 0.3) * 15, k, i, 0.5));
    }
    const s = build3d(pts, st, null, {}, 100 + k);
    if (s) {
      scene.add(s);
      strokes.push(s);
    }
  }
  const batch = scene.batchFor("L", "ribbon");

  const snapshot = (): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    if (!batch) return m;
    for (const r of batch.ranges) {
      if (!r.active) continue;
      const vals: number[] = [];
      for (let i = 0; i < r.count * INSTANCE_FLOATS; i++) {
        vals.push(batch.data[r.start * INSTANCE_FLOATS + i]);
      }
      m.set(r.strokeId, vals);
    }
    return m;
  };

  // Se borra la mitad de los trazos: suficiente para pasar el umbral.
  for (let k = 0; k < strokes.length; k += 2) {
    const s = strokes[k];
    if (s) scene.remove(s.id);
  }
  const before = snapshot();
  const instancesBefore = batch ? batch.instances : 0;
  const pointsBefore = batch ? batch.segments : 0;

  ok("el desperdicio supera el umbral antes de compactar",
     batch !== undefined && batch.waste > COMPACT_THRESHOLD,
     batch ? `${(batch.waste * 100).toFixed(1)}% frente al umbral ${COMPACT_THRESHOLD * 100}%` : "");

  const freed = scene.compact();
  ok("compactar libera puntos", freed > 0 && batch !== undefined && batch.segments < pointsBefore,
     `${pointsBefore} -> ${batch?.segments} puntos, ${freed} liberados`);
  ok("compactar no cambia lo que se dibuja", batch !== undefined && batch.instances === instancesBefore,
     `${instancesBefore} instancias`);

  const after = snapshot();
  ok("compactar conserva los trazos vivos", after.size === before.size,
     `${before.size} -> ${after.size}`);
  let mismatched = 0;
  for (const [id, vals] of before) {
    const now = after.get(id);
    if (!now || now.length !== vals.length) {
      mismatched++;
      continue;
    }
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] !== now[i]) {
        mismatched++;
        break;
      }
    }
  }
  ok("compactar no desplaza ningun rango", mismatched === 0,
     `${mismatched} de ${before.size} trazos desalineados`);
}

/** Una escena de 20.000 trazos debe seguir cabiendo en un punado de draw calls. */
{
  const scene = new StrokeScene();
  const brushes = ["ribbon", "tube", "stamp"];
  for (let k = 0; k < 20000; k++) {
    const n = 24 + (k % 40);
    const data = new Float32Array(n * POINT_FLOATS);
    for (let i = 0; i < n; i++) {
      const o = i * POINT_FLOATS;
      data[o] = k * 0.5;
      data[o + 1] = Math.sin(i * 0.3 + k) * 20;
      data[o + 2] = i * 0.4;
      data[o + 3] = 0;
      data[o + 4] = 1;
      data[o + 5] = 0;
      data[o + RADIUS_OFFSET] = 3;
      data[o + PRESSURE_OFFSET] = 0.5;
    }
    scene.add({
      id: `s${k}`,
      brush: brushes[k % 3] as string,
      color: "#fff",
      layerId: "L",
      data,
      count: n,
      bounds: boundsOf(data, n),
      seed: k,
      planeNormal: null,
    });
  }
  ok("20.000 trazos de tres pinceles son tres draw calls", scene.batchCount === 3,
     `${scene.batchCount} lotes`);
  ok("20.000 trazos caben en el presupuesto de memoria",
     scene.bytes < 150 * 1024 * 1024,
     `${(scene.bytes / 1024 / 1024).toFixed(1)} MB, ${scene.instances} instancias`);
}

/** Un lote sin trazos vivos desaparece; si no, la escena acumularia mallas vacias. */
{
  const st = settings();
  const scene = new StrokeScene();
  const pts: Sample3D[] = [];
  for (let i = 0; i < 40; i++) pts.push(sample3(i * 4, 0, 0, i, 0.5));
  const a = build3d(pts, st, null);
  if (a) {
    scene.add(a);
    scene.forget(a.id);
    ok("un lote sin trazos vivos se poda", scene.prune() === 1 && scene.batchCount === 0,
       `${scene.batchCount} lotes restantes`);
  }
}

// -------------------------------------------------- descarte y nivel de detalle --

/** Cámara de referencia: en el origen, mirando hacia -Z, con +Y arriba. */
const CAM = frustumOf(
  0, 0, 0,
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
  1.0,
  16 / 9,
  0.1,
  1000,
);

/** La base de la cámara tiene que ser ortonormal: si no, el descarte miente. */
{
  const d = (a: number, b: number, c: number, x: number, y: number, z: number): number =>
    a * x + b * y + c * z;
  const lens = [
    Math.hypot(CAM.fx, CAM.fy, CAM.fz),
    Math.hypot(CAM.rx, CAM.ry, CAM.rz),
    Math.hypot(CAM.ux, CAM.uy, CAM.uz),
  ];
  const dots = [
    Math.abs(d(CAM.fx, CAM.fy, CAM.fz, CAM.rx, CAM.ry, CAM.rz)),
    Math.abs(d(CAM.fx, CAM.fy, CAM.fz, CAM.ux, CAM.uy, CAM.uz)),
    Math.abs(d(CAM.rx, CAM.ry, CAM.rz, CAM.ux, CAM.uy, CAM.uz)),
  ];
  ok(
    "la base de la camara es ortonormal",
    lens.every((l) => Math.abs(l - 1) < 1e-6) && dots.every((v) => v < 1e-6),
    `longitudes ${lens.map((l) => f(l, 6)).join(", ")}; productos ${dots.map((v) => f(v, 8)).join(", ")}`,
  );
  ok("la camara mira hacia donde se le dice", CAM.fx === 0 && CAM.fy === 0 && CAM.fz === -1);
  ok("la derecha sale a +X", Math.abs(CAM.rx - 1) < 1e-6);
  ok("el arriba sale a +Y", Math.abs(CAM.uy - 1) < 1e-6);
}

/** Los cuatro casos que tiene que acertar el descarte. */
{
  ok("una esfera delante se ve", sphereVisible(CAM, 0, 0, -10, 1));
  ok("una esfera detras de la camara se descarta", !sphereVisible(CAM, 0, 0, 10, 1));
  ok("una esfera muy a un lado se descarta", !sphereVisible(CAM, 100, 0, -10, 1));
  ok("una esfera mas alla del plano lejano se descarta", !sphereVisible(CAM, 0, 0, -5000, 1));
  ok(
    "una esfera que cruza el plano cercano se conserva por precaucion",
    sphereVisible(CAM, 0, 0, -0.05, 1),
  );
  ok(
    "una esfera al borde del cono sigue viendose",
    sphereVisible(CAM, 9.0 * CAM.tanH, 0, -9.0, 0.5),
    `borde en x=${f(9 * CAM.tanH, 2)}`,
  );
}

/** El tamaño en pantalla decide el nivel, y debe caer con la distancia. */
{
  const near = screenRadiusPx(10, 10, 800, CAM.tanV);
  const mid = screenRadiusPx(10, 200, 800, CAM.tanV);
  const far = screenRadiusPx(10, 1000, 800, CAM.tanV);
  ok(
    "el tamano en pantalla baja al alejarse",
    near > mid && mid > far,
    `10 u: ${f(near, 1)}, 200 u: ${f(mid, 1)}, 1000 u: ${f(far, 1)} px`,
  );
  ok("a distancia cero no se divide por cero", Number.isFinite(screenRadiusPx(10, 0, 800, CAM.tanV)));
}

/**
 * El orden de instancias es exactamente lo que se dibuja, asi que se monta una
 * escena con el resultado conocido de antemano: diez trazos delante y cerca, diez
 * delante y lejos, diez muy a un lado y diez detras de la camara.
 *
 * Los trazos son curvas y no rectas por un motivo: una recta se decima a sus dos
 * extremos, y entonces cada trazo aportaria una sola instancia y la prueba no
 * mediria lo que dice medir.
 */
{
  const st = settings({ size: 6, streamline: 0, smoothing: 0 });
  const scene = new StrokeScene();

  /** Camara de esta prueba: el plano lejano tiene que alcanzar los trazos lejanos. */
  const CAM_LARGO = frustumOf(
    0, 0, 0,
    { x: 0, y: 0, z: -1 },
    { x: 0, y: 1, z: 0 },
    1.0,
    16 / 9,
    0.1,
    20000,
  );

  const curveAt = (x: number, z: number, seed: number) => {
    const pts: Sample3D[] = [];
    for (let i = 0; i < 30; i++) {
      pts.push(sample3(x + Math.sin(i * 0.4) * 15, Math.cos(i * 0.4) * 15, z, i, 0.5));
    }
    const s = build3d(pts, st, null, {}, seed);
    if (s) scene.add(s);
    return s;
  };

  type Trazo = NonNullable<ReturnType<typeof build3d>>;
  const near: Trazo[] = [];
  const far: Trazo[] = [];
  const aside: Trazo[] = [];
  const behind: Trazo[] = [];
  for (let k = 0; k < 10; k++) {
    const a = curveAt(0, -(60 + k * 10), 1000 + k);
    if (a) near.push(a);
    // Lejos de verdad: el LOD depende de radio/distancia, y el radio de estos
    // trazos ronda las 16 unidades.
    const b = curveAt(0, -(2200 + k * 10), 2000 + k);
    if (b) far.push(b);
    const c = curveAt(9000, -100, 3000 + k);
    if (c) aside.push(c);
    const d = curveAt(0, 500, 4000 + k);
    if (d) behind.push(d);
  }

  const batch = scene.batchFor("L", "ribbon");
  if (!batch) {
    ok("el lote de la prueba de descarte existe", false);
  } else {
    const total = batch.instancesLaid;
    const instancesOf = (group: typeof near): number =>
      group.reduce((n, s) => n + segmentsOf(s.count), 0);

    const r = cullBatch(batch, CAM_LARGO, { heightPx: 800, impostorPx: 8 });

    ok("los trazos delante y cerca suben a nivel 0", r.tier0 === instancesOf(near),
       `${r.tier0} instancias, esperadas ${instancesOf(near)}`);
    ok("los trazos delante pero lejos bajan a nivel 1", r.tier1 === instancesOf(far),
       `${r.tier1} instancias, esperadas ${instancesOf(far)}`);
    ok("los trazos de lado y los de detras se descartan",
       r.culled === instancesOf(aside) + instancesOf(behind),
       `${r.culled} descartadas, esperadas ${instancesOf(aside) + instancesOf(behind)}`);

    const seen = new Set<number>();
    let dupes = 0;
    let outOfRange = 0;
    for (let i = 0; i < r.tier0 + r.tier1; i++) {
      const v = r.order[i];
      if (seen.has(v)) dupes++;
      seen.add(v);
      if (v < 0 || v >= total) outOfRange++;
    }
    ok("lo dibujado cubre exactamente los trazos que se ven",
       seen.size === instancesOf(near) + instancesOf(far),
       `${seen.size} instancias distintas de ${instancesOf(near) + instancesOf(far)} esperadas`);
    ok("entre los tres grupos se reparten todas las instancias",
       r.tier0 + r.tier1 + r.culled === total,
       `${r.tier0} + ${r.tier1} + ${r.culled} = ${r.tier0 + r.tier1 + r.culled} de ${total}`);
    ok("el orden no repite ninguna instancia", dupes === 0, `${dupes} repetidas`);
    ok("el orden no saca indices del lote", outOfRange === 0, `${outOfRange} fuera de rango`);
  }
}

/** Un trazo borrado no aporta instancias, aunque su hueco siga en el buffer. */
{
  const st = settings();
  const scene = new StrokeScene();
  const pts: Sample3D[] = [];
  for (let i = 0; i < 30; i++) pts.push(sample3(i * 2, 0, -100, i, 0.5));
  const a = build3d(pts, st, null);
  if (a) {
    scene.add(a);
    const batch = scene.batchFor("L", "ribbon");
    scene.remove(a.id);
    if (batch) {
      const r = cullBatch(batch, CAM, { heightPx: 800, impostorPx: 8 });
      ok("un trazo borrado no aporta instancias al dibujo", r.tier0 + r.tier1 === 0);
    }
  }
}

/**
 * Reutilizar el buffer de orden entre fotogramas es obligatorio para no asignar
 * en cada uno, pero no puede arrastrar nada del fotograma anterior. La prueba
 * buena es comparar contra un descarte limpio del mismo estado: si el buffer
 * contaminara, los dos recuentos diferirian.
 */
{
  const st = settings({ size: 6 });
  const scene = new StrokeScene();
  const strokes: NonNullable<ReturnType<typeof build3d>>[] = [];
  for (let k = 0; k < 20; k++) {
    const pts: Sample3D[] = [];
    for (let i = 0; i < 40; i++) pts.push(sample3(i * 2, 0, -(60 + k * 40), i, 0.5));
    const s = build3d(pts, st, null, {}, 900 + k);
    if (s) {
      scene.add(s);
      strokes.push(s);
    }
  }
  const batch = scene.batchFor("L", "ribbon");
  if (batch) {
    const reusable = new Uint32Array(batch.instancesLaid + 64);
    const opts = { heightPx: 800, impostorPx: 8 };

    const first = cullBatch(batch, CAM, opts, reusable);
    const freshFirst = cullBatch(batch, CAM, opts);
    let sameAsFresh = first.tier0 === freshFirst.tier0 && first.tier1 === freshFirst.tier1;
    for (let i = 0; sameAsFresh && i < first.tier0 + first.tier1; i++) {
      if (first.order[i] !== freshFirst.order[i]) sameAsFresh = false;
    }
    ok("reutilizar el buffer da el mismo resultado que uno limpio", sameAsFresh,
       `${first.tier0 + first.tier1} vs ${freshFirst.tier0 + freshFirst.tier1} instancias`);

    // Ahora se borran trazos y se repite: el buffer trae basura del fotograma
    // anterior y el resultado tiene que seguir siendo correcto.
    for (const s of strokes.slice(0, 6)) scene.remove(s.id);
    const second = cullBatch(batch, CAM, opts, reusable);
    const freshSecond = cullBatch(batch, CAM, opts);
    let stillSame = second.tier0 === freshSecond.tier0 && second.tier1 === freshSecond.tier1;
    for (let i = 0; stillSame && i < second.tier0 + second.tier1; i++) {
      if (second.order[i] !== freshSecond.order[i]) stillSame = false;
    }
    ok("tras borrar, el buffer reutilizado sigue coincidiendo con uno limpio", stillSame,
       `${second.tier0 + second.tier1} vs ${freshSecond.tier0 + freshSecond.tier1} instancias`);
    ok("borrar reduce lo que se dibuja",
       second.tier0 + second.tier1 < first.tier0 + first.tier1,
       `${first.tier0 + first.tier1} -> ${second.tier0 + second.tier1} instancias`);
  }
}

/**
 * La prueba que atrapa el fallo mas caro que ha tenido este modulo.
 *
 * Cada segmento tiene que unir los puntos de SU trazo. Cuando el shader deducia
 * los puntos por su cuenta -leyendo `puntos[i]` y `puntos[i+1]` con el indice de
 * instancia- cualquier desplazamiento hacia que un trazo leyera los puntos de
 * otro: el ultimo dibujado no aparecia y los anteriores salian corridos, sin que
 * nada lanzara un error. Se comprueba extremo por extremo.
 */
{
  const st = settings();
  const scene = new StrokeScene();
  const strokes = [];
  for (let k = 0; k < 5; k++) {
    const pts: Sample3D[] = [];
    for (let i = 0; i < 25; i++) {
      pts.push(sample3(i * 8, k * 90 + Math.sin(i * 0.4) * 25, k * 40, i, 0.6));
    }
    const s = build3d(pts, st, null, {}, 300 + k);
    if (s) {
      scene.add(s);
      strokes.push(s);
    }
  }

  const batch = scene.batchFor("L", "ribbon");
  if (!batch) {
    ok("el lote de la prueba de alineacion existe", false);
  } else {
    let checked = 0;
    let badA = 0;
    let badB = 0;
    let badRadius = 0;

    for (let k = 0; k < strokes.length; k++) {
      const stroke = strokes[k];
      const range = batch.range(stroke.id);
      if (!range) continue;
      for (let i = 0; i < range.count; i++) {
        const o = (range.start + i) * INSTANCE_FLOATS;
        const a = i * POINT_FLOATS;
        const b = (i + 1) * POINT_FLOATS;
        checked++;
        if (
          batch.data[o + IA_POS] !== stroke.data[a + POS_OFFSET] ||
          batch.data[o + IA_POS + 1] !== stroke.data[a + POS_OFFSET + 1] ||
          batch.data[o + IA_POS + 2] !== stroke.data[a + POS_OFFSET + 2]
        ) {
          badA++;
        }
        if (
          batch.data[o + IB_POS] !== stroke.data[b + POS_OFFSET] ||
          batch.data[o + IB_POS + 1] !== stroke.data[b + POS_OFFSET + 1] ||
          batch.data[o + IB_POS + 2] !== stroke.data[b + POS_OFFSET + 2]
        ) {
          badB++;
        }
        if (
          batch.data[o + IA_RAD] !== stroke.data[a + RADIUS_OFFSET] ||
          batch.data[o + IB_RAD] !== stroke.data[b + RADIUS_OFFSET]
        ) {
          badRadius++;
        }
      }
    }

    ok("se comprueban todos los segmentos de todos los trazos", checked > 80,
       `${checked} segmentos`);
    ok("cada segmento empieza en un punto de su propio trazo", badA === 0,
       `${badA} extremos iniciales ajenos`);
    ok("cada segmento termina en el punto siguiente de su trazo", badB === 0,
       `${badB} extremos finales ajenos`);
    ok("los radios de cada segmento son los de sus dos puntos", badRadius === 0,
       `${badRadius} radios cruzados`);

    // Y en orden: los segmentos de un trazo van seguidos y sin huecos.
    let contiguous = true;
    let expectedStart = 0;
    for (const range of batch.ranges) {
      if (range.start !== expectedStart) contiguous = false;
      expectedStart = range.start + range.count;
    }
    ok("los rangos van seguidos, sin huecos", contiguous);
    ok("los segmentos del lote son los de todos los trazos",
       expectedStart === batch.segments, `${expectedStart} de ${batch.segments}`);

    // Un trazo de un solo punto no aporta ningun segmento, no uno degenerado.
    const dot = build3d([sample3(0, 0, 0, 0, 0.5)], st, null);
    if (dot) {
      const r = scene.add(dot);
      ok("un trazo de un punto no aporta segmentos", r.count === 0, `${r.count}`);
    }
  }
}

// ------------------------------------------------------------- camara 3D --

const camAt = (patch: Partial<Camera3DState> = {}): Camera3DState => ({
  ...DEFAULT_CAMERA_3D,
  yaw: 0,
  pitch: 0,
  px: 0,
  py: 0,
  pz: 0,
  distance: 100,
  ...patch,
});

/** Con la camara horizontal mirando a -Z, los ejes tienen que salir previsibles. */
{
  const c = camAt();
  const e = eyeOf(c);
  const fw = forwardOf(c);
  const rt = rightOf(c);
  const up = upOf(c);

  ok("el ojo queda detras del punto de mira", Math.abs(e.x) < 1e-9 && Math.abs(e.z - 100) < 1e-9,
     `ojo (${f(e.x, 3)}, ${f(e.y, 3)}, ${f(e.z, 3)})`);
  ok("la mirada apunta a -Z", Math.abs(fw.x) < 1e-9 && Math.abs(fw.z + 1) < 1e-9);
  ok("la derecha sale a +X", Math.abs(rt.x - 1) < 1e-9 && Math.abs(rt.z) < 1e-9);
  ok("con la camara horizontal el arriba es el del mundo",
     Math.abs(up.x) < 1e-9 && Math.abs(up.y - 1) < 1e-9 && Math.abs(up.z) < 1e-9);

  const dot = (a: typeof e, b: typeof e): number => a.x * b.x + a.y * b.y + a.z * b.z;
  ok("los tres ejes son perpendiculares entre si",
     Math.abs(dot(fw, rt)) < 1e-9 && Math.abs(dot(fw, up)) < 1e-9 && Math.abs(dot(rt, up)) < 1e-9);
}

/**
 * El arriba de la camara no es el del mundo cuando hay cabeceo. Confundirlos es el
 * error que hace que el desplazamiento vertical se vaya de lado al mirar desde
 * arriba.
 */
{
  const c = camAt({ pitch: 1.2, yaw: 0.8 });
  const up = upOf(c);
  const fw = forwardOf(c);
  const rt = rightOf(c);
  const dot = (a: typeof up, b: typeof up): number => a.x * b.x + a.y * b.y + a.z * b.z;

  ok("con cabeceo el arriba se inclina", Math.abs(up.z) > 0.1,
     `arriba (${f(up.x, 3)}, ${f(up.y, 3)}, ${f(up.z, 3)})`);
  ok("el arriba sigue siendo perpendicular a la mirada", Math.abs(dot(up, fw)) < 1e-9);
  ok("el arriba sigue siendo perpendicular a la derecha", Math.abs(dot(up, rt)) < 1e-9);
  ok("el arriba sigue siendo unitario", Math.abs(Math.hypot(up.x, up.y, up.z) - 1) < 1e-9);
}

/** El cabeceo se acota: pasar del cenit voltea la camara. */
{
  const c = camAt();
  for (let i = 0; i < 200; i++) orbit(c, 0, 0.1);
  ok("el cabeceo no pasa del cenit", c.pitch <= MAX_PITCH + 1e-12, `pitch ${f(c.pitch, 4)}`);
  for (let i = 0; i < 400; i++) orbit(c, 0, -0.1);
  ok("el cabeceo no pasa del nadir", c.pitch >= -MAX_PITCH - 1e-12, `pitch ${f(c.pitch, 4)}`);

  const before = c.yaw;
  orbit(c, 0.5, 0);
  ok("el giro horizontal es libre", Math.abs(c.yaw - before - 0.5) < 1e-12);
}

/** El zoom se acota por los dos extremos y el factor manda en la direccion. */
{
  const c = camAt({ distance: 100 });
  zoom(c, 0.5);
  ok("un factor menor que uno acerca", c.distance === 50, `distancia ${c.distance}`);
  zoom(c, 2);
  ok("un factor mayor que uno aleja", c.distance === 100, `distancia ${c.distance}`);

  for (let i = 0; i < 200; i++) zoom(c, 0.5);
  ok("el zoom no atraviesa el punto de mira", c.distance >= 0.5, `distancia ${f(c.distance, 4)}`);
  for (let i = 0; i < 400; i++) zoom(c, 2);
  ok("el zoom se detiene antes del infinito", c.distance <= 20000, `distancia ${f(c.distance, 0)}`);
}

/**
 * Desplazar tiene que llevar el punto de mira al contrario que el puntero: es lo
 * que hace que el dibujo siga al cursor en vez de huir de el.
 */
{
  const c = camAt();
  pan(c, 50, 0, 800);
  ok("arrastrar a la derecha mueve el punto de mira a la izquierda", c.px < 0,
     `px ${f(c.px, 3)}`);
  ok("arrastrar en horizontal no cambia la altura", Math.abs(c.py) < 1e-12);

  const c2 = camAt();
  pan(c2, 0, 40, 800);
  ok("arrastrar hacia abajo sube el punto de mira", c2.py > 0, `py ${f(c2.py, 3)}`);

  // El desplazamiento escala con la distancia, no con un numero fijo de pixeles.
  const cerca = camAt({ distance: 100 });
  const lejos = camAt({ distance: 1000 });
  pan(cerca, 50, 0, 800);
  pan(lejos, 50, 0, 800);
  ok("desplazar escala con la distancia",
     Math.abs(lejos.px / cerca.px - 10) < 1e-6,
     `${f(cerca.px, 3)} a 100 u, ${f(lejos.px, 3)} a 1000 u`);
}

/** Encajar una esfera tiene que dejarla dentro del cono de vision. */
{
  const c = camAt();
  frameSphere(c, 10, -20, 30, 50);
  ok("encajar centra en la esfera", c.px === 10 && c.py === -20 && c.pz === 30);
  const fr = cameraFrustum(c, 16 / 9);
  ok("tras encajar, el centro de la esfera se ve", sphereVisible(fr, 10, -20, 30, 1));
  ok("tras encajar, el borde de la esfera tambien se ve",
     sphereVisible(fr, 10 + 50, -20, 30, 1));
}

/** La proyeccion tiene que colocar los puntos donde dice la geometria. */
{
  const c = camAt();
  const vp = viewProjection(c, 1);

  const centro = projectPoint(vp, 0, 0, 0);
  ok("el punto de mira cae en el centro de la pantalla",
     Math.abs(centro.x) < 1e-6 && Math.abs(centro.y) < 1e-6,
     `(${f(centro.x, 6)}, ${f(centro.y, 6)})`);

  // El ojo esta en z = 100, asi que un punto en z = -50 queda a 150 unidades por
  // delante: w no es la coordenada z del mundo, es la profundidad respecto al ojo.
  const delante = projectPoint(vp, 0, 0, -50);
  ok("un punto delante tiene w positivo", delante.w > 0, `w ${f(delante.w, 3)}`);
  ok("w es la profundidad medida desde el ojo", Math.abs(delante.w - 150) < 1e-6,
     `w ${f(delante.w, 6)}, esperado 150`);
  ok("un punto delante conserva el centro en X",
     Math.abs(delante.x) < 1e-6 && Math.abs(delante.y) < 1e-6);

  const detras = projectPoint(vp, 0, 0, 200);
  ok("un punto detras de la camara tiene w negativo", detras.w < 0, `w ${f(detras.w, 3)}`);

  const derecha = projectPoint(vp, 10, 0, -50);
  ok("la derecha del mundo sale a la derecha en pantalla", derecha.x > 0,
     `x ${f(derecha.x, 4)}`);

  const lejos = viewProjection(camAt({ distance: 200 }), 1);
  const cerca = viewProjection(camAt({ distance: 50 }), 1);
  const a = projectPoint(lejos, 10, 0, 0);
  const b = projectPoint(cerca, 10, 0, 0);
  ok("acercar la camara agranda lo proyectado", b.x > a.x,
     `${f(a.x, 4)} a 200 u, ${f(b.x, 4)} a 50 u`);
}

// ------------------------------------------- control de camara y plano --

const mods = (patch: Partial<Modifiers3D> = {}): Modifiers3D => ({ ...NO_MODIFIERS, ...patch });

/**
 * La regla que evita el defecto mas molesto de un modo 3D: navegar nunca puede
 * dejar un trazo por el camino.
 */
{
  ok("el boton izquierdo dibuja, no navega", !navigatesWith(0, mods()));
  ok("el boton izquierdo tampoco navega con shift", !navigatesWith(0, mods({ shift: true })));
  ok("el boton central navega", navigatesWith(1, mods()));
  ok("el boton derecho navega", navigatesWith(2, mods()));
  ok("la barra espaciadora navega", navigatesWith(0, mods({ space: true })));
  ok("con lapiz la punta sigue dibujando", !navigatesWith(0, mods({ pen: true })));

  ok("el boton central no desplaza sin shift", !pansWith(1, mods()));
  ok("el boton central desplaza con shift", pansWith(1, mods({ shift: true })));
  ok("la barra espaciadora con shift desplaza", pansWith(0, mods({ space: true, shift: true })));
}

/** Un gesto de dibujo no puede tocar la camara, ni un pixel. */
{
  const cam = camAt();
  const ctrl = new CameraController3D(cam);
  const antes = { ...cam };

  const captured = ctrl.begin(0, mods(), 100, 100);
  ok("un gesto de dibujo no lo captura la camara", captured === false);
  ok("el controlador no se declara navegando", !ctrl.navigating);

  ctrl.move(160, 40, mods());
  ctrl.move(200, 10, mods());
  ok("arrastrar dibujando no mueve la camara",
     cam.yaw === antes.yaw && cam.pitch === antes.pitch && cam.px === antes.px,
     `yaw ${f(cam.yaw, 6)}, pitch ${f(cam.pitch, 6)}`);
}

/** Un gesto de camara si la mueve, y cambiar de shift a mitad no corta el gesto. */
{
  const cam = camAt();
  const ctrl = new CameraController3D(cam);

  ok("orbitar lo captura la camara", ctrl.begin(1, mods(), 0, 0) === true);
  ok("el controlador se declara navegando", ctrl.navigating);
  ctrl.move(60, 0, mods());
  ok("arrastrar orbitando gira la camara", Math.abs(cam.yaw) > 1e-6, `yaw ${f(cam.yaw, 4)}`);

  const yawAntes = cam.yaw;
  ctrl.move(60, 0, mods({ shift: true }));
  ok("pulsar shift a mitad de gesto cambia a desplazamiento", ctrl.current === "pan");
  ok("y deja de girar", Math.abs(cam.yaw - yawAntes) < 1e-12);

  ctrl.move(60, 0, mods());
  ok("soltar shift vuelve a orbitar", ctrl.current === "orbit");
  ctrl.end();
  ok("al soltar, el controlador deja de navegar", !ctrl.navigating);
}

/** El rayo del centro de la pantalla es la mirada de la camara. */
{
  const cam = camAt();
  const r = screenToRay(cam, 0, 0, 1);
  const fw = forwardOf(cam);
  ok("el rayo del centro apunta adonde mira la camara",
     Math.abs(r.dir.x - fw.x) < 1e-9 && Math.abs(r.dir.y - fw.y) < 1e-9 && Math.abs(r.dir.z - fw.z) < 1e-9);
  const eye = eyeOf(cam);
  ok("el rayo nace en el ojo",
     Math.abs(r.origin.x - eye.x) < 1e-9 && Math.abs(r.origin.z - eye.z) < 1e-9);

  const arriba = screenToRay(cam, 0, 1, 1);
  ok("el rayo de arriba se desvia hacia arriba", arriba.dir.y > fw.y,
     `dir.y ${f(arriba.dir.y, 4)} frente a ${f(fw.y, 4)}`);
  const derecha = screenToRay(cam, 1, 0, 1);
  ok("el rayo de la derecha se desvia a la derecha", derecha.dir.x > fw.x);
  ok("todos los rayos son unitarios",
     Math.abs(Math.hypot(derecha.dir.x, derecha.dir.y, derecha.dir.z) - 1) < 1e-9);
}

/** Los casos degenerados del plano. */
{
  const o = v3(0, 0, 0);
  const plano = v3(0, 0, -10);
  const n = v3(0, 0, 1);

  const hit = rayToPlane(o, v3(0, 0, -1), plano, n);
  ok("un rayo perpendicular al plano lo corta", hit !== null && Math.abs(hit.z + 10) < 1e-9,
     hit ? `z ${f(hit.z, 3)}` : "sin corte");

  ok("un rayo paralelo al plano no lo corta",
     rayToPlane(o, v3(1, 0, 0), plano, n) === null);
  ok("un plano detras de la camara no se corta",
     rayToPlane(o, v3(0, 0, 1), plano, n) === null);
}

/**
 * La prueba que garantiza que dibujar cae bajo el cursor: se proyecta un punto de
 * la pantalla al plano de dibujo y se vuelve a proyectar. Si no vuelve al mismo
 * sitio, el trazo aparece desplazado respecto al puntero.
 */
{
  const aspect = 16 / 9;
  const cam = camAt({ yaw: 0.7, pitch: 0.4, distance: 250 });
  const vp = viewProjection(cam, aspect);

  let worst = 0;
  for (const [nx, ny] of [
    [0, 0],
    [0.5, 0.5],
    [-0.7, 0.3],
    [0.9, -0.9],
    [-0.2, 0.85],
  ]) {
    const world = rayToCameraPlane(cam, nx, ny, aspect);
    if (!world) {
      worst = Infinity;
      break;
    }
    const back = projectPoint(vp, world.x, world.y, world.z);
    worst = Math.max(worst, Math.abs(back.x - nx), Math.abs(back.y - ny));
  }
  ok("el punto del plano vuelve exactamente bajo el cursor", worst < 1e-5,
     `desvio max ${f(worst, 8)} en NDC`);
}

/** El plano de profundidad fija separa los trazos en Z. */
{
  const cam = camAt();
  const fw = forwardOf(cam);
  const p = rayToDepthPlane(cam, 0, 0, 1, 120);
  ok("el plano de profundidad respeta la distancia pedida",
     p !== null && Math.abs((p.x - cam.px) * fw.x + (p.y - cam.py) * fw.y + (p.z - cam.pz) * fw.z - 120) < 1e-6);

  const a = rayToDepthPlane(cam, 0.3, 0.2, 1, 0);
  const b = rayToDepthPlane(cam, 0.3, 0.2, 1, 500);
  ok("dos profundidades distintas dan puntos distintos",
     a !== null && b !== null && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 1);

  ok("redondear la profundidad la lleva a la rejilla", snapDepth(137, 25) === 125,
     `${snapDepth(137, 25)}`);
  ok("sin rejilla la profundidad no cambia", snapDepth(137, 0) === 137);
}

/** Acercar con el cursor encima no debe mover el punto que se esta mirando. */
{
  const cam = camAt({ yaw: 0.7, pitch: 0.4, distance: 400 });
  const ctrl = new CameraController3D(cam);
  const aspect = 16 / 9;

  const antes = ctrl.projectToPlane(0.4, -0.3, aspect);
  ctrl.zoomAt(2, 0.4, -0.3, aspect);
  const despues = ctrl.projectToPlane(0.4, -0.3, aspect);

  ok("acercar reduce la distancia", cam.distance < 400, `${f(cam.distance, 1)}`);
  const moved =
    antes && despues ? Math.hypot(antes.x - despues.x, antes.y - despues.y, antes.z - despues.z) : Infinity;
  ok("el punto bajo el cursor no se mueve al acercar", moved < 1e-6, `desvio ${f(moved, 8)}`);
}

// ------------------------------------------------- capas del espacio --

/**
 * La escena tiene que ser funcion pura de la lista de trazos del documento.
 *
 * De esa propiedad salen gratis deshacer, rehacer y editar un trazo ya dibujado:
 * los tres cambian la lista, y la escena se limita a seguirla. Lo que se mide
 * aqui es que ninguna de las tres deje el buffer mintiendo.
 */
{
  const scene = new StrokeScene();
  const s1 = planarStroke([[0, 0], [60, 0], [120, 0]], 5);
  const s2 = planarStroke([[0, 100], [60, 100], [120, 100]], 5);

  ok("sin trazos no hay lotes", scene.sync([]) === false && scene.all.length === 0);

  scene.sync([s1, s2]);
  ok("los trazos del documento entran en la escena", scene.all.length === 1, `${scene.all.length} lotes`);
  ok("y quedan sus dos rangos", scene.instances === 4, `${scene.instances} instancias`);

  scene.sync([s1]);
  ok("quitar un trazo lo saca de la escena", scene.instances === 2 && scene.range(s2.id) === undefined);

  // Editar: mismo id, otra referencia, otra forma.
  const editado = {
    ...planarStroke([[0, 0], [60, 30], [120, 0]], 5),
    id: s1.id,
    brush: s1.brush,
    color: s1.color,
    layerId: s1.layerId,
  };
  scene.sync([editado]);
  const r = scene.range(s1.id);
  ok("editar un trazo reescribe su hueco sin moverlo", r?.start === 0 && r?.count === 2);
  ok("y el lote guarda la version nueva", r?.stroke === editado);

  // Lo que de verdad importa de `rewrite`: que los segmentos del buffer sean los
  // del trazo nuevo y no los del viejo.
  const batch = scene.all[0];
  let worst = 0;
  for (let i = 0; i < 2; i++) {
    const o = i * INSTANCE_FLOATS;
    for (let k = 0; k < 3; k++) {
      const esperado = editado.data[(i + 1) * POINT_FLOATS + k];
      worst = Math.max(worst, Math.abs(batch.data[o + IB_POS + k] - esperado));
    }
  }
  ok("los segmentos del buffer son los del trazo editado", worst < 1e-6, `desvio ${f(worst, 8)}`);

  // Cambiar el numero de puntos no cabe en el hueco: se olvida y se anade.
  const larga = {
    ...planarStroke([[0, 0], [40, 20], [80, 0], [120, 20]], 5),
    id: s1.id,
    brush: s1.brush,
    color: s1.color,
    layerId: s1.layerId,
  };
  scene.sync([larga]);
  ok("un trazo con mas puntos se recoloca entero", scene.instances === 3 && scene.range(s1.id)?.count === 3);

  scene.sync([]);
  ok("vaciar la lista deja la escena sin lotes", scene.all.length === 0);
}

/** Deshacer y rehacer pasan por la misma reconciliacion, y tienen que cuadrar. */
{
  const scene = new StrokeScene();
  const a = planarStroke([[0, 0], [50, 0]], 4);
  const b = planarStroke([[0, 50], [50, 50]], 4);

  scene.sync([a]);
  const uno = scene.instances;
  scene.sync([a, b]);
  const dos = scene.instances;
  scene.sync([a]);
  const vuelta = scene.instances;

  ok(
    "ir y volver en el historial deja el mismo dibujo",
    uno === vuelta && dos > uno,
    `${uno} / ${dos} / ${vuelta}`,
  );
}

// El documento guarda los trazos del espacio, no el visor.
{
  const doc = new SceneDocument();
  const capa = doc.scene3dTarget();
  ok("la primera vez se crea la capa del espacio", capa.kind === "scene3d" && doc.scene3dLayers.length === 1);
  ok("y no se duplica al pedirla otra vez", doc.scene3dTarget().id === capa.id && doc.scene3dLayers.length === 1);

  const s = { ...planarStroke([[0, 0], [30, 0], [60, 0]], 3), layerId: capa.id };
  doc.addStroke3D(s);
  ok("el trazo entra en su capa", doc.strokesOf(capa.id).length === 1 && doc.strokes3d.length === 1);
  ok("el documento deja de estar vacio", doc.isEmpty === false);

  // Un trazo que apunta a una capa que no existe se reagrupa en una del espacio.
  doc.strokes3d.push({ ...planarStroke([[0, 0], [10, 0]], 3), id: "huerfano", layerId: "no-existe" });
  doc.ensureLayers();
  ok(
    "un trazo huerfano se reagrupa en una capa del espacio",
    doc.strokes3d.every((x) => doc.scene3dLayers.some((l) => l.id === x.layerId)),
    `${doc.scene3dLayers.length} capas del espacio`,
  );

  // Borrar la capa se lleva sus trazos: dejarlos sin capa los devolveria a otra y
  // el dibujo cambiaria de sitio sin que nadie lo pidiera.
  const antes = doc.strokes3d.length;
  doc.removeLayer(capa.id);
  ok("borrar la capa se lleva sus trazos", doc.strokes3d.length < antes && doc.strokesOf(capa.id).length === 0);
}

{
  const doc = new SceneDocument();
  const otra = doc.addScene3DLayer("Otra");
  doc.addStroke3D({ ...planarStroke([[0, 0], [20, 0]], 3), layerId: otra.id });
  const n = doc.clearStrokes3D(otra.id);
  ok("vaciar una capa del espacio devuelve cuantos se llevo", n === 1 && doc.strokes3d.length === 0);
  ok("y vaciar una capa ya vacia no hace nada", doc.clearStrokes3D(otra.id) === 0);
}

/**
 * La instantanea del historial tiene que llevarse los trazos del espacio y el
 * punto de vista. Los trazos van por REFERENCIA, que es lo que hace que 80 pasos
 * de historial de un dibujo denso cuesten punteros y no megabytes.
 */
{
  const doc = new SceneDocument();
  const capa = doc.scene3dTarget();
  const s = { ...planarStroke([[0, 0], [10, 0], [20, 0]], 2), layerId: capa.id };
  doc.addStroke3D(s);
  doc.camera3d.yaw = 1.25;
  doc.camera3d.distance = 321;

  const snap = doc.snapshot();
  ok("la instantanea se lleva el trazo", snap.strokes3d.length === 1 && snap.strokes3d[0] === s);
  ok("y el punto de vista", Math.abs(snap.camera3d.yaw - 1.25) < 1e-9);

  doc.removeStroke3D(s.id);
  doc.camera3d.yaw = 0;
  ok("quitar el trazo deja el documento sin el", doc.strokes3d.length === 0);

  doc.restore(snap);
  ok("deshacer devuelve el trazo", doc.strokes3d.length === 1 && doc.strokes3d[0] === s);
  ok(
    "y devuelve el punto de vista",
    Math.abs(doc.camera3d.yaw - 1.25) < 1e-9 && doc.camera3d.distance === 321,
  );
}

/**
 * Ojo propio y de los ancestros: es la regla que decide si una capa del espacio
 * se dibuja, y la comparten el visor, el compositor 2D y la exportacion.
 */
{
  const doc = new SceneDocument();
  const grupo = doc.addGroup();
  const capa = doc.addScene3DLayer();
  doc.moveLayerTo(capa.id, grupo.id, 0);
  const setVisible = (id: string, v: boolean): void => {
    const l = doc.layerById(id);
    if (l) l.visible = v;
  };

  ok("una capa visible dentro de un grupo visible se ve", doc.layerVisible(capa.id) === true);
  setVisible(grupo.id, false);
  ok("apagar el grupo apaga a su hija", doc.layerVisible(capa.id) === false);
  setVisible(grupo.id, true);
  setVisible(capa.id, false);
  ok("y su propio ojo manda", doc.layerVisible(capa.id) === false);
  ok("una capa que no existe no se ve", doc.layerVisible("no-existe") === false);
}



// ------------------------------------------------- suavizar y arrastrar --

/** Desviacion maxima de los puntos de un trazo respecto a la recta y = 0. */
const wobble = (s: Stroke3D): number => {
  let worst = 0;
  for (let i = 0; i < s.count; i++) {
    worst = Math.max(worst, Math.abs(s.data[i * POINT_FLOATS + POS_OFFSET + 1]));
  }
  return worst;
};

/** Un trazo recto con ruido deterministico encima. */
const noisyLine = (n: number, amp: number): Stroke3D => {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    pts.push([i * 10, Math.sin(i * 1.7) * amp + Math.sin(i * 0.31) * amp * 0.5]);
  }
  return planarStroke(pts, 4);
};

{
  const original = noisyLine(40, 3);
  const suave = relaxStroke(original, { strength: 0.8, iterations: 3, radius: false, ends: false });

  ok("suavizar devuelve un trazo nuevo", suave !== null && suave !== original);
  ok("suavizar no cambia el numero de puntos", suave?.count === original.count, `${suave?.count}`);
  ok(
    "el trazo suavizado ondula menos",
    !!suave && wobble(suave) < wobble(original) * 0.5,
    `${f(wobble(original), 3)} -> ${f(suave ? wobble(suave) : -1, 3)}`,
  );

  // Los cabos se quedan: relajarlos los mete hacia dentro y el trazo encogeria por
  // los dos lados en cada pasada.
  const cabo = (s: Stroke3D, i: number): [number, number, number] => [
    s.data[i * POINT_FLOATS + POS_OFFSET],
    s.data[i * POINT_FLOATS + POS_OFFSET + 1],
    s.data[i * POINT_FLOATS + POS_OFFSET + 2],
  ];
  const a0 = cabo(original, 0);
  const a1 = cabo(suave as Stroke3D, 0);
  const b0 = cabo(original, original.count - 1);
  const b1 = cabo(suave as Stroke3D, suave!.count - 1);
  const desplazado = Math.max(
    Math.abs(a0[0] - a1[0]) + Math.abs(a0[1] - a1[1]) + Math.abs(a0[2] - a1[2]),
    Math.abs(b0[0] - b1[0]) + Math.abs(b0[1] - b1[1]) + Math.abs(b0[2] - b1[2]),
  );
  ok("los cabos no se mueven al suavizar", desplazado < 1e-6, `desvio ${f(desplazado, 8)}`);

  // El id y el plano son lo que permite reescribir el hueco del lote y rehacer los
  // marcos sin que la cinta se retuerza.
  ok(
    "el trazo suavizado conserva su identidad y su plano",
    suave?.id === original.id && suave?.planeNormal?.z === 1,
    `${suave?.id} / ${suave?.planeNormal?.z}`,
  );

  // Los marcos se rehacen: si no, la cinta se orientaria con la forma vieja.
  let peorNorma = 0;
  for (let i = 0; i < (suave?.count ?? 0); i++) {
    const o = i * POINT_FLOATS;
    const nx = suave!.data[o + 3];
    const ny = suave!.data[o + 4];
    const nz = suave!.data[o + 5];
    peorNorma = Math.max(peorNorma, Math.abs(Math.hypot(nx, ny, nz) - 1));
  }
  ok("y sus marcos quedan unitarios", peorNorma < 1e-6, `desvio ${f(peorNorma, 8)}`);

  ok("un trazo de dos puntos no se puede suavizar", relaxStroke(planarStroke([[0, 0], [10, 0]], 4)) === null);
  ok("fuerza cero no cambia nada", relaxStroke(original, { strength: 0, iterations: 1, radius: false, ends: false }) === null);
}

{
  // El peso de agarre: 1 en el centro, 0 en el borde del radio.
  ok("el centro agarra del todo", falloff(0, 50) === 1, f(falloff(0, 50), 4));
  ok("el borde del radio no agarra nada", falloff(50, 50) === 0 && falloff(60, 50) === 0);
  const medio = falloff(25, 50);
  ok("y en medio agarra en medio", medio > 0 && medio < 1, f(medio, 4));
  let monotono = true;
  let previo = Infinity;
  for (let d = 0; d <= 50; d += 5) {
    const w = falloff(d, 50);
    if (w > previo) monotono = false;
    previo = w;
  }
  ok("el agarre decrece con la distancia", monotono);
  ok("un radio nulo no agarra", falloff(0, 0) === 0);
}

{
  const original = planarStroke([[0, 0], [50, 0], [100, 0], [150, 0]], 5);
  ok("se sabe si un trazo cae dentro del radio", touches(original, v3(50, 0, 0), 10) === true);
  ok("y si no cae, tambien", touches(original, v3(50, 200, 0), 10) === false);
  ok("un radio nulo no toca nada", touches(original, v3(50, 0, 0), 0) === false);

  const agarre = v3(50, 0, 0);
  const delta = v3(0, 30, 0);
  const movido = pullStroke(original, agarre, delta, 60);
  ok("arrastrar devuelve un trazo nuevo", movido !== null && movido !== original);

  const y = (s: Stroke3D, i: number): number => s.data[i * POINT_FLOATS + POS_OFFSET + 1];
  // El punto del centro se mueve entero; los de los cabos, nada.
  ok("el centro se mueve todo el desplazamiento", Math.abs(y(movido as Stroke3D, 1) - 30) < 1e-5, f(y(movido as Stroke3D, 1), 4));
  ok("los cabos, fuera del radio, no se mueven", y(movido as Stroke3D, 0) === 0 && y(movido as Stroke3D, 3) === 0);
  ok("el id se conserva para poder reescribir su hueco", movido?.id === original.id);

  // La propiedad que importa del arrastre: se aplica el desplazamiento TOTAL sobre
  // la forma original en cada fotograma, asi que volver al punto de partida
  // devuelve el trazo a su sitio en vez de dejarlo a medio camino.
  const vuelta = pullStroke(original, agarre, v3(0, 0, 0), 60);
  ok("con desplazamiento nulo no se mueve nada", vuelta !== null);
  let peor = 0;
  for (let i = 0; i < original.count; i++) {
    peor = Math.max(peor, Math.abs(y(vuelta as Stroke3D, i) - y(original, i)));
  }
  ok("volver al punto de partida devuelve el trazo a su sitio", peor < 1e-6, `desvio ${f(peor, 8)}`);

  ok("arrastrar donde no hay nada no devuelve trazo", pullStroke(original, v3(0, 500, 0), delta, 20) === null);
  ok("un radio nulo no agarra nada", pullStroke(original, agarre, delta, 0) === null);
}

/** El trazo editado tiene que llegar al buffer del lote, no solo al documento. */
{
  const scene = new StrokeScene();
  const original = noisyLine(30, 4);
  scene.sync([original]);
  const antes = scene.all[0].data.slice(0, 29 * INSTANCE_FLOATS);

  const suave = relaxStroke(original, { strength: 0.9, iterations: 4, radius: false, ends: false });
  ok("editar y reconciliar acepta el trazo", !!suave && scene.sync([suave as Stroke3D]) === true);

  const despues = scene.all[0].data.slice(0, 29 * INSTANCE_FLOATS);
  let cambiado = 0;
  for (let i = 0; i < antes.length; i++) if (Math.abs(antes[i] - despues[i]) > 1e-6) cambiado++;
  ok("y los segmentos del buffer cambian de verdad", cambiado > 0, `${cambiado} floats distintos`);
  ok("sin mover el trazo de sitio", scene.instances === 29, `${scene.instances} instancias`);
}

// ---------------------------------------------------------------- relleno --

/** Contorno en el plano XY a partir de puntos 2D. */
const outlineOf = (pts: readonly [number, number][]): Float32Array => {
  const out = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    out[i * 3] = pts[i][0];
    out[i * 3 + 1] = pts[i][1];
    out[i * 3 + 2] = 0;
  }
  return out;
};

const PLANO_Z = v3(0, 0, 1);

{
  // Un cuadrado: dos triangulos y el area exacta.
  const cuadrado: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const outline = outlineOf(cuadrado);
  const area = outlineArea(outline, 4, PLANO_Z);
  ok("el area del contorno es la del cuadrado", Math.abs(area - 10000) < 1e-6, f(area, 3));

  const tris = triangulateOutline(outline, 4, PLANO_Z);
  ok("un cuadrado sale en dos triangulos", tris.length === 18, `${tris.length / 9} triangulos`);
  const cubierto = trianglesArea(tris);
  ok(
    "y los triangulos cubren el contorno entero",
    Math.abs(cubierto - area) < 1e-6,
    `${f(cubierto, 3)} frente a ${f(area, 3)}`,
  );

  // El sentido de giro no debe importar: se dibuja como salga.
  const alReves = outlineOf([...cuadrado].reverse() as [number, number][]);
  const trisRev = triangulateOutline(alReves, 4, PLANO_Z);
  ok(
    "el sentido de giro del contorno da igual",
    Math.abs(trianglesArea(trisRev) - area) < 1e-6,
    f(trianglesArea(trisRev), 3),
  );
}

/**
 * El caso que de verdad discrimina: un contorno CONCAVO.
 *
 * Un abanico desde el centro solo rellena bien lo convexo; en una ese, deja
 * triangulos fuera y huecos dentro. Es la razon de usar recorte de orejas, y por
 * eso la comprobacion es que el area sumada sea EXACTAMENTE la del contorno: un
 * abanico mal puesto sumaria de mas.
 */
{
  // Una ese: barra de 100x40 abajo y columna de 40x60 encima. Area 6400.
  const ese: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 40],
    [40, 40],
    [40, 100],
    [0, 100],
  ];
  const outline = outlineOf(ese);
  const area = outlineArea(outline, ese.length, PLANO_Z);
  ok("el area de la ese es la esperada", Math.abs(area - 6400) < 1e-6, f(area, 3));

  const tris = triangulateOutline(outline, ese.length, PLANO_Z);
  ok("una ese sale en n-2 triangulos", tris.length === (ese.length - 2) * 9, `${tris.length / 9}`);
  const cubierto = trianglesArea(tris);
  ok(
    "y la cubren sin salirse ni solaparse",
    Math.abs(cubierto - area) < 1e-6,
    `${f(cubierto, 3)} frente a ${f(area, 3)}`,
  );
}

{
  // Un contorno degenerado no produce geometria: no hay nada que rellenar.
  ok("dos puntos no son un contorno", triangulateOutline(outlineOf([[0, 0], [10, 0]]), 2, PLANO_Z).length === 0);
  const linea = outlineOf([[0, 0], [50, 0], [100, 0]]);
  ok("un contorno sin area no rellena", triangulateOutline(linea, 3, PLANO_Z).length === 0);
  ok("y su area es cero", outlineArea(linea, 3, PLANO_Z) === 0);
}

/** Newell: la normal del contorno, para cuando se dibujo en el aire. */
{
  const cuadrado = outlineOf([[0, 0], [100, 0], [100, 100], [0, 100]]);
  const n = outlineNormal(cuadrado, 4);
  ok("Newell da una normal unitaria", Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-6);
  ok("y perpendicular al plano del contorno", Math.abs(n.z) > 0.999, f(n.z, 4));
}

/** Los lotes de manchas: una malla por (capa, color), rehecha cuando cambia. */
{
  const scene = new FillScene();
  const cuadro: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const a = makeFill("f1", outlineOf(cuadro), 4, {
    color: "#ff0000",
    layerId: "L",
    planeNormal: PLANO_Z,
  });
  const b = makeFill("f2", outlineOf(cuadro.map(([x, y]) => [x + 200, y] as [number, number])), 4, {
    color: "#ff0000",
    layerId: "L",
    planeNormal: PLANO_Z,
  });

  ok("sin manchas no hay mallas", scene.sync([]) === false && scene.all.length === 0);
  scene.sync([a, b]);
  ok("dos manchas del mismo color comparten malla", scene.all.length === 1, `${scene.all.length} mallas`);
  ok("y suman sus vertices", scene.vertices === 12, `${scene.vertices} vertices`);

  const malla = scene.all[0];
  ok("las normales van por vertice", malla.normals.length === malla.positions.length && malla.vertices > 0);
  ok(
    "y son las del plano de la mancha",
    Math.abs(malla.normals[2] - 1) < 1e-6 && Math.abs(malla.normals[0]) < 1e-6,
    `(${f(malla.normals[0], 3)}, ${f(malla.normals[1], 3)}, ${f(malla.normals[2], 3)})`,
  );

  // Colores distintos, mallas distintas: el color es constante del material.
  const c = makeFill("f3", outlineOf(cuadro), 4, {
    color: "#00ff00",
    layerId: "L",
    planeNormal: PLANO_Z,
  });
  scene.sync([a, b, c]);
  ok("otro color estrena malla", scene.all.length === 2, `${scene.all.length} mallas`);

  scene.sync([a]);
  ok("quitar una mancha rehace su malla", scene.vertices === 6, `${scene.vertices} vertices`);

  // El gasto se detecta por referencia: si nada cambio, no se retriangula.
  const antes = scene.all[0].revision;
  ok("una lista identica no rehace nada", scene.sync([a]) === false && scene.all[0].revision === antes);

  scene.sync([]);
  ok("vaciar deja la escena sin mallas", scene.all.length === 0);
}

/** Las manchas tienen que llegar tambien al documento y al proyecto. */
{
  const doc = new SceneDocument();
  const capa = doc.scene3dTarget();
  const f = makeFill("f1", outlineOf([[0, 0], [50, 0], [50, 50], [0, 50]]), 4, {
    color: "#123456",
    layerId: capa.id,
    planeNormal: PLANO_Z,
  });
  doc.addFill3D(f);
  ok("la mancha entra en el documento", doc.fills3d.length === 1 && doc.fillsOf(capa.id).length === 1);
  ok("y el documento deja de estar vacio", doc.isEmpty === false);

  const snap = doc.snapshot();
  doc.removeFill3D(f.id);
  ok("quitarla deja el documento sin ella", doc.fills3d.length === 0);
  doc.restore(snap);
  ok("deshacer la devuelve por referencia", doc.fills3d[0] === f);

  // Huerfana: se reagrupa en una capa del espacio, igual que los trazos.
  doc.fills3d.push({ ...f, id: "huerfana", layerId: "no-existe" });
  doc.ensureLayers();
  ok(
    "una mancha huerfana se reagrupa",
    doc.fills3d.every((x) => doc.scene3dLayers.some((l) => l.id === x.layerId)),
  );

  ok("borrar la capa se lleva sus manchas", (doc.removeLayer(capa.id), doc.fills3d.length === 0));
}

console.log(out.join("\n"));
const fails = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${out.length - fails}/${out.length} en verde`);
console.log(failed ? "3D: HAY FALLOS" : "3D: TODO EN VERDE");
if (failed) process.exitCode = 1;
