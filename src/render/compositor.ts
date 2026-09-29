import { transformCtx } from "../core/mat2d";
import { cssRgba, hexToRgb } from "../core/color";
import { polygonToPath2D } from "../stroke/outline";
import { rectIntersects, type InkItem, type Rect } from "../scene/types";
import type { Polygon } from "../stroke/types";
import type { Mat2d } from "../core/mat2d";
import type { SceneDocument } from "../scene/document";
import type { SceneLayer } from "../scene/layer";
import type { Camera } from "./camera";
import type { Layer } from "./layer";
import type { WetStroke } from "../tools/types";
import { InkRenderer, buildGradient } from "./ink-renderer";

/**
 * Compositor de capas.
 *
 * `InkRenderer` sabe pintar un item; el compositor sabe pintar CAPAS: recorre
 * `doc.layers` de abajo arriba y compone cada una en su propio lienzo fuera de
 * pantalla para poder aplicarle opacidad, relleno, modo de fusión, máscara,
 * alfa bloqueado y recorte antes de volcarla sobre la tinta visible.
 *
 * La materia es una pseudo-capa: NO se compone aquí (vive en su plano WebGL/2D
 * propio); su fila del panel solo controla la visibilidad/opacidad de ese plano.
 *
 * Reutiliza los primitivos de `InkRenderer` (`drawItem`/`pathsFor`) y su caché
 * de `Path2D`, así que no reconstruye geometría: el coste extra frente al render
 * de una pasada es el de los lienzos intermedios, que se reciclan entre frames.
 */

export interface CompositeOptions {
  /** Trazo en curso; se compone dentro de la capa activa (o su máscara). */
  wet: WetStroke | null;
  activeLayerId: string;
  /** El trazo húmedo pinta la MÁSCARA de la capa activa, no su contenido. */
  maskMode: boolean;
  /** Capa aislada (modo foco): si está fijada, el resto se oculta. */
  soloId: string | null;
}

/** Lienzo fuera de pantalla con su contexto, redimensionable al vuelo. */
class Buffer {
  readonly canvas: HTMLCanvasElement = document.createElement("canvas");
  readonly ctx: CanvasRenderingContext2D;

  constructor() {
    const ctx = this.canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas 2D no disponible");
    this.ctx = ctx;
  }

