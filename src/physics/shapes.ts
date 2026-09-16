import { apply, isIdentity, type Mat2d } from "../core/mat2d";
import { TAU } from "../core/math";
import { Rng } from "../core/rng";
import type { Polygon } from "../stroke/types";
import type { Vec2 } from "../core/vec2";

export type ShapeKind = "circle" | "box" | "capsule" | "ngon" | "star";

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  circle: "Circulo",
  box: "Rectangulo",
  capsule: "Capsula",
  ngon: "Poligono",
  star: "Estrella",
};

/** Codigos que viajan al shader. Deben coincidir con field.frag. */
export const SHAPE_CODE: Record<ShapeKind, number> = {
  circle: 0,
  box: 1,
  capsule: 2,
  ngon: 3,
  star: 4,
};

export interface ShapeDef {
  kind: ShapeKind;
  /** Radio caracteristico (circunradio / semialto). */
  size: number;
  /** Relacion ancho/alto para caja y capsula. */
  aspect: number;
  /** Lados de poligono y puntas de estrella. */
  sides: number;
  /** Radio interior relativo de la estrella (0..1). */
  inner: number;
  /** Redondeo de esquinas en unidades de mundo. */
  round: number;
  seed: number;
}

export const DEFAULT_SHAPE: ShapeDef = {
  kind: "circle",
  size: 42,
  aspect: 1,
  sides: 6,
  inner: 0.45,
  round: 6,
  seed: 1,
};

/** Parametros (a, b, c) tal y como los lee el shader para cada tipo. */
/**
 * Convierte el ratio interior de la estrella (0..1, lo que mueve el usuario) al
 * parametro `m` de la SDF. Vive aqui, junto al resto de parametros de forma,
 * para que la silueta dibujada y la que pinta el shader partan del mismo numero.
 */
export const starM = (sides: number, inner: number): number =>
  Math.min(Math.max(2.0001 + inner * (sides - 2), 2.0001), sides);

/**
 * Radio del valle de la estrella tal y como lo define la SDF.
 *
 * No es `size * inner`: `inner` controla `m`, y el valle cae donde se cruzan
 * las dos aristas que salen de puntas contiguas. Calcularlo aqui evita que el
 * horneado y el SVG dibujen una estrella mas gorda que la de la pantalla.
 */
export function starInnerRadius(s: ShapeDef): number {
  const n = Math.max(3, Math.round(s.sides));
  const an = Math.PI / n;
  const en = Math.PI / starM(n, s.inner);
  return s.size * (Math.cos(an) - Math.sin(an) / Math.tan(en));
}

/**
 * Redondeo efectivo de un poligono regular.
 *
 * Se limita a la mitad del radio: por encima de eso el poligono ya es un
 * circulo y seguir subiendo solo haria que la forma encogiera.
 */
export const ngonRound = (s: ShapeDef): number => Math.min(Math.max(0, s.round), s.size * 0.5);

export function shapeParams(s: ShapeDef): [number, number, number] {
  switch (s.kind) {
    case "circle":
      return [s.size, 0, 0];
    case "box":
      return [s.size * s.aspect, s.size, Math.min(s.round, s.size * 0.98)];
    case "capsule":
      return [s.size, Math.max(0, s.size * (s.aspect - 1)), 0];
    case "ngon": {
      // El redondeo se descuenta del radio antes de inflar: la SDF hace
      // `sd - round` (suma de Minkowski), asi que partir de `size - round`
      // deja el borde exterior exactamente en `size`. Sin esto un hexagono se
      // dibuja `round` px mas grande que su colisionador y las piezas se
      // solapan visiblemente antes de que las fisicas las detengan.
      const k = ngonRound(s);
      return [s.size - k, Math.max(3, Math.round(s.sides)), k];
    }
    case "star":
      return [s.size, Math.max(3, Math.round(s.sides)), s.inner];
  }
}

/** Radio envolvente: se usa para descartar cuerpos por pixel en el shader. */
export function boundingRadius(s: ShapeDef): number {
  switch (s.kind) {
    case "circle":
      return s.size;
    case "box":
      return Math.hypot(s.size * s.aspect, s.size) + s.round * 0.2;
    case "capsule":
      return s.size * Math.max(1, s.aspect);
    case "ngon":
      return s.size;
    case "star":
      return s.size;
  }
}

/**
 * Vertices del colisionador en espacio local.
 * Devuelve null para el circulo (se trata como primitiva).
 *
 * La estrella colisiona con su envolvente convexa: el campo la dibuja exacta,
 * pero un colisionador concavo multiplicaria el coste del solver sin que se
 * note en pantalla, porque las formas se funden antes de encajar sus puntas.
 */
