import { TAU, clamp01, lerp } from "../core/math";
import type { Rng } from "../core/rng";
import type { Polygon } from "../stroke/types";

export type PullFamily = "blob" | "leaf" | "splinter" | "petal" | "crescent" | "ribbon" | "rune";

export const PULL_FAMILIES: PullFamily[] = [
  "blob",
  "leaf",
  "splinter",
  "petal",
  "crescent",
  "ribbon",
  "rune",
];

export const PULL_LABELS: Record<PullFamily | "random", string> = {
  random: "Aleatoria",
  blob: "Mancha",
  leaf: "Hoja",
  splinter: "Astilla",
  petal: "Petalo",
  crescent: "Luna",
  ribbon: "Cinta",
  rune: "Runa",
};

/**
 * Generador procedural de formas "pull".
 *
 * Webchemy llevaba una lista fija de paths SVG: siempre salian las mismas
 * siluetas. Aqui cada forma se genera con ruido controlado, asi que la familia
 * elegida define el caracter (hoja, astilla, luna...) pero nunca se repite el
 * mismo dibujo. Todas se devuelven en espacio unitario, con el eje X a lo largo
 * del arrastre y alto ~1, para que el editor solo tenga que escalar y rotar.
 */
export function pullShape(family: PullFamily, rng: Rng, detail = 64): Polygon {
  switch (family) {
    case "blob":
      return blob(rng, detail);
    case "leaf":
      return leaf(rng, detail);
    case "splinter":
      return splinter(rng);
    case "petal":
      return petal(rng, detail);
    case "crescent":
      return crescent(rng, detail);
    case "ribbon":
      return ribbon(rng, detail);
    case "rune":
      return rune(rng);
  }
}

export function randomPullShape(rng: Rng, detail = 64): Polygon {
  return pullShape(rng.pick(PULL_FAMILIES), rng, detail);
}

/** Ruido periodico suave: suma de senos con fases aleatorias. */
function wobble(rng: Rng, harmonics: number): (t: number) => number {
  const amps: number[] = [];
  const phases: number[] = [];
  for (let i = 0; i < harmonics; i++) {
    amps.push(rng.range(0.6, 1) / (i + 1.6));
    phases.push(rng.range(0, TAU));
  }
  return (t: number) => {
    let v = 0;
    for (let i = 0; i < harmonics; i++) {
      v += amps[i] * Math.sin((i + 2) * t + phases[i]);
    }
    return v / harmonics;
  };
}

function blob(rng: Rng, detail: number): Polygon {
  const w = wobble(rng, 4);
  const amount = rng.range(0.16, 0.42);
  const squash = rng.range(0.55, 1);
  const out: Polygon = [];
  for (let i = 0; i < detail; i++) {
    const t = (TAU * i) / detail;
    const r = 0.5 * (1 + w(t) * amount);
    out.push({ x: Math.cos(t) * r, y: Math.sin(t) * r * squash });
  }
  return out;
}

function leaf(rng: Rng, detail: number): Polygon {
  const bulge = rng.range(0.28, 0.55);
  const skew = rng.range(-0.35, 0.35);
  const tipSharp = rng.range(1.1, 2.4);
  const w = wobble(rng, 3);
  const out: Polygon = [];
  const half = Math.max(8, Math.round(detail / 2));
  for (let i = 0; i <= half; i++) {
    const t = i / half;
    const profile = Math.pow(Math.sin(Math.PI * t), tipSharp) * bulge;
    const wob = 1 + w(t * Math.PI * 2) * 0.18;
    out.push({ x: t - 0.5, y: -profile * wob + skew * t * (1 - t) * 2 });
  }
  for (let i = half; i >= 0; i--) {
    const t = i / half;
    const profile = Math.pow(Math.sin(Math.PI * t), tipSharp) * bulge * rng.range(0.85, 1.0);
    out.push({ x: t - 0.5, y: profile + skew * t * (1 - t) * 2 });
  }
  return out;
}

