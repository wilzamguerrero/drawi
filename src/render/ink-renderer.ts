import { hexToRgb, cssRgba } from "../core/color";
import { transformCtx, type Mat2d } from "../core/mat2d";
import { polygonToPath2D } from "../stroke/outline";
import type { Polygon } from "../stroke/types";
import type { InkItem, Rect } from "../scene/types";
import { rectIntersects } from "../scene/types";
import type { Camera } from "./camera";
import type { Layer } from "./layer";

/**
 * Pintor de tinta.
 *
 * Cada item guarda sus poligonos en coordenadas de trazo; aqui se convierten
 * a `Path2D` una sola vez y se cachean por id. Repintar el lienzo entero es
 * entonces un bucle de `setTransform` + `fill`, sin reconstruir geometria.
 * La cache se poda cuando el documento pierde items para no crecer sin fin.
 */
export class InkRenderer {
  private cache = new Map<string, Path2D[]>();

  /** Convierte (y cachea) los poligonos de un item. */
  pathsFor(item: InkItem): Path2D[] {
    let paths = this.cache.get(item.id);
    if (!paths) {
      paths = item.polys
        .filter((p) => p.length >= 3)
        .map((p) => polygonToPath2D(p, item.smooth));
      this.cache.set(item.id, paths);
    }
    return paths;
  }

  /** Elimina de la cache los items que ya no estan en el documento. */
  prune(items: readonly InkItem[]): void {
    if (this.cache.size <= items.length) return;
    const live = new Set(items.map((i) => i.id));
    for (const id of this.cache.keys()) {
      if (!live.has(id)) this.cache.delete(id);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Pinta la tinta seca sobre una capa ya limpia. */
  render(layer: Layer, items: readonly InkItem[], camera: Camera): void {
    const ctx = layer.ctx;
    const view = camera.visibleBounds(64);
    camera.applyTo(ctx, layer.dpr);
    for (const item of items) {
      if (!rectIntersects(item.bounds, view)) continue;
      this.drawItem(ctx, item, this.pathsFor(item));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Pinta un item concreto con el contexto ya en coordenadas de mundo. */
  drawItem(ctx: CanvasRenderingContext2D, item: InkItem, paths: Path2D[]): void {
    if (paths.length === 0) return;
    ctx.fillStyle = item.gradient
      ? buildGradient(ctx, item.color, item.opacity, item.gy0, item.gy1)
      : cssRgba(hexToRgb(item.color), item.opacity);

    for (const m of item.transforms) {
      ctx.save();
      transformCtx(ctx, m);
      for (const path of paths) {
        // "nonzero" sella los solapes internos de la silueta de ancho variable.
        ctx.fill(path, "nonzero");
      }
      ctx.restore();
    }
  }

  /**
   * Pinta el trazo en curso.
   *
   * Se dibuja en su propia capa, se limpia solo su caja sucia y no toca la
   * cache: durante el trazo la geometria cambia en cada muestra.
   */
  renderWet(
    layer: Layer,
    polys: readonly Polygon[],
    transforms: readonly Mat2d[],
    camera: Camera,
    color: string,
    opacity: number,
    smooth: boolean,
    gradient: boolean,
    gy0: number,
    gy1: number,
  ): void {
    if (polys.length === 0) return;
    const ctx = layer.ctx;
    camera.applyTo(ctx, layer.dpr);
    ctx.fillStyle = gradient
      ? buildGradient(ctx, color, opacity, gy0, gy1)
      : cssRgba(hexToRgb(color), opacity);

    const paths: Path2D[] = [];
    for (const poly of polys) {
      if (poly.length >= 3) paths.push(polygonToPath2D(poly, smooth));
    }
    for (const m of transforms) {
      ctx.save();
      transformCtx(ctx, m);
      for (const p of paths) ctx.fill(p, "nonzero");
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

/**
 * Degradado vertical en coordenadas de mundo.
 *
 * Es el modificador "gradient" de Webchemy: la forma se desvanece de arriba
 * a abajo. Al crearse con el contexto ya transformado, las coordenadas son
 * las del mundo y el degradado acompana al zoom.
 */
export function buildGradient(
  ctx: CanvasRenderingContext2D,
  color: string,
  opacity: number,
  y0: number,
  y1: number,
): CanvasGradient {
  const c = hexToRgb(color);
  const g = ctx.createLinearGradient(0, y0, 0, Math.max(y1, y0 + 0.001));
  g.addColorStop(0, cssRgba(c, opacity));
  g.addColorStop(1, cssRgba(c, 0));
  return g;
}

/** Caja de pantalla que cubre un rect de mundo (para limpiezas parciales). */
export function screenRectOf(camera: Camera, r: Rect, margin = 2): Rect {
  const pts = [
    camera.worldToScreen({ x: r.x, y: r.y }),
    camera.worldToScreen({ x: r.x + r.w, y: r.y }),
    camera.worldToScreen({ x: r.x + r.w, y: r.y + r.h }),
    camera.worldToScreen({ x: r.x, y: r.y + r.h }),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX - margin,
    y: minY - margin,
    w: maxX - minX + margin * 2,
    h: maxY - minY + margin * 2,
  };
}
