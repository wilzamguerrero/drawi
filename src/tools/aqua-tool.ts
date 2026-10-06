import type { InputSample } from "../input/pointer";
import type { Tool, ToolContext } from "./types";

/**
 * Herramienta de acuarela.
 *
 * No sabe nada de WebGL ni de fluidos: solo traduce los eventos del puntero a
 * llamadas del `AquaPort` que el editor expone (begin/move/end sobre el emisor
 * de fluido). El plano de acuarela se simula y compone en el bucle del editor.
 *
 * La presion real del lapiz se pasa tal cual; si el dispositivo no la informa
 * (`pressure < 0`), se usa 0.5 para que raton y dedo tengan un trazo medio.
 */
export class AquaTool implements Tool {
  readonly id = "aqua" as const;
  readonly cursor = "none";
  readonly showCursorRing = true;

  private pressureOf(s: InputSample): number {
    return s.pressure >= 0 ? s.pressure : 0.5;
  }

  onDown(ctx: ToolContext, s: InputSample): void {
    const aqua = ctx.aqua;
    if (!aqua) return;
    const uv = aqua.toUv(s.x, s.y);
    aqua.begin(uv.x, uv.y, this.pressureOf(s));
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    const aqua = ctx.aqua;
    if (!aqua) return;
    // Solo importa el ultimo punto real: el emisor interpola y suaviza internamente.
    const s = samples[samples.length - 1];
    if (!s) return;
    const uv = aqua.toUv(s.x, s.y);
    aqua.move(uv.x, uv.y, this.pressureOf(s));
  }

  onUp(ctx: ToolContext): void {
    ctx.aqua?.end();
  }

  onCancel(ctx: ToolContext): void {
    ctx.aqua?.end();
  }
}
