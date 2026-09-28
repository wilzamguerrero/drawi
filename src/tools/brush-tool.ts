import { polygonBounds, strokeOutline } from "../stroke/outline";
import { StrokeBuilder, type WorldSample } from "../stroke/builder";
import type { InputSample } from "../input/pointer";
import type { Polygon, StrokePoint } from "../stroke/types";
import { outlinePolygon, transformPolygon } from "../physics/shapes";
import { symmetryTransforms } from "../symmetry/symmetry";
import type { InkItem } from "../scene/types";
import type { Mat2d } from "../core/mat2d";
import { placePullShape, pullShape, randomPullShape } from "./pull-shapes";
import type { Tool, ToolContext, WetStroke } from "./types";

/**
 * Pincel: los tres modos de Alchemy sobre un motor moderno, mas un borrador
 * vectorial propio.
 *
 * - stroke: silueta de ancho variable a partir de la dinamica activa.
 * - fill: la trayectoria se cierra y se rellena; el ancho no importa.
 * - pull: se estira una forma procedural entre el punto inicial y el actual.
 * - erase: borrador inteligente (ver mas abajo).
 *
 * El trazo se repinta como "humedo" en su propia capa en cada lote de muestras
 * y solo se consolida al levantar el lapiz. La prediccion se pinta pero jamas
 * se consolida: si el lapiz cambia de rumbo, el tramo predicho desaparece sin
 * dejar rastro.
 *
 * El borrador (`mode === "erase"`) tiene cuatro sub-modos (`brush.eraseMode`):
 * - brush: trazo de borrado de ancho constante que recorta la tinta debajo
 *   (item con `erase`, compuesto con destination-out por el renderer).
 * - shape: usa la forma activa de Materia como huella y recorta ese area.
 * - object: tocar un trazo lo elimina entero.
 * - color: como object, pero solo los trazos del color del primero que se toca.
 * Ademas `eraseFade` lo vuelve suave (opacidad = fuerza) y `eraseMatter` hace
 * que el mismo gesto borre cuerpos de materia que toque.
 */
export class BrushTool implements Tool {
  readonly id = "brush" as const;
  readonly cursor = "none";
  readonly showCursorRing = true;

  private builder: StrokeBuilder | null = null;
  private active = false;
  private eraser = false;
  // Al pintar con "usar como goma" activo (toggle del panel / tecla Alt), el
  // gesto se invierte a borrado sin cambiar de modo (p. ej. la forma de relleno
  // recorta la tinta). El modo Borrador (4) ya borra por sí mismo.
  private invert = false;
  private shape: Polygon | null = null;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  // Borrado: si algo se elimino (para decidir commit/abort) y el color de
  // referencia del sub-modo "color" (fijado al tocar el primer trazo).
  private erasedAny = false;
  private eraseRef = "";

