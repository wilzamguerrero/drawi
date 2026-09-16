/**
 * Capa de canvas 2D con tamano gestionado.
 *
 * Todas las capas comparten viewport y DPR; separarlas permite repintar solo
 * lo que cambia: la tinta seca casi nunca, el trazo humedo cada evento de
 * lapiz y el overlay solo cuando se mueve un gizmo.
 */
export class Layer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  dpr = 1;
  /** Marca de repintado pendiente; el bucle la consulta y la limpia. */
  dirty = true;

  constructor(className: string, opts: CanvasRenderingContext2DSettings = {}) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = className;
    const ctx = this.canvas.getContext("2d", { alpha: true, ...opts });
    if (!ctx) throw new Error("Canvas 2D no disponible");
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): boolean {
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.dpr === dpr) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.dirty = true;
    return true;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  fill(color: string): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  invalidate(): void {
    this.dirty = true;
  }
}