function splinter(rng: Rng): Polygon {
  const steps = rng.int(5, 11);
  const out: Polygon = [];
  let y = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    y = lerp(y, rng.range(-0.3, 0.3), 0.7);
    out.push({ x: t - 0.5, y: y * (1 - t) - 0.02 });
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const thick = (1 - t) * rng.range(0.1, 0.4) + 0.01;
    out.push({ x: t - 0.5, y: out[i].y + thick });
  }
  return out;
}

function petal(rng: Rng, detail: number): Polygon {
  const lobes = rng.int(3, 8);
  const depth = rng.range(0.25, 0.6);
  const twist = rng.range(-0.6, 0.6);
  const out: Polygon = [];
  for (let i = 0; i < detail; i++) {
    const t = (TAU * i) / detail;
    const r = 0.5 * (1 - depth + depth * Math.abs(Math.cos((lobes * t) / 2)));
    const a = t + twist * Math.sin(t);
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

function crescent(rng: Rng, detail: number): Polygon {
  const offset = rng.range(0.24, 0.48);
  const inner = rng.range(0.6, 0.92);
  const open = rng.range(0.35, 1.05);
  const out: Polygon = [];
  const half = Math.max(10, Math.round(detail / 2));
  const a0 = -Math.PI / 2 + open;
  const a1 = Math.PI * 1.5 - open;
  for (let i = 0; i <= half; i++) {
    const a = lerp(a0, a1, i / half);
    out.push({ x: Math.cos(a) * 0.5, y: Math.sin(a) * 0.5 });
  }
  for (let i = half; i >= 0; i--) {
    const a = lerp(a0, a1, i / half);
    out.push({ x: Math.cos(a) * 0.5 * inner + offset * 0.5, y: Math.sin(a) * 0.5 * inner });
  }
  return out;
}

function ribbon(rng: Rng, detail: number): Polygon {
  const waves = rng.range(1.2, 3.4);
  const amp = rng.range(0.12, 0.34);
  const thick = rng.range(0.08, 0.22);
  const taper = rng.range(0, 1);
  const out: Polygon = [];
  const n = Math.max(12, detail);
  const top: Polygon = [];
  const bottom: Polygon = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = t - 0.5;
    const y = Math.sin(t * Math.PI * waves) * amp;
    const th = thick * lerp(1, Math.sin(Math.PI * t) + 0.15, taper);
    top.push({ x, y: y - th });
    bottom.push({ x, y: y + th });
  }
  out.push(...top);
  for (let i = bottom.length - 1; i >= 0; i--) out.push(bottom[i]);
  return out;
}

function rune(rng: Rng): Polygon {
  // Poligono anguloso: radios alternos con saltos bruscos, sin suavizar.
  const n = rng.int(5, 11);
  const out: Polygon = [];
  for (let i = 0; i < n; i++) {
    const t = (TAU * i) / n + rng.range(-0.12, 0.12);
    const r = 0.5 * (i % 2 === 0 ? rng.range(0.85, 1) : rng.range(0.28, 0.62));
    out.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
  }
  return out;
}

/**
 * Coloca una forma unitaria a lo largo del arrastre.
 *
 * `ax,ay` es donde bajo el lapiz y `bx,by` donde esta ahora: la forma se
 * estira entre ambos puntos y su grosor crece con `spread`. Es la mecanica de
 * "tirar" de Alchemy, pero continua en vez de por pasos.
 */
export function placePullShape(
  shape: Polygon,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  spread: number,
  minLength: number,
): Polygon {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(minLength, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const sy = len * clamp01(spread) + minLength * 0.35;

  const out: Polygon = new Array(shape.length);
  for (let i = 0; i < shape.length; i++) {
    const lx = shape[i].x * len;
    const ly = shape[i].y * sy;
    out[i] = { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
  }
  return out;
}