  onDown(ctx: ToolContext, s: InputSample): void {
    const w = ctx.toWorld(s);
    ctx.history.begin();
    this.active = true;
    this.eraser = s.eraser;
    // Los modos de pintura se invierten a borrado si "usar como goma" está activo.
    this.invert = ctx.brush.mode !== "erase" && ctx.brush.invertErase;
    this.startX = w.x;
    this.startY = w.y;
    this.lastX = w.x;
    this.lastY = w.y;
    this.erasedAny = false;

    if (ctx.brush.mode === "erase") {
      this.beginErase(ctx, s, w.x, w.y);
      return;
    }

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

    if (ctx.brush.mode === "erase") {
      this.moveErase(ctx, samples, predicted);
      return;
    }

    // El toggle "usar como goma" (Alt) puede cambiar a mitad del trazo: se
    // relee para que la vista previa alterne entre pintar y borrar al vuelo.
    // (Aquí el modo ya no puede ser "erase": esa rama salió antes.)
    this.invert = ctx.brush.invertErase;

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

    if (ctx.brush.mode === "erase") {
      this.endErase(ctx, s);
      return;
    }

    // Estado final de "usar como goma" (el modo ya no puede ser "erase" aquí).
    this.invert = ctx.brush.invertErase;

    if (ctx.brush.mode === "pull") {
      const w = ctx.toWorld(s);
      this.lastX = w.x;
      this.lastY = w.y;
      const wet = this.buildWet(ctx, false);
      this.shape = null;
      this.finish(ctx, wet, this.invert ? "Borrar" : "Forma");
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
    const label = this.invert ? "Borrar" : ctx.brush.mode === "fill" ? "Relleno" : "Trazo";
    this.finish(ctx, wet, label);
  }

  onCancel(ctx: ToolContext): void {
    this.active = false;
    this.builder = null;
    this.shape = null;
    this.invert = false;
    ctx.setWet(null);
    ctx.history.abort();
  }

  // ----------------------------------------------------------------- borrado

  private beginErase(ctx: ToolContext, s: InputSample, x: number, y: number): void {
    const em = ctx.brush.eraseMode;
    if (ctx.brush.eraseMatter) this.eraseMatterAt(ctx, x, y);

    if (em === "object" || em === "color") {
      this.eraseRef = em === "color" ? this.colorAt(ctx, x, y) : "";
      this.eraseObjectsAt(ctx, x, y);
      return;
    }

    if (em === "brush") {
      // Ancho constante: el borrador no debe adelgazar con la dinamica.
      this.builder = new StrokeBuilder({ ...ctx.brush, dynamics: "constant", minRatio: 1 });
      this.builder.setZoom(ctx.camera.zoom);
      this.builder.begin(this.worldSample(ctx, s));
    }
    // brush o shape: se previsualiza como recorte humedo.
    this.paintWet(ctx);
  }

  private moveErase(ctx: ToolContext, samples: InputSample[], predicted: InputSample[]): void {
    const em = ctx.brush.eraseMode;
    if (ctx.brush.eraseMatter) {
      for (const sm of samples) {
        const w = ctx.toWorld(sm);
        this.eraseMatterAt(ctx, w.x, w.y);
      }
    }

    if (em === "object" || em === "color") {
      for (const sm of samples) {
        const w = ctx.toWorld(sm);
        this.eraseObjectsAt(ctx, w.x, w.y);
      }
      return;
    }

    if (em === "shape") {
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
    if (predicted.length > 0) b.setPredicted(predicted.map((s) => this.worldSample(ctx, s)));
    if (added || predicted.length > 0) this.paintWet(ctx);
  }

  private endErase(ctx: ToolContext, s: InputSample): void {
    const em = ctx.brush.eraseMode;

    if (em === "object" || em === "color") {
      if (this.erasedAny) ctx.history.commit("Borrar");
      else ctx.history.abort();
      return;
    }

    if (em === "shape") {
      const w = ctx.toWorld(s);
      this.lastX = w.x;
      this.lastY = w.y;
      this.finishErase(ctx, this.buildWet(ctx, false));
      return;
    }

    const b = this.builder;
    this.builder = null;
    if (!b) {
      this.finishErase(ctx, null);
      return;
    }
    b.push([this.worldSample(ctx, s)], true);
    const points = b.finalize();
    this.finishErase(ctx, this.wetFromPoints(ctx, points, false));
  }

  /** Consolida un recorte de borrado; respeta lo ya borrado de materia. */
  private finishErase(ctx: ToolContext, wet: WetStroke | null): void {
    ctx.setWet(null);
    const hasInk = !!wet && wet.polys.length > 0;
    if (!hasInk && !this.erasedAny) {
      ctx.history.abort();
      return;
    }
    if (wet && hasInk) ctx.commitWet(wet);
    ctx.history.commit("Borrar");
  }

  /** Elimina los trazos que toca el punto (todo el item, con sus copias). */
  private eraseObjectsAt(ctx: ToolContext, x: number, y: number): void {
    const r = Math.max(1, ctx.brush.size * 0.5);
    const byColor = ctx.brush.eraseMode === "color";
    const remove: string[] = [];
    for (const it of ctx.doc.items) {
      if (it.erase) continue; // no borrar los propios recortes
      if (byColor && !sameColor(it.color, this.eraseRef)) continue;
      if (itemHit(it, x, y, r)) remove.push(it.id);
    }
    for (const id of remove) {
      ctx.doc.removeItem(id);
      this.erasedAny = true;
    }
    if (remove.length > 0) ctx.invalidateInk();
  }

  /** Quita un cuerpo de materia bajo el punto (sub-opcion "incluir materia"). */
  private eraseMatterAt(ctx: ToolContext, x: number, y: number): void {
    const body = ctx.doc.physics.pick(x, y, Math.max(1, ctx.brush.size * 0.3));
    if (!body) return;
    ctx.doc.physics.remove(body.id);
    this.erasedAny = true;
    ctx.invalidateField();
  }

  /** Color del trazo mas alto bajo el punto (referencia del borrado por color). */
  private colorAt(ctx: ToolContext, x: number, y: number): string {
    const r = Math.max(1, ctx.brush.size * 0.5);
    const items = ctx.doc.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.erase) continue;
      if (itemHit(it, x, y, r)) return it.color;
    }
    return ctx.color;
  }

