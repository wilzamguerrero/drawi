import type { InputSample } from "../input/pointer";
import type { Body } from "../physics/world";
import type { Tool, ToolContext } from "./types";

/**
 * Materia: agarrar, lanzar y borrar cuerpos.
 *
 * El arrastre no teletransporta el cuerpo: el solver lo lleva con un muelle,
 * asi choca con lo que encuentra por el camino y el resto del monton reacciona.
 * Soltar en movimiento lo lanza; el boton lateral del lapiz (o la goma) borra.
 */
export class MatterTool implements Tool {
  readonly id = "matter" as const;
  readonly cursor = "grab";
  readonly showCursorRing = false;

  private grabbed: Body | null = null;
  private erasing = false;
  private moved = false;

  onDown(ctx: ToolContext, s: InputSample): void {
    const w = ctx.toWorld(s);
    const body = ctx.doc.physics.pick(w.x, w.y, 6);
    if (!body) {
      this.grabbed = null;
      return;
    }
    ctx.history.begin();
    this.moved = false;

    if (s.eraser || s.barrel) {
      this.erasing = true;
      ctx.doc.physics.remove(body.id);
      ctx.setHighlight(null);
      ctx.invalidateField();
      ctx.history.commit("Borrar materia");
      return;
    }

    this.grabbed = body;
    ctx.doc.physics.beginDrag(body, w.x, w.y);
    ctx.setHighlight(body);
    ctx.status(`${body.shape.kind} · ${Math.round(body.shape.size)}`);
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    const last = samples[samples.length - 1];
    const w = ctx.toWorld(last);

    if (this.erasing) {
      const body = ctx.doc.physics.pick(w.x, w.y, 6);
      if (body) {
        ctx.doc.physics.remove(body.id);
        ctx.invalidateField();
      }
      return;
    }

    if (!this.grabbed) {
      ctx.setHighlight(ctx.doc.physics.pick(w.x, w.y, 6));
      return;
    }
    this.moved = true;
    ctx.doc.physics.moveDrag(w.x, w.y);
    ctx.invalidateField();
  }

  onUp(ctx: ToolContext): void {
    if (this.erasing) {
      this.erasing = false;
      return;
    }
    if (!this.grabbed) return;
    ctx.doc.physics.endDrag();
    this.grabbed = null;
    if (this.moved) ctx.history.commit("Mover materia");
    else ctx.history.abort();
  }

  onCancel(ctx: ToolContext): void {
    ctx.doc.physics.endDrag();
    this.grabbed = null;
    this.erasing = false;
    ctx.history.abort();
  }

  onHover(ctx: ToolContext, s: InputSample | null): void {
    if (!s) {
      ctx.setHighlight(null);
      return;
    }
    const w = ctx.toWorld(s);
    ctx.setHighlight(ctx.doc.physics.pick(w.x, w.y, 6));
  }
}
