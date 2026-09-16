import { clamp, TAU } from "../core/math";
import type { InputSample } from "../input/pointer";
import { hitSymmetryHandle, type SymmetryHandle } from "../symmetry/symmetry";
import type { Tool, ToolContext } from "./types";

/**
 * Gizmo de simetria: mover el eje a donde se quiera.
 *
 * La simetria de Webchemy estaba clavada al centro del lienzo. Aqui el origen,
 * el angulo y el numero de sectores son tres tiradores que se arrastran en
 * cualquier momento, y los trazos ya dibujados no se mueven con ellos porque
 * cada item conserva la transformacion con la que se creo.
 */
export class SymmetryTool implements Tool {
  readonly id = "symmetry" as const;
  readonly cursor = "move";
  readonly showCursorRing = false;

  private handle: SymmetryHandle = null;
  private grabOffsetX = 0;
  private grabOffsetY = 0;
  private startCount = 6;
  private startAngle = 0;

  onDown(ctx: ToolContext, s: InputSample): void {
    const sym = ctx.doc.symmetry;
    if (sym.locked) return;

    this.handle = this.hit(ctx, s);
    if (!this.handle) return;

    ctx.history.begin();
    const w = ctx.toWorld(s);
    this.grabOffsetX = sym.x - w.x;
    this.grabOffsetY = sym.y - w.y;
    this.startCount = sym.count;
    this.startAngle = Math.atan2(w.y - sym.y, w.x - sym.x);
    ctx.invalidateOverlay();
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    const sym = ctx.doc.symmetry;
    const last = samples[samples.length - 1];

    if (!this.handle) {
      ctx.invalidateOverlay();
      return;
    }

    const w = ctx.toWorld(last);
    if (this.handle === "origin") {
      sym.x = w.x + this.grabOffsetX;
      sym.y = w.y + this.grabOffsetY;
      ctx.status(`Eje en ${Math.round(sym.x)}, ${Math.round(sym.y)}`);
    } else if (this.handle === "axis") {
      let a = Math.atan2(w.y - sym.y, w.x - sym.x);
      // Shift-like: sin modificador, imanta cada 15 grados al acercarse.
      const step = Math.PI / 12;
      const snapped = Math.round(a / step) * step;
      if (Math.abs(a - snapped) < 0.035) a = snapped;
      sym.angle = a;
      ctx.status(`Angulo ${Math.round((a * 180) / Math.PI)}°`);
    } else if (this.handle === "count") {
      const a = Math.atan2(w.y - sym.y, w.x - sym.x);
      let delta = a - this.startAngle;
      while (delta > Math.PI) delta -= TAU;
      while (delta < -Math.PI) delta += TAU;
      sym.count = clamp(Math.round(this.startCount + delta * 6), 2, 64);
      ctx.status(`${sym.count} sectores`);
    }
    ctx.invalidateOverlay();
  }

  onUp(ctx: ToolContext): void {
    if (!this.handle) return;
    this.handle = null;
    ctx.history.commit("Mover simetria");
    ctx.invalidateOverlay();
  }

  onCancel(ctx: ToolContext): void {
    this.handle = null;
    ctx.history.abort();
    ctx.invalidateOverlay();
  }

  onHover(ctx: ToolContext, s: InputSample | null): void {
    ctx.invalidateOverlay();
    if (!s) return;
    this.hit(ctx, s);
  }

  /** Tirador bajo el puntero, calculado en pantalla para que el zoom no afecte. */
  hit(ctx: ToolContext, s: InputSample): SymmetryHandle {
    const sym = ctx.doc.symmetry;
    const origin = ctx.camera.worldToScreen({ x: sym.x, y: sym.y });
    return hitSymmetryHandle(s.x, s.y, origin, sym.angle + ctx.camera.rotation, sym.mode);
  }
}
