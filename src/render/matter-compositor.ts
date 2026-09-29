import type { Body } from "../physics/world";
import type { SceneDocument } from "../scene/document";
import type { Camera } from "./camera";
import { FieldFallbackRenderer } from "./field-2d";
import type { FieldRenderer, FieldStyle } from "./field-gl";
import { Layer } from "./layer";

/**
 * Compositor de la materia por capas.
 *
 * Todos los cuerpos comparten un único mundo físico (chocan y se funden entre
 * sí), pero cada capa de materia se pinta por separado para tener su propia
 * opacidad y modo de fusión, y luego se componen de abajo arriba sobre un solo
 * lienzo que se muestra encima de la tinta.
 *
 * El campo se dibuja con el renderizador WebGL (un único contexto reutilizado
 * para todas las capas) o, si no hay WebGL, con un renderizador 2D por capa
 * (cada uno cachea su propio contorno). El resultado de cada capa se vuelca en
 * el lienzo de salida con su alfa y `globalCompositeOperation`.
 */
export class MatterCompositor {
  /** Lienzo compuesto final (se añade al DOM, sobre la tinta). */
  readonly output: Layer;
  /** Repintado pendiente; el bucle lo consulta y lo limpia. */
  dirty = true;

  // Respaldo 2D: un renderizador por capa para que su caché de contornos no se
  // pise entre capas (WebGL no lo necesita: rinde cada capa a su mismo canvas).
  private fallbacks = new Map<string, FieldFallbackRenderer>();
  private scratch: Layer | null = null;

  constructor(private field: FieldRenderer) {
    this.output = new Layer("layer layer-field");
  }

  resize(w: number, h: number, dpr: number): void {
    this.output.resize(w, h, dpr);
    this.scratch?.resize(w, h, dpr);
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
    for (const f of this.fallbacks.values()) f.invalidate();
  }

  /** Compone todas las capas de materia visibles sobre el lienzo de salida. */
  render(doc: SceneDocument, camera: Camera, dpr: number): void {
    const octx = this.output.ctx;
    this.output.clear();

    const live = new Set<string>();
    for (const layer of doc.matterLayers) {
      live.add(layer.id);
      if (!layer.visible) continue;
      const bodies = doc.physics.bodiesOf(layer.id);
      if (bodies.length === 0) continue;

      const src = this.renderLayer(layer.id, bodies, camera, doc.field, dpr);
      if (!src) continue;

      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.globalAlpha = Math.max(0, Math.min(1, layer.opacity * layer.fill));
      octx.globalCompositeOperation = layer.blend;
      octx.drawImage(src, 0, 0);
    }
    octx.globalAlpha = 1;
    octx.globalCompositeOperation = "source-over";

    // Suelta renderizadores 2D de capas que ya no existen.
    for (const id of [...this.fallbacks.keys()]) if (!live.has(id)) this.fallbacks.delete(id);

    this.dirty = false;
  }

  /** Pinta los cuerpos de una capa en un lienzo fuente y lo devuelve. */
  private renderLayer(
    id: string,
    bodies: readonly Body[],
    camera: Camera,
    style: FieldStyle,
    dpr: number,
  ): HTMLCanvasElement | null {
    if (this.field.available) {
      this.field.render(bodies, camera, style, dpr);
      return this.field.canvas;
    }
    const scratch = this.ensureScratch();
    scratch.clear();
    this.fallbackFor(id).render(scratch, bodies, camera, style);
    return scratch.canvas;
  }

  private ensureScratch(): Layer {
    if (!this.scratch) {
      this.scratch = new Layer("layer layer-field-scratch");
      this.scratch.resize(this.output.width, this.output.height, this.output.dpr);
    }
    return this.scratch;
  }

  private fallbackFor(id: string): FieldFallbackRenderer {
    let f = this.fallbacks.get(id);
    if (!f) {
      f = new FieldFallbackRenderer();
      this.fallbacks.set(id, f);
    }
    return f;
  }
}
