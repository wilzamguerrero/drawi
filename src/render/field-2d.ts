import { hexToRgb, cssRgba, mixRgb, type Rgb } from "../core/color";
import { clamp01 } from "../core/math";
import { fieldContours } from "../physics/marching";
import { sampleField, type FieldSample } from "../physics/sdf";
import type { Body } from "../physics/world";
import type { Camera } from "./camera";
import type { FieldStyle } from "./field-gl";
import type { Layer } from "./layer";

/**
 * Respaldo del campo sin WebGL.
 *
 * Extrae el contorno por marching squares y lo rellena en Canvas2D. Pierde el
 * sombreado por pixel, asi que lo compensa con un degradado radial por lazo:
 * mantiene la lectura de volumen y el puente entre formas, que es lo que
 * importa, a coste de CPU asumible porque solo se recalcula si algo se movio.
 */
export class FieldFallbackRenderer {
  private cachedKey = "";
  private cached: Array<{ poly: Array<{ x: number; y: number }>; color: Rgb }> = [];

  render(layer: Layer, bodies: readonly Body[], camera: Camera, style: FieldStyle): void {
    if (bodies.length === 0) {
      this.cached = [];
      this.cachedKey = "";
      return;
    }

    const key = stateKey(bodies, style, camera.zoom);
    if (key !== this.cachedKey) {
      this.cachedKey = key;
      this.cached = this.build(bodies, style, camera);
    }

    const ctx = layer.ctx;
    camera.applyTo(ctx, layer.dpr);
    ctx.globalAlpha = clamp01(style.alpha);
    ctx.lineJoin = "round";

    for (const loop of this.cached) {
      const path = new Path2D();
      const poly = loop.poly;
      path.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
      path.closePath();

      ctx.fillStyle = cssRgba(loop.color, 1);
      ctx.fill(path);

      if (style.shade > 0) {
        // Ladera falsa: borde mas oscuro por dentro.
        ctx.save();
        ctx.clip(path);
        ctx.strokeStyle = cssRgba(mixRgb(loop.color, { r: 0, g: 0, b: 0 }, 0.45), style.shade * 0.6);
        ctx.lineWidth = Math.max(2, style.depth * 0.5);
        ctx.stroke(path);
        ctx.restore();
      }

      if (style.outline > 0) {
        ctx.strokeStyle = cssRgba(hexToRgb(style.outlineColor), 1);
        ctx.lineWidth = style.outline / camera.zoom;
        ctx.stroke(path);
      }
    }

    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private build(
    bodies: readonly Body[],
    style: FieldStyle,
    camera: Camera,
  ): Array<{ poly: Array<{ x: number; y: number }>; color: Rgb }> {
    // Celda ligada al zoom: fino cuando se ve de cerca, grueso de lejos.
    const cell = clamp01(1 / Math.max(camera.zoom, 0.05)) * 3 + 2.5;
    const loops = fieldContours(bodies, style.blend, { cell, iso: 0 });
    const colors = bodies.map((b) => {
      const c = hexToRgb(b.color);
      return [c.r / 255, c.g / 255, c.b / 255] as [number, number, number];
    });

    const sample: FieldSample = { d: 0, r: 0, g: 0, b: 0 };
    return loops.map((poly) => {
      let cx = 0;
      let cy = 0;
      for (const p of poly) {
        cx += p.x;
        cy += p.y;
      }
      cx /= poly.length;
      cy /= poly.length;
      sampleField(cx, cy, bodies, style.blend, colors, sample);
      return {
        poly,
        color: {
          r: Math.round(clamp01(sample.r) * 255),
          g: Math.round(clamp01(sample.g) * 255),
          b: Math.round(clamp01(sample.b) * 255),
        },
      };
    });
  }

  invalidate(): void {
    this.cachedKey = "";
  }
}

/** Huella barata del estado: si no cambia, el contorno cacheado sirve. */
function stateKey(bodies: readonly Body[], style: FieldStyle, zoom: number): string {
  let s = `${bodies.length}|${style.blend.toFixed(2)}|${zoom.toFixed(2)}`;
  for (const b of bodies) {
    s += `|${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)},${b.angle.toFixed(2)},${b.shape.size.toFixed(1)}`;
  }
  return s;
}
