import { TAU } from "../core/math";
import type { Vec2 } from "../core/vec2";
import type { OutlineOptions, Polygon, StrokePoint } from "./types";

const DEFAULT_OPTS: OutlineOptions = { splat: false, arcQuality: 4, caps: true };

const arcPoints = (
  out: Polygon,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  quality: number,
): void => {
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= TAU;
  while (sweep < -Math.PI) sweep += TAU;
  const steps = Math.max(1, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * quality));
  for (let i = 1; i < steps; i++) {
    const a = a0 + (sweep * i) / steps;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
};

const circlePolygon = (p: StrokePoint, quality: number): Polygon => {
  const steps = Math.max(8, quality * 4);
  const out: Polygon = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    out.push({ x: p.x + Math.cos(a) * p.r, y: p.y + Math.sin(a) * p.r });
  }
  return out;
};

/**
 * Genera el contorno cerrado de un trazo de ancho variable.
 *
 * Se recorre el lado izquierdo hacia delante, se cierra con el casquete final,
 * se vuelve por el lado derecho y se cierra con el casquete inicial. En los
 * vertices exteriores se insertan arcos (union redonda real); los solapes del
 * lado interior los resuelve el relleno nonzero, que es mas rapido y robusto
 * que calcular las autointersecciones.
 */
export function strokeOutline(points: readonly StrokePoint[], options?: Partial<OutlineOptions>): Polygon {
  const opts = { ...DEFAULT_OPTS, ...options };
  const pts = dedupe(points);
  if (pts.length === 0) return [];
  if (pts.length === 1) return circlePolygon(pts[0], opts.arcQuality);

  const n = pts.length;
  const dirs: Vec2[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const l = Math.hypot(dx, dy) || 1;
    dirs[i] = { x: dx / l, y: dy / l };
  }

  const left: Polygon = [];
  const right: Polygon = [];
  const q = opts.splat ? 1 : opts.arcQuality;

  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const dIn = dirs[Math.max(0, i - 1)];
    const dOut = dirs[Math.min(n - 2, i)];
    const aIn = Math.atan2(dIn.x, -dIn.y); // angulo de la normal izquierda
    const aOut = Math.atan2(dOut.x, -dOut.y);
    const turn = dIn.x * dOut.y - dIn.y * dOut.x;

    left.push({ x: p.x + Math.cos(aIn) * p.r, y: p.y + Math.sin(aIn) * p.r });
    if (!opts.splat && turn < 0 && i > 0 && i < n - 1) {
      arcPoints(left, p.x, p.y, p.r, aIn, aOut, q);
    }
    left.push({ x: p.x + Math.cos(aOut) * p.r, y: p.y + Math.sin(aOut) * p.r });

    const bIn = aIn + Math.PI;
    const bOut = aOut + Math.PI;
    right.push({ x: p.x + Math.cos(bIn) * p.r, y: p.y + Math.sin(bIn) * p.r });
    if (!opts.splat && turn > 0 && i > 0 && i < n - 1) {
      arcPoints(right, p.x, p.y, p.r, bIn, bOut, q);
    }
    right.push({ x: p.x + Math.cos(bOut) * p.r, y: p.y + Math.sin(bOut) * p.r });
  }

  const poly: Polygon = left;
  const end = pts[n - 1];
  const dEnd = dirs[n - 2];
  const aEnd = Math.atan2(dEnd.x, -dEnd.y);
  if (opts.caps && !opts.splat) arcPoints(poly, end.x, end.y, end.r, aEnd, aEnd - Math.PI, q);

  for (let i = right.length - 1; i >= 0; i--) poly.push(right[i]);

  const start = pts[0];
  const dStart = dirs[0];
  const aStart = Math.atan2(dStart.x, -dStart.y);
  if (opts.caps && !opts.splat) {
    arcPoints(poly, start.x, start.y, start.r, aStart + Math.PI, aStart, q);
  }
  return poly;
}

/** Quita puntos coincidentes que romperian el calculo de normales. */
function dedupe(points: readonly StrokePoint[]): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-4) {
      if (p.r > last.r) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Path2D con suavizado por puntos medios (silueta continua, sin facetas). */
export function polygonToPath2D(poly: Polygon, smooth = true): Path2D {
  const path = new Path2D();
  const n = poly.length;
  if (n < 2) return path;
  if (!smooth || n < 4) {
    path.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < n; i++) path.lineTo(poly[i].x, poly[i].y);
    path.closePath();
    return path;
  }
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let prev = mid(poly[n - 1], poly[0]);
  path.moveTo(prev.x, prev.y);
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const m = mid(cur, next);
    path.quadraticCurveTo(cur.x, cur.y, m.x, m.y);
    prev = m;
  }
  path.closePath();
  return path;
}

/** Misma silueta, en sintaxis de path SVG. */
export function polygonToSvgPath(poly: Polygon, smooth = true, digits = 2): string {
  const n = poly.length;
  if (n < 2) return "";
  const f = (v: number): string => {
    const s = v.toFixed(digits);
    return s.replace(/\.?0+$/, "") || "0";
  };
  if (!smooth || n < 4) {
    let d = `M ${f(poly[0].x)} ${f(poly[0].y)}`;
    for (let i = 1; i < n; i++) d += ` L ${f(poly[i].x)} ${f(poly[i].y)}`;
    return d + " Z";
  }
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const first = mid(poly[n - 1], poly[0]);
  let d = `M ${f(first.x)} ${f(first.y)}`;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const m = mid(cur, next);
    d += ` Q ${f(cur.x)} ${f(cur.y)} ${f(m.x)} ${f(m.y)}`;
  }
  return d + " Z";
}

/** Centro de linea como polilinea suave (modo relleno de Alchemy). */
export function centerlinePath2D(points: readonly StrokePoint[], close: boolean): Path2D {
  const path = new Path2D();
  if (points.length === 0) return path;
  path.moveTo(points[0].x, points[0].y);
  if (points.length < 3) {
    for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
  } else {
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      path.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    const last = points[points.length - 1];
    path.lineTo(last.x, last.y);
  }
  if (close) path.closePath();
  return path;
}

export function centerlineSvgPath(points: readonly StrokePoint[], close: boolean, digits = 2): string {
  if (points.length === 0) return "";
  const f = (v: number): string => {
    const s = v.toFixed(digits);
    return s.replace(/\.?0+$/, "") || "0";
  };
  let d = `M ${f(points[0].x)} ${f(points[0].y)}`;
  if (points.length < 3) {
    for (let i = 1; i < points.length; i++) d += ` L ${f(points[i].x)} ${f(points[i].y)}`;
  } else {
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      d += ` Q ${f(points[i].x)} ${f(points[i].y)} ${f(mx)} ${f(my)}`;
    }
    const last = points[points.length - 1];
    d += ` L ${f(last.x)} ${f(last.y)}`;
  }
  return close ? d + " Z" : d;
}

/** Caja envolvente de un contorno. */
export function polygonBounds(poly: Polygon): { x: number; y: number; w: number; h: number } {
  if (poly.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
