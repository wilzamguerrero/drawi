import { hexToRgb, cssRgba, mixRgb, type Rgb } from "../core/color";
import { clamp01 } from "../core/math";
import { computeBridges } from "../physics/bridges";
import { fieldContours } from "../physics/marching";
import { sampleField, type FieldSample } from "../physics/sdf";
import type { Body } from "../physics/world";
import type { Camera } from "./camera";
import { BRIDGE_STYLE_CODE, type FieldStyle } from "./field-gl";
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

    // Los lazos de un mismo color se rellenan JUNTOS con la regla even-odd: así
    // un lazo interior (un hueco del campo) resta en vez de taparse. Rellenar
    // cada lazo por separado, como se hacía antes, pintaba los huecos de negro y
    // cerraba los espacios que la GPU sí deja abiertos.
    const groups = new Map<string, { color: Rgb; path: Path2D }>();
    for (const loop of this.cached) {
      const c = loop.color;
      const key = `${c.r},${c.g},${c.b}`;
      let g = groups.get(key);
      if (!g) {
        g = { color: c, path: new Path2D() };
        groups.set(key, g);
      }
      const poly = loop.poly;
      g.path.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) g.path.lineTo(poly[i].x, poly[i].y);
      g.path.closePath();
    }

    const outlineW = style.outline / camera.zoom;
    for (const g of groups.values()) {
      ctx.fillStyle = cssRgba(g.color, 1);
      ctx.fill(g.path, "evenodd");

      if (style.shade > 0) {
        // Ladera falsa: borde mas oscuro por dentro (recortado al relleno real).
        ctx.save();
        ctx.clip(g.path, "evenodd");
        ctx.strokeStyle = cssRgba(mixRgb(g.color, { r: 0, g: 0, b: 0 }, 0.45), style.shade * 0.6);
        ctx.lineWidth = Math.max(2, style.depth * 0.5);
        ctx.stroke(g.path);
        ctx.restore();
      }

      if (style.outline > 0) {
        ctx.strokeStyle = cssRgba(hexToRgb(style.outlineColor), 1);
        ctx.lineWidth = outlineW;
        ctx.stroke(g.path);
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
    // Celda ligada al zoom: fina de cerca, gruesa de lejos. Más fina que antes
    // para que los huecos pequeños del campo se resuelvan como lazos (si el paso
    // no los muestrea, no hay hueco que restar). minArea bajo para no descartar
    // esos huecos pequeños, a cambio de algo más de ruido de rejilla.
    const cell = clamp01(1 / Math.max(camera.zoom, 0.05)) * 2 + 1.5;
    const bridges = computeBridges(bodies, style.bridgeReach);
    const styleCode = BRIDGE_STYLE_CODE[style.bridgeStyle] ?? 0;
    const loops = fieldContours(bodies, style.blend, { cell, iso: 0, minArea: 3 }, bridges, styleCode);
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
      sampleField(cx, cy, bodies, style.blend, colors, sample, bridges, styleCode);
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
  let s = `${bodies.length}|${style.blend.toFixed(2)}|${style.bridgeReach.toFixed(2)}|${style.bridgeStyle}|${zoom.toFixed(2)}`;
  for (const b of bodies) {
    s += `|${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)},${b.angle.toFixed(2)},${b.shape.size.toFixed(1)},${b.bridgeReach.toFixed(0)}`;
  }
  return s;
}
