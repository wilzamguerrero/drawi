import type { InputSample } from "../input/pointer";
import type { Body } from "../physics/world";
import type { Tool, ToolContext } from "./types";

/**
 * Puente: ajusta el alcance de puentes de un cuerpo concreto.
 *
 * Funciona como un "pincel de area" al estilo de los colisionadores: se pulsa
 * sobre un cuerpo y se arrastra para abrir o cerrar su radio de alcance. El
 * arrastre es RELATIVO: parte del valor que el cuerpo ya tiene y lo aumenta o
 * disminuye segun cuanto te alejes o acerques del punto donde pulsaste, asi se
 * puede refinar sin volver a empezar de cero. Un clic seco (sin arrastre)
 * devuelve el cuerpo al alcance global.
 */
export class BridgeTool implements Tool {
  readonly id = "bridge" as const;
  readonly cursor = "crosshair";
  readonly showCursorRing = false;

  private target: Body | null = null;
  private moved = false;
  private startReach = 0;
  private startDist = 0;

  onDown(ctx: ToolContext, s: InputSample): void {
    const w = ctx.toWorld(s);
    const body = ctx.doc.physics.pick(w.x, w.y, 6);
    if (!body) {
      this.target = null;
      return;
    }
    ctx.history.begin();
    this.target = body;
    this.moved = false;
    // Punto de partida: el alcance efectivo actual (propio o el global) y la
    // distancia inicial del puntero al centro, para arrastrar de forma relativa.
    const global = ctx.doc.field.bridgeReach;
    this.startReach = body.bridgeReach >= 0 ? body.bridgeReach : Math.max(0, global);
    const dx = w.x - body.pos.x;
    const dy = w.y - body.pos.y;
    this.startDist = Math.hypot(dx, dy);
    ctx.setHighlight(body);
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    if (!this.target) {
      const w = ctx.toWorld(samples[samples.length - 1]);
      ctx.setHighlight(ctx.doc.physics.pick(w.x, w.y, 6));
      return;
    }
    const w = ctx.toWorld(samples[samples.length - 1]);
    const dx = w.x - this.target.pos.x;
    const dy = w.y - this.target.pos.y;
    const dist = Math.hypot(dx, dy);
    const reach = Math.max(0, this.startReach + (dist - this.startDist));
    this.target.bridgeReach = reach;
    this.moved = true;
    ctx.invalidateField();
    ctx.status(`Puente · ${Math.round(reach)} px`);
  }

  onUp(ctx: ToolContext): void {
    if (!this.target) return;
    if (!this.moved) {
      // Clic seco: vuelve al alcance global.
      this.target.bridgeReach = -1;
      ctx.invalidateField();
      ctx.status("Puente · global");
    }
    ctx.history.commit("Alcance de puente");
    this.target = null;
  }

  onCancel(ctx: ToolContext): void {
    this.target = null;
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
