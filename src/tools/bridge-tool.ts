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
  private startX = 0;
  private startY = 0;
  private dirX = 0;
  private dirY = 0;

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
    const global = ctx.doc.field.bridgeReach;
    this.startReach = body.bridgeReach >= 0 ? body.bridgeReach : Math.max(0, global);
    this.startX = w.x;
    this.startY = w.y;
    // Direccion radial desde el centro hacia donde se pulso: arrastrar en esa
    // direccion agranda, en sentido contrario encoge. Es un delta sobre el valor
    // actual (no un valor absoluto), asi se refina en ambos sentidos sin tope.
    let dx = w.x - body.pos.x;
    let dy = w.y - body.pos.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) {
      dx = 0;
      dy = -1;
    } else {
      dx /= len;
      dy /= len;
    }
    this.dirX = dx;
    this.dirY = dy;
    ctx.setHighlight(body);
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    if (!this.target) {
      const w = ctx.toWorld(samples[samples.length - 1]);
      ctx.setHighlight(ctx.doc.physics.pick(w.x, w.y, 6));
      return;
    }
    const w = ctx.toWorld(samples[samples.length - 1]);
    // Proyeccion del desplazamiento sobre la direccion radial inicial.
    const delta = (w.x - this.startX) * this.dirX + (w.y - this.startY) * this.dirY;
    const reach = Math.max(0, this.startReach + delta);
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