  /** Huella del borrador con forma: la forma activa, dimensionada por arrastre. */
  private buildEraseShape(ctx: ToolContext): Polygon {
    const dx = this.lastX - this.startX;
    const dy = this.lastY - this.startY;
    const d = Math.hypot(dx, dy);
    const size = Math.max(ctx.doc.shape.size, d);
    const angle = d > 2 ? Math.atan2(dy, dx) : 0;
    const local = outlinePolygon({ ...ctx.doc.shape, size });
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    return local.map((p) => ({
      x: this.startX + ca * p.x - sa * p.y,
      y: this.startY + sa * p.x + ca * p.y,
    }));
  }

  // ------------------------------------------------------------------ comun

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
    if (ctx.brush.mode === "erase" && ctx.brush.eraseMode === "shape") {
      return this.pack(ctx, [this.buildEraseShape(ctx)]);
    }
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

    // El borrador de pincel (o cualquier modo invertido con Alt) usa contorno
    // suave, nunca splat.
    const splat = st.mode === "erase" || this.invert ? false : st.splat;
    const poly = strokeOutline(points, { splat, caps: true });
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
    const erasing = ctx.brush.mode === "erase" || this.invert;
    return {
      polys,
      transforms: symmetryTransforms(ctx.doc.symmetry),
      // El borrado no aporta color: el renderer usa alpha (destination-out).
      color: erasing ? "#000000" : this.eraser ? ctx.doc.meta.background : ctx.color,
      opacity: erasing ? (ctx.brush.eraseFade ? ctx.brush.opacity : 1) : ctx.brush.opacity,
      smooth: erasing ? true : !ctx.brush.splat,
      gradient: erasing ? false : ctx.brush.gradient,
      erase: erasing,
      gy0: Number.isFinite(gy0) ? gy0 : 0,
      gy1: Number.isFinite(gy1) ? gy1 : 1,
    };
  }
}

/** Compara dos colores hex sin distinguir mayusculas. */
function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * ¿El punto (con radio `r`) toca la tinta del item? Se prueba cada copia de
 * simetria transformando su poligono a mundo: dentro del relleno, o a menos de
 * `r` de un borde (para trazos finos). El descarte rapido usa la caja del item.
 */
function itemHit(item: InkItem, x: number, y: number, r: number): boolean {
  const b = item.bounds;
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  for (const m of item.transforms as Mat2d[]) {
    for (const poly of item.polys) {
      if (poly.length < 3) continue;
      const wp = transformPolygon(poly, m);
      if (pointInPoly(wp, x, y)) return true;
      if (r > 0 && nearEdge(wp, x, y, r)) return true;
    }
  }
  return false;
}

/** Punto en poligono por lanzamiento de rayo (regla par/impar). */
function pointInPoly(poly: Polygon, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** ¿Algun borde del poligono queda a distancia <= r del punto? */
function nearEdge(poly: Polygon, x: number, y: number, r: number): boolean {
  const r2 = r * r;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distSqToSeg(x, y, poly[j].x, poly[j].y, poly[i].x, poly[i].y) <= r2) return true;
  }
  return false;
}

/** Distancia al cuadrado del punto (px,py) al segmento (ax,ay)-(bx,by). */
function distSqToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}