  match(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

export class Compositor {
  // Un juego de lienzos por nivel de anidamiento de grupos: así un grupo puede
  // componer a sus hijos sin pisar los lienzos que usa su propia capa.
  private contentPool: Buffer[] = []; // contenido de una capa (o de un grupo)
  private stackPool: Buffer[] = []; // base + capas de recorte
  private maskPool: Buffer[] = []; // máscara en construcción
  private w = 0;
  private h = 0;

  constructor(private ink: InkRenderer) {}

  private bufAt(pool: Buffer[], depth: number): Buffer {
    let buf = pool[depth];
    if (!buf) {
      buf = new Buffer();
      pool[depth] = buf;
    }
    buf.match(this.w, this.h);
    return buf;
  }

  /** Compone toda la tinta (capas ink/group) sobre `target`, ya limpio. */
  composite(target: Layer, doc: SceneDocument, camera: Camera, opts: CompositeOptions): void {
    this.w = target.canvas.width;
    this.h = target.canvas.height;
    const view = camera.visibleBounds(64);
    target.clear();
    const roots = doc.layers.filter((l) => l.parentId === null);
    this.compositeList(target.ctx, roots, doc, camera, target.dpr, view, opts, 0);
  }

  /**
   * Compone una lista ordenada de capas (raíz o hijas de un grupo) sobre `out`.
   * Agrupa cada capa base con las capas de recorte que la siguen.
   */
  private compositeList(
    out: CanvasRenderingContext2D,
    list: SceneLayer[],
    doc: SceneDocument,
    camera: Camera,
    dpr: number,
    view: Rect,
    opts: CompositeOptions,
    depth: number,
  ): void {
    let i = 0;
    while (i < list.length) {
      const layer = list[i];
      // El recorte se resuelve junto a su capa base, nunca suelto.
      if (layer.clip) {
        i++;
        continue;
      }
      // Capas de recorte que se apoyan en esta (las inmediatamente superiores).
      let j = i + 1;
      while (j < list.length && list[j].clip) j++;
      const clips = list.slice(i + 1, j);
      this.compositeUnit(out, layer, clips, doc, camera, dpr, view, opts, depth);
      i = j;
    }
  }

  /** ¿Se pinta esta capa? (ojo propio, ojo de ancestros y modo foco). */
  private isVisible(layer: SceneLayer, doc: SceneDocument, opts: CompositeOptions): boolean {
    if (!layer.visible) return false;
    let p = layer.parentId;
    while (p) {
      const parent = doc.layerById(p);
      if (!parent || !parent.visible) return false;
      p = parent.parentId;
    }
    if (opts.soloId) return this.inSoloScope(layer, doc, opts.soloId);
    return true;
  }

  /** En modo foco solo se ve la capa aislada, su grupo y sus descendientes. */
  private inSoloScope(layer: SceneLayer, doc: SceneDocument, soloId: string): boolean {
    if (layer.id === soloId) return true;
    // Ancestro de la capa aislada (para que el grupo contenedor la deje pasar).
    let p: string | null = soloId;
    while (p) {
      const l = doc.layerById(p);
      if (!l) break;
      if (l.parentId === layer.id) return true;
      p = l.parentId;
    }
    // Descendiente de la capa aislada.
    p = layer.parentId;
    while (p) {
      if (p === soloId) return true;
      p = doc.layerById(p)?.parentId ?? null;
    }
    return false;
  }

  /** Compone una capa base y sus capas de recorte, y vuelca el resultado. */
  private compositeUnit(
    out: CanvasRenderingContext2D,
    base: SceneLayer,
    clips: SceneLayer[],
    doc: SceneDocument,
    camera: Camera,
    dpr: number,
    view: Rect,
    opts: CompositeOptions,
    depth: number,
  ): void {
    if (base.kind === "matter") return; // plano propio, no se compone aquí
    if (!this.isVisible(base, doc, opts)) return;

    // La base se pinta en su lienzo; si hay recortes, se acumulan sobre él.
    const layerBuf = this.bufAt(this.contentPool, depth);
    if (!this.renderLayerContent(base, doc, camera, dpr, view, opts, depth)) return;

    let content = layerBuf;
    const visibleClips = clips.filter((c) => this.isVisible(c, doc, opts));
    if (visibleClips.length > 0) {
      const stackBuf = this.bufAt(this.stackPool, depth);
      // Copia de la base al buffer de pila: define la región de recorte.
      stackBuf.clear();
      stackBuf.ctx.setTransform(1, 0, 0, 1, 0, 0);
      stackBuf.ctx.drawImage(layerBuf.canvas, 0, 0);
      for (const clip of visibleClips) {
        if (!this.renderLayerContent(clip, doc, camera, dpr, view, opts, depth)) continue;
        // Recorta el contenido a la silueta de la base (alfa de stackBuf).
        const lc = layerBuf.ctx;
        lc.setTransform(1, 0, 0, 1, 0, 0);
        lc.globalCompositeOperation = "destination-in";
        lc.drawImage(stackBuf.canvas, 0, 0);
        lc.globalCompositeOperation = "source-over";
        // Y se funde sobre la pila con SU opacidad y modo de fusión.
        const sc = stackBuf.ctx;
        sc.globalAlpha = clip.opacity * clip.fill;
        sc.globalCompositeOperation = clip.blend;
        sc.drawImage(layerBuf.canvas, 0, 0);
        sc.globalAlpha = 1;
        sc.globalCompositeOperation = "source-over";
      }
      content = stackBuf;
    }

    // Volcado final: la base marca la opacidad/fusión de todo el grupo recortado.
    out.save();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = base.opacity * base.fill;
    out.globalCompositeOperation = base.blend;
    out.drawImage(content.canvas, 0, 0);
    out.restore();
  }

  /**
   * Pinta el contenido de una capa en su lienzo (`contentPool[depth]`), ya con
   * su máscara/alfa aplicados. Devuelve `false` si no hay nada que volcar.
   */
  private renderLayerContent(
    layer: SceneLayer,
    doc: SceneDocument,
    camera: Camera,
    dpr: number,
    view: Rect,
    opts: CompositeOptions,
    depth: number,
  ): boolean {
    const buf = this.bufAt(this.contentPool, depth);
    buf.clear();

    if (layer.kind === "group") {
      const children = doc.childLayers(layer.id);
      if (children.length === 0) return false;
      this.compositeList(buf.ctx, children, doc, camera, dpr, view, opts, depth + 1);
      return true;
    }

    const ctx = buf.ctx;
    const items = doc.layerItems(layer.id);
    const isActive = layer.id === opts.activeLayerId;
    const paintingContent = isActive && opts.wet !== null && !opts.maskMode;

    camera.applyTo(ctx, dpr);
    this.paintItems(ctx, items, view);
    if (paintingContent && opts.wet) {
      // El trazo húmedo hereda el alfa bloqueado de su capa (source-atop).
      this.paintStroke(ctx, opts.wet, layer.alphaLock);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this.applyMask(buf, layer, camera, dpr, opts, depth, isActive);
    return true;
  }

  /** Pinta los items secos de una capa; los de alfa bloqueado con source-atop. */
  private paintItems(ctx: CanvasRenderingContext2D, items: InkItem[], view: Rect): void {
    for (const item of items) {
      if (!rectIntersects(item.bounds, view)) continue;
      if (item.atop && !item.erase) {
        ctx.globalCompositeOperation = "source-atop";
        this.ink.drawItem(ctx, item, this.ink.pathsFor(item));
        ctx.globalCompositeOperation = "source-over";
      } else {
        this.ink.drawItem(ctx, item, this.ink.pathsFor(item));
      }
    }
  }

  /** Pinta un trazo suelto (húmedo o de máscara) con el contexto en mundo. */
  private paintStroke(ctx: CanvasRenderingContext2D, wet: WetStroke, atop: boolean): void {
    const prev = ctx.globalCompositeOperation;
    if (wet.erase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${wet.opacity})`;
    } else {
      if (atop) ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = wet.gradient
        ? buildGradient(ctx, wet.color, wet.opacity, wet.gy0, wet.gy1)
        : cssRgba(hexToRgb(wet.color), wet.opacity);
    }
    this.fillPolys(ctx, wet.polys, wet.transforms, wet.smooth);
    ctx.globalCompositeOperation = prev;
  }

  /** Bucle común: convierte polígonos a Path2D y los rellena por transformación. */
  private fillPolys(
    ctx: CanvasRenderingContext2D,
    polys: readonly Polygon[],
    transforms: readonly Mat2d[],
    smooth: boolean,
  ): void {
    const paths: Path2D[] = [];
    for (const poly of polys) if (poly.length >= 3) paths.push(polygonToPath2D(poly, smooth));
    if (paths.length === 0) return;
    for (const m of transforms) {
      ctx.save();
      transformCtx(ctx, m);
      for (const p of paths) ctx.fill(p, "nonzero");
      ctx.restore();
    }
  }

  /**
   * Aplica la máscara de la capa a su lienzo ya pintado.
   *
   * Se construye una capa de "oculto": trazo normal (negro) OCULTA, trazo de
   * revelado recorta ese oculto. Luego se resta del contenido con
   * `destination-out` (normal) o se intersecta con `destination-in` (invertida).
   */
  private applyMask(
    buf: Buffer,
    layer: SceneLayer,
    camera: Camera,
    dpr: number,
    opts: CompositeOptions,
    depth: number,
    isActive: boolean,
  ): void {
    const mask = layer.mask;
    const previewing = isActive && opts.maskMode && opts.wet !== null;
    if (!mask && !previewing) return;

    const maskBuf = this.bufAt(this.maskPool, depth);
    maskBuf.clear();
    const mc = maskBuf.ctx;
    camera.applyTo(mc, dpr);
    if (mask) {
      for (const item of mask.items) {
        mc.globalCompositeOperation = item.erase ? "destination-out" : "source-over";
        mc.fillStyle = `rgba(0,0,0,${item.opacity})`;
        this.fillPolys(mc, item.polys, item.transforms, item.smooth);
      }
    }
    if (previewing && opts.wet) {
      const w = opts.wet;
      mc.globalCompositeOperation = w.erase ? "destination-out" : "source-over";
      mc.fillStyle = `rgba(0,0,0,${w.opacity})`;
      this.fillPolys(mc, w.polys, w.transforms, w.smooth);
    }
    mc.globalCompositeOperation = "source-over";
    mc.setTransform(1, 0, 0, 1, 0, 0);

    const inverted = mask?.inverted ?? false;
    const bc = buf.ctx;
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalCompositeOperation = inverted ? "destination-in" : "destination-out";
    bc.drawImage(maskBuf.canvas, 0, 0);
    bc.globalCompositeOperation = "source-over";
  }
}