export function colliderVerts(s: ShapeDef): Vec2[] | null {
  const n = Math.max(3, Math.round(s.sides));
  switch (s.kind) {
    case "circle":
      return null;
    case "box": {
      const w = s.size * s.aspect;
      const h = s.size;
      return [
        { x: -w, y: -h },
        { x: w, y: -h },
        { x: w, y: h },
        { x: -w, y: h },
      ];
    }
    case "capsule": {
      const r = s.size;
      const half = Math.max(0, s.size * (s.aspect - 1));
      const out: Vec2[] = [];
      const seg = 8;
      for (let i = 0; i <= seg; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / seg;
        out.push({ x: Math.cos(a) * r + half, y: Math.sin(a) * r });
      }
      for (let i = 0; i <= seg; i++) {
        const a = Math.PI / 2 + (Math.PI * i) / seg;
        out.push({ x: Math.cos(a) * r - half, y: Math.sin(a) * r });
      }
      return out;
    }
    case "ngon":
    case "star": {
      const r = s.size;
      const out: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const a = (TAU * i) / n - Math.PI / 2;
        out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
      return out;
    }
  }
}

/** Contorno para dibujar la forma como tinta (bake) o exportarla a SVG. */
export function outlinePolygon(s: ShapeDef, steps = 96): Polygon {
  const out: Polygon = [];
  const n = Math.max(3, Math.round(s.sides));
  switch (s.kind) {
    case "circle": {
      for (let i = 0; i < steps; i++) {
        const a = (TAU * i) / steps;
        out.push({ x: Math.cos(a) * s.size, y: Math.sin(a) * s.size });
      }
      break;
    }
    case "box": {
      const w = s.size * s.aspect;
      const h = s.size;
      const r = Math.min(s.round, Math.min(w, h) * 0.95);
      const corners: Array<[number, number, number]> = [
        [w - r, h - r, 0],
        [-(w - r), h - r, Math.PI / 2],
        [-(w - r), -(h - r), Math.PI],
        [w - r, -(h - r), -Math.PI / 2],
      ];
      for (const [cx, cy, a0] of corners) {
        const seg = Math.max(2, Math.round(steps / 8));
        for (let i = 0; i <= seg; i++) {
          const a = a0 + (Math.PI / 2) * (i / seg);
          out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
        }
      }
      break;
    }
    case "capsule": {
      const r = s.size;
      const half = Math.max(0, s.size * (s.aspect - 1));
      const seg = Math.max(6, Math.round(steps / 2));
      for (let i = 0; i <= seg; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / seg;
        out.push({ x: Math.cos(a) * r + half, y: Math.sin(a) * r });
      }
      for (let i = 0; i <= seg; i++) {
        const a = Math.PI / 2 + (Math.PI * i) / seg;
        out.push({ x: Math.cos(a) * r - half, y: Math.sin(a) * r });
      }
      break;
    }
    case "ngon": {
      // La SDF hace `sd - round`: cada vertice se convierte en un arco de
      // radio `k` centrado a `size - k` del origen, de modo que la punta del
      // arco cae justo en `size`.
      const k = ngonRound(s);
      const r = s.size - k;
      const seg = Math.max(2, Math.round(steps / (n * 2)));
      for (let i = 0; i < n; i++) {
        const a = (TAU * i) / n - Math.PI / 2;
        if (k <= 0.01) {
          out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
          continue;
        }
        const cx = Math.cos(a) * r;
        const cy = Math.sin(a) * r;
        for (let j = 0; j <= seg; j++) {
          const t = a - Math.PI / n + ((2 * Math.PI) / n) * (j / seg);
          out.push({ x: cx + Math.cos(t) * k, y: cy + Math.sin(t) * k });
        }
      }
      break;
    }
    case "star": {
      const valley = starInnerRadius(s);
      for (let i = 0; i < n * 2; i++) {
        const r = i % 2 === 0 ? s.size : valley;
        const a = (Math.PI * i) / n - Math.PI / 2;
        out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
      break;
    }
  }
  return out;
}

export function transformPolygon(poly: Polygon, m: Mat2d): Polygon {
  if (isIdentity(m)) return poly.map((p) => ({ x: p.x, y: p.y }));
  return poly.map((p) => apply(m, p));
}

/** Propiedades de masa exactas para poligono convexo o circulo. */
export function massProperties(
  s: ShapeDef,
  verts: Vec2[] | null,
  density: number,
): { mass: number; inertia: number } {
  if (!verts) {
    const m = density * Math.PI * s.size * s.size;
    return { mass: m, inertia: (m * s.size * s.size) / 2 };
  }
  let area = 0;
  let inertia = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const cross = a.x * b.y - a.y * b.x;
    area += cross;
    inertia +=
      cross * (a.x * a.x + a.x * b.x + b.x * b.x + a.y * a.y + a.y * b.y + b.y * b.y);
  }
  area = Math.abs(area) / 2;
  const mass = Math.max(1e-6, density * area);
  return { mass, inertia: Math.max(1e-6, (density * Math.abs(inertia)) / 12) };
}

/** Variante aleatoria y agradable de una forma (para el boton "sembrar"). */
export function randomShape(rng: Rng, base: ShapeDef): ShapeDef {
  const kinds: ShapeKind[] = ["circle", "box", "capsule", "ngon", "star"];
  const kind = rng.pick(kinds);
  return {
    kind,
    size: base.size * rng.range(0.55, 1.5),
    aspect: kind === "box" || kind === "capsule" ? rng.range(0.6, 2.2) : 1,
    sides: Math.round(rng.range(3, 8)),
    inner: rng.range(0.35, 0.62),
    round: base.round * rng.range(0.2, 1.4),
    seed: rng.int(0, 1 << 20),
  };
}
