import { polygonBounds, strokeOutline } from "../stroke/outline";
import { StrokeBuilder, type WorldSample } from "../stroke/builder";
import type { InputSample } from "../input/pointer";
import type { Polygon, StrokePoint } from "../stroke/types";
import { symmetryTransforms } from "../symmetry/symmetry";
import { placePullShape, pullShape, randomPullShape } from "./pull-shapes";
import type { Tool, ToolContext, WetStroke } from "./types";

/**
 * Pincel: los tres modos de Alchemy sobre un motor moderno.
 *
 * - stroke: silueta de ancho variable a partir de la dinamica activa.
 * - fill: la trayectoria se cierra y se rellena; el ancho no importa.
 * - pull: se estira una forma procedural entre el punto inicial y el actual.
 *
 * El trazo se repinta como "humedo" en su propia capa en cada lote de muestras
 * y solo se consolida al levantar el lapiz. La prediccion se pinta pero jamas
 * se consolida: si el lapiz cambia de rumbo, el tramo predicho desaparece sin
 * dejar rastro.
 */
export class BrushTool implements Tool {
  readonly id = "brush" as const;
  readonly cursor = "none";
  readonly showCursorRing = true;

  private builder: StrokeBuilder | null = null;
  private active = false;
  private eraser = false;
  private shape: Polygon | null = null;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;

  onDown(ctx: ToolContext, s: InputSample): void {
    const w = ctx.toWorld(s);
    ctx.history.begin();
    this.active = true;
    this.eraser = s.eraser;
    this.startX = w.x;
    this.startY = w.y;
    this.lastX = w.x;
    this.lastY = w.y;

    if (ctx.brush.mode === "pull") {
      this.shape =
        ctx.pullFamily === "random"
          ? randomPullShape(ctx.rng)
          : pullShape(ctx.pullFamily, ctx.rng);
      this.paintWet(ctx);
      return;
    }

    this.builder = new StrokeBuilder(ctx.brush);
    this.builder.setZoom(ctx.camera.zoom);
    this.builder.begin(this.worldSample(ctx, s));
    this.paintWet(ctx);
  }

  onMove(ctx: ToolContext, samples: InputSample[], predicted: InputSample[]): void {
    if (!this.active) return;

    if (ctx.brush.mode === "pull") {
      const w = ctx.toWorld(samples[samples.length - 1]);
      this.lastX = w.x;
      this.lastY = w.y;
      this.paintWet(ctx);
      return;
    }

    const b = this.builder;
    if (!b) return;
    b.setZoom(ctx.camera.zoom);
    const added = b.push(samples.map((s) => this.worldSample(ctx, s)));
    if (predicted.length > 0) {
      b.setPredicted(predicted.map((s) => this.worldSample(ctx, s)));
    }
    if (added || predicted.length > 0) this.paintWet(ctx);
  }

  onUp(ctx: ToolContext, s: InputSample): void {
    if (!this.active) return;
    this.active = false;

    if (ctx.brush.mode === "pull") {
      const w = ctx.toWorld(s);
      this.lastX = w.x;
      this.lastY = w.y;
      const wet = this.buildWet(ctx, false);
      this.shape = null;
      this.finish(ctx, wet, "Forma");
      return;
    }

    const b = this.builder;
    this.builder = null;
    if (!b) {
      ctx.history.abort();
      return;
    }
    b.push([this.worldSample(ctx, s)], true);
    const points = b.finalize();
    const wet = this.wetFromPoints(ctx, points, false);
    this.finish(ctx, wet, ctx.brush.mode === "fill" ? "Relleno" : "Trazo");
  }

  onCancel(ctx: ToolContext): void {
    this.active = false;
    this.builder = null;
    this.shape = null;
    ctx.setWet(null);
    ctx.history.abort();
  }

  private finish(ctx: ToolContext, wet: WetStroke | null, label: string): void {
    ctx.setWet(null);
    if (!wet || wet.polys.length === 0) {
      ctx.history.abort();
      return;
    }
    ctx.commitWet(wet);
    ctx.history.commit(label);
  }

  private worldSample(ctx: ToolContext, s: InputSample): WorldSample {
    const w = ctx.toWorld(s);
    return {
      x: w.x,
      y: w.y,
      pressure: s.pressure,
      tilt: s.tilt,
      azimuth: s.azimuth,
      t: s.t,
      predicted: s.predicted,
    };
  }

  private paintWet(ctx: ToolContext): void {
    ctx.setWet(this.buildWet(ctx, true));
  }

  private buildWet(ctx: ToolContext, preview: boolean): WetStroke | null {
    if (ctx.brush.mode === "pull") {
      if (!this.shape) return null;
      const poly = placePullShape(
        this.shape,
        this.startX,
        this.startY,
        this.lastX,
        this.lastY,
        0.5,
        ctx.brush.size,
      );
      return this.pack(ctx, [poly]);
    }
    const b = this.builder;
    if (!b) return null;
    const pts = preview ? b.preview : b.points;
    return this.wetFromPoints(ctx, pts, preview);
  }

  private wetFromPoints(
    ctx: ToolContext,
    points: readonly StrokePoint[],
    _preview: boolean,
  ): WetStroke | null {
    if (points.length === 0) return null;
    const st = ctx.brush;

    if (st.mode === "fill") {
      // El relleno ignora el ancho: importa la trayectoria cerrada.
      if (points.length < 3) return null;
      const poly: Polygon = points.map((p) => ({ x: p.x, y: p.y }));
      return this.pack(ctx, [poly]);
    }

    const poly = strokeOutline(points, { splat: st.splat, caps: true });
    if (poly.length < 3) return null;
    return this.pack(ctx, [poly]);
  }

  private pack(ctx: ToolContext, polys: Polygon[]): WetStroke {
    let gy0 = Infinity;
    let gy1 = -Infinity;
    for (const p of polys) {
      const b = polygonBounds(p);
      if (b.y < gy0) gy0 = b.y;
      if (b.y + b.h > gy1) gy1 = b.y + b.h;
    }
    return {
      polys,
      transforms: symmetryTransforms(ctx.doc.symmetry),
      color: this.eraser ? ctx.doc.meta.background : ctx.color,
      opacity: ctx.brush.opacity,
      smooth: !ctx.brush.splat,
      gradient: ctx.brush.gradient,
      gy0: Number.isFinite(gy0) ? gy0 : 0,
      gy1: Number.isFinite(gy1) ? gy1 : 1,
    };
  }
}
