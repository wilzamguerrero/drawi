import type { InputSample } from "../input/pointer";
import type { Tool, ToolContext } from "./types";

/**
 * Cuentagotas: toma el color compuesto de la pantalla.
 *
 * Lee el pixel ya mezclado (fondo + tinta + materia), no el color nominal de
 * un item, que es lo que uno espera al senalar una zona donde varias capas se
 * superponen.
 */
export class PickerTool implements Tool {
  readonly id = "picker" as const;
  readonly cursor = "crosshair";
  readonly showCursorRing = false;

  private picking = false;

  onDown(ctx: ToolContext, s: InputSample): void {
    this.picking = true;
    this.sample(ctx, s);
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    if (!this.picking) return;
    this.sample(ctx, samples[samples.length - 1]);
  }

  onUp(ctx: ToolContext, s: InputSample): void {
    if (!this.picking) return;
    this.picking = false;
    this.sample(ctx, s);
  }

  onCancel(): void {
    this.picking = false;
  }

  private sample(ctx: ToolContext, s: InputSample): void {
    const hex = ctx.sampleScreenColor(s.x, s.y);
    if (!hex) return;
    ctx.setColor(hex);
    ctx.status(hex.toUpperCase());
  }
}

/**
 * Mano: paneo explicito.
 *
 * Existe aparte del gesto de dos dedos porque con lapiz en la mano no siempre
 * hay dos dedos libres, y porque la barra espaciadora la activa temporalmente.
 */
export class HandTool implements Tool {
  readonly id = "hand" as const;
  readonly cursor = "grab";
  readonly showCursorRing = false;

  private lastX = 0;
  private lastY = 0;
  private active = false;

  onDown(_ctx: ToolContext, s: InputSample): void {
    this.active = true;
    this.lastX = s.x;
    this.lastY = s.y;
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    if (!this.active) return;
    const s = samples[samples.length - 1];
    ctx.camera.panByScreen(s.x - this.lastX, s.y - this.lastY);
    this.lastX = s.x;
    this.lastY = s.y;
    ctx.invalidateInk();
    ctx.invalidateField();
    ctx.invalidateOverlay();
  }

  onUp(): void {
    this.active = false;
  }

  onCancel(): void {
    this.active = false;
  }
}
