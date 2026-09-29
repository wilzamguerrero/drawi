import { cssRgba, hexToRgb, mixRgb, rgbToHex, type Rgb } from "../core/color";
import { clamp01 } from "../core/math";
import { toSvgMatrix } from "../core/mat2d";
import { fieldContours } from "../physics/marching";
import { sampleField, type FieldSample } from "../physics/sdf";
import type { Body } from "../physics/world";
import { polygonToPath2D, polygonToSvgPath } from "../stroke/outline";
import type { Polygon } from "../stroke/types";
import type { SceneDocument } from "../scene/document";
import type { BlendMode, SceneLayer } from "../scene/layer";
import { expandRect, type InkItem, type Rect } from "../scene/types";
import { buildGradient } from "../render/ink-renderer";
import type { FieldStyle } from "../render/field-gl";

export interface ExportOptions {
  /** Multiplicador de resolucion para PNG. */
  scale: number;
  /** Margen alrededor del contenido en unidades de mundo. */
  margin: number;
  /** Pinta el fondo; si es false, el PNG sale con transparencia. */
  background: boolean;
  /** Incluye la materia (campo) ademas de la tinta. */
  matter: boolean;
  /** Resolucion del contorno del campo: menor es mas fiel. */
  fieldCell: number;
}

export const DEFAULT_EXPORT: ExportOptions = {
  scale: 2,
  margin: 32,
  background: true,
  matter: true,
  fieldCell: 2.5,
};

interface FieldLoop {
  poly: Polygon;
  color: Rgb;
}

/**
 * Contorno del campo por CPU con su color de mezcla.
 *
 * PNG y SVG comparten esta ruta a proposito: la exportacion no depende de que
 * haya WebGL ni del estado de la GPU, y el PNG coincide pixel a pixel con lo
 * que describe el SVG.
 */
function fieldLoops(bodies: readonly Body[], style: FieldStyle, cell: number): FieldLoop[] {
  if (bodies.length === 0) return [];
  const loops = fieldContours(bodies, style.blend, { cell, iso: 0 });
  const colors = bodies.map((b) => {
    const c = hexToRgb(b.color);
    return [c.r / 255, c.g / 255, c.b / 255] as [number, number, number];
  });
  const sample: FieldSample = { d: 0, r: 0, g: 0, b: 0 };
  return loops.map((poly) => {
    let cx = 0;
    let cy = 0;
    for (const p of poly) {
      cx += p.x;
      cy += p.y;
    }
    cx /= poly.length;
    cy /= poly.length;
    sampleField(cx, cy, bodies, style.blend, colors, sample);
    return {
      poly,
      color: {
        r: Math.round(clamp01(sample.r) * 255),
        g: Math.round(clamp01(sample.g) * 255),
        b: Math.round(clamp01(sample.b) * 255),
      },
    };
  });
}

function exportBounds(doc: SceneDocument, margin: number): Rect {  const b = doc.contentBounds();
  if (b.w <= 0 || b.h <= 0) return { x: -400, y: -300, w: 800, h: 600 };
  return expandRect(b, margin);
}

/* --------------------------------------------------------------- capas (PNG)

   El PNG compone POR CAPAS, igual que el compositor de pantalla
   (`src/render/compositor.ts`): recorre `doc.layers` de abajo arriba, pinta cada
   capa en su propio lienzo fuera de pantalla y la vuelca con su opacidad, modo de
   fusión, máscara y recorte. La única diferencia es la transformación: aquí es la
   del encuadre de exportación (escala + desplazamiento del `box`), no una cámara.
   Así el PNG reproduce con fidelidad completa lo que se ve en pantalla. La materia
   sigue pintándose aparte, encima, como hasta ahora. */

/** Lienzo transparente fuera de pantalla del tamaño del PNG. */
function makeBuffer(width: number, height: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const cx = c.getContext("2d");
  if (!cx) throw new Error("Canvas 2D no disponible");
  return cx;
}

/** Fija en un contexto la transformación de mundo→PNG del encuadre. */
function setExportTransform(ctx: CanvasRenderingContext2D, box: Rect, scale: number): void {
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  ctx.lineJoin = "round";
}

/** ¿Se pinta esta capa? (ojo propio y ojo de todos sus ancestros). */
function layerVisible(layer: SceneLayer, doc: SceneDocument): boolean {
  if (!layer.visible) return false;
  let p = layer.parentId;
  while (p) {
    const parent = doc.layerById(p);
    if (!parent || !parent.visible) return false;
    p = parent.parentId;
  }
  return true;
}

/** Pinta los items secos de una capa; los de alfa bloqueado con source-atop. */
function paintExportItems(ctx: CanvasRenderingContext2D, items: readonly InkItem[]): void {
  for (const item of items) {
    const paths = item.polys.filter((p) => p.length >= 3).map((p) => polygonToPath2D(p, item.smooth));
    if (paths.length === 0) continue;
    if (item.erase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${item.opacity})`;
    } else {
      ctx.globalCompositeOperation = item.atop ? "source-atop" : "source-over";
      ctx.fillStyle = item.gradient
        ? buildGradient(ctx, item.color, item.opacity, item.gy0, item.gy1)
        : cssRgba(hexToRgb(item.color), item.opacity);
    }
    for (const m of item.transforms) {
      ctx.save();
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      for (const p of paths) ctx.fill(p, "nonzero");
      ctx.restore();
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Resta (o intersecta, si está invertida) la máscara de la capa a su lienzo. */
function applyExportMask(buf: CanvasRenderingContext2D, layer: SceneLayer, box: Rect, scale: number): void {
  const mask = layer.mask;
  if (!mask) return;
  const w = buf.canvas.width;
  const h = buf.canvas.height;
  const mc = makeBuffer(w, h);
  setExportTransform(mc, box, scale);
  for (const item of mask.items) {
    mc.globalCompositeOperation = item.erase ? "destination-out" : "source-over";
    mc.fillStyle = `rgba(0,0,0,${item.opacity})`;
    const paths = item.polys.filter((p) => p.length >= 3).map((p) => polygonToPath2D(p, item.smooth));
    for (const m of item.transforms) {
      mc.save();
      mc.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      for (const p of paths) mc.fill(p, "nonzero");
      mc.restore();
    }
  }
  mc.globalCompositeOperation = "source-over";
  mc.setTransform(1, 0, 0, 1, 0, 0);
  buf.setTransform(1, 0, 0, 1, 0, 0);
  buf.globalCompositeOperation = mask.inverted ? "destination-in" : "destination-out";
  buf.drawImage(mc.canvas, 0, 0);
  buf.globalCompositeOperation = "source-over";
}

/** Pinta el contenido de una capa (tinta o grupo) en un lienzo nuevo, o null. */
function renderExportLayer(layer: SceneLayer, doc: SceneDocument, box: Rect, scale: number): CanvasRenderingContext2D | null {
  const w = Math.max(1, Math.round(box.w * scale));
  const h = Math.max(1, Math.round(box.h * scale));
  const buf = makeBuffer(w, h);
  if (layer.kind === "group") {
    const children = doc.childLayers(layer.id);
    if (children.length === 0) return null;
    compositeExportList(buf, children, doc, box, scale);
    return buf;
  }
  setExportTransform(buf, box, scale);
  paintExportItems(buf, doc.layerItems(layer.id));
  buf.setTransform(1, 0, 0, 1, 0, 0);
  applyExportMask(buf, layer, box, scale);
  return buf;
}

/** Compone una capa base con las capas de recorte que la siguen y la vuelca. */
function compositeExportUnit(
  out: CanvasRenderingContext2D,
  base: SceneLayer,
  clips: readonly SceneLayer[],
  doc: SceneDocument,
  box: Rect,
  scale: number,
): void {
  if (base.kind === "matter") return; // plano propio, se pinta aparte
  if (!layerVisible(base, doc)) return;
  const content = renderExportLayer(base, doc, box, scale);
  if (!content) return;

  let final = content;
  const visibleClips = clips.filter((c) => layerVisible(c, doc));
  if (visibleClips.length > 0) {
    const stack = makeBuffer(content.canvas.width, content.canvas.height);
    stack.drawImage(content.canvas, 0, 0);
    for (const clip of visibleClips) {
      const cc = renderExportLayer(clip, doc, box, scale);
      if (!cc) continue;
      // Recorta el contenido del clip a la silueta acumulada de la base.
      cc.globalCompositeOperation = "destination-in";
      cc.drawImage(stack.canvas, 0, 0);
      cc.globalCompositeOperation = "source-over";
      stack.globalAlpha = clip.opacity * clip.fill;
      stack.globalCompositeOperation = clip.blend;
      stack.drawImage(cc.canvas, 0, 0);
      stack.globalAlpha = 1;
      stack.globalCompositeOperation = "source-over";
    }
    final = stack;
  }

  out.save();
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = base.opacity * base.fill;
  out.globalCompositeOperation = base.blend;
  out.drawImage(final.canvas, 0, 0);
  out.restore();
}

/** Recorre una lista ordenada de capas agrupando cada base con sus recortes. */
function compositeExportList(
  out: CanvasRenderingContext2D,
  list: readonly SceneLayer[],
  doc: SceneDocument,
  box: Rect,
  scale: number,
): void {
  let i = 0;
  while (i < list.length) {
    const layer = list[i];
    if (layer.clip) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < list.length && list[j].clip) j++;
    compositeExportUnit(out, layer, list.slice(i + 1, j), doc, box, scale);
    i = j;
  }
}

/** Compone toda la tinta (capas ink/group) sobre `out`, respetando el orden. */
function compositeExportInk(out: CanvasRenderingContext2D, doc: SceneDocument, box: Rect, scale: number): void {
  compositeExportList(out, doc.childLayers(null), doc, box, scale);
}

/** Rasteriza el documento completo a un canvas nuevo. */
export function renderToCanvas(
  doc: SceneDocument,
  options: Partial<ExportOptions> = {},
): HTMLCanvasElement {
  const opt = { ...DEFAULT_EXPORT, ...options };
  const box = exportBounds(doc, opt.margin);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.w * opt.scale));
  canvas.height = Math.max(1, Math.round(box.h * opt.scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D no disponible");

  if (opt.background) {
    ctx.fillStyle = doc.meta.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Tinta: se compone por capas (orden, opacidad, fusión, máscara, recorte).
  compositeExportInk(ctx, doc, box, opt.scale);

  ctx.setTransform(opt.scale, 0, 0, opt.scale, -box.x * opt.scale, -box.y * opt.scale);
  ctx.lineJoin = "round";

  // Materia: cada capa se pinta encima de la tinta con su opacidad y fusión,
  // en el mismo orden (abajo→arriba) que en pantalla.
  if (opt.matter) {
    for (const layer of doc.matterLayers) {
      if (!layer.visible) continue;
      const bodies = doc.physics.bodiesOf(layer.id);
      if (bodies.length === 0) continue;
      const layerAlpha = clamp01(doc.field.alpha) * clamp01(layer.opacity * layer.fill);
      ctx.globalCompositeOperation = layer.blend;
      const loops = fieldLoops(bodies, doc.field, opt.fieldCell);
      for (const loop of loops) {
        const path = new Path2D();
        path.moveTo(loop.poly[0].x, loop.poly[0].y);
        for (let i = 1; i < loop.poly.length; i++) path.lineTo(loop.poly[i].x, loop.poly[i].y);
        path.closePath();
        ctx.globalAlpha = layerAlpha;
        ctx.fillStyle = cssRgba(loop.color, 1);
        ctx.fill(path);
        if (doc.field.shade > 0) {
          ctx.save();
          ctx.clip(path);
          ctx.strokeStyle = cssRgba(mixRgb(loop.color, { r: 0, g: 0, b: 0 }, 0.45), doc.field.shade * 0.6);
          ctx.lineWidth = Math.max(2, doc.field.depth * 0.5);
          ctx.stroke(path);
          ctx.restore();
        }
        if (doc.field.outline > 0) {
          ctx.strokeStyle = cssRgba(hexToRgb(doc.field.outlineColor), 1);
          ctx.lineWidth = doc.field.outline;
          ctx.stroke(path);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

export async function exportPng(
  doc: SceneDocument,
  options: Partial<ExportOptions> = {},
): Promise<Blob> {
  const canvas = renderToCanvas(doc, options);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("No se pudo generar el PNG"));
    }, "image/png");
  });
}

/**
 * SVG vectorial real, POR CAPAS.
 *
 * Recorre `doc.layers` de abajo arriba (grupos incluidos) y emite cada capa como
 * un `<g>` con su opacidad (`opacity`), su modo de fusión (`style="mix-blend-mode"`,
 * que los valores de fusión mapean 1:1), su máscara pintable y sus borrados como
 * `<mask>`, y el recorte como `<clipPath>` tomado de la geometría de la capa base.
 * Cada item se emite una vez dentro de un `<g transform>` por copia de simetria,
 * así el archivo se puede editar despues en cualquier programa vectorial.
 *
 * Nota: `mix-blend-mode` es estandar SVG/CSS, pero algún visor antiguo puede
 * ignorarlo y pintar la capa en normal; para fidelidad completa, exporta a PNG.
 */
export function exportSvg(doc: SceneDocument, options: Partial<ExportOptions> = {}): string {
  const opt = { ...DEFAULT_EXPORT, ...options };
  const box = exportBounds(doc, opt.margin);
  const w = Math.round(box.w);
  const h = Math.round(box.h);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
      `viewBox="${fmt(box.x)} ${fmt(box.y)} ${fmt(box.w)} ${fmt(box.h)}">`,
  );

  const defs: string[] = [];
  let uid = 0;
  const nextId = (p: string): string => `${p}${uid++}`;
  const boxRect = (fill: string): string =>
    `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" fill="${fill}"/>`;
  const maskOpen = (id: string): string =>
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}">`;
  const blendStyle = (b: BlendMode): string => (b === "source-over" ? "" : ` style="mix-blend-mode:${b}"`);
  const pathData = (item: { polys: readonly Polygon[]; smooth: boolean }): string =>
    item.polys
      .filter((p) => p.length >= 3)
      .map((p) => polygonToSvgPath(p, item.smooth))
      .join(" ");

  if (opt.background) parts.push(boxRect(doc.meta.background));

  // PLACEHOLDER_SVG_ITEMS
  const svgVisible = (layer: SceneLayer): boolean => layerVisible(layer, doc);

  // Items secos (no borradores) de una capa como <g fill><path/></g>.
  function itemsToSvg(items: readonly InkItem[]): string[] {
    const out: string[] = [];
    for (const item of items) {
      if (item.erase) continue; // los borradores van a la <mask> de la capa
      const d = pathData(item);
      if (!d) continue;
      let fill: string;
      if (item.gradient) {
        const id = nextId("grad");
        const c = hexToRgb(item.color);
        defs.push(
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${fmt(item.gy0)}" x2="0" y2="${fmt(item.gy1)}">` +
            `<stop offset="0" stop-color="${rgbToHex(c)}" stop-opacity="${fmt(item.opacity)}"/>` +
            `<stop offset="1" stop-color="${rgbToHex(c)}" stop-opacity="0"/>` +
            `</linearGradient>`,
        );
        fill = `url(#${id})`;
      } else {
        fill = item.color;
      }
      const opacity = item.gradient ? "" : ` fill-opacity="${fmt(item.opacity)}"`;
      out.push(`<g fill="${fill}"${opacity} fill-rule="nonzero">`);
      for (const m of item.transforms) {
        const t = isIdentityMatrix(m) ? "" : ` transform="${toSvgMatrix(m)}"`;
        out.push(`<path${t} d="${d}"/>`);
      }
      out.push(`</g>`);
    }
    return out;
  }

  // PLACEHOLDER_SVG_MASKS
  // <mask> con los borradores propios de la capa: blanco conserva, negro recorta.
  function eraseMaskFor(items: readonly InkItem[]): string | null {
    const erase = items.filter((it) => it.erase && it.polys.some((p) => p.length >= 3));
    if (erase.length === 0) return null;
    const id = nextId("erase");
    const m: string[] = [maskOpen(id), boxRect("#fff")];
    for (const item of erase) {
      const d = pathData(item);
      if (!d) continue;
      for (const t of item.transforms) {
        const tf = isIdentityMatrix(t) ? "" : ` transform="${toSvgMatrix(t)}"`;
        m.push(`<path${tf} d="${d}" fill="#000" fill-opacity="${fmt(item.opacity)}" fill-rule="nonzero"/>`);
      }
    }
    m.push(`</mask>`);
    defs.push(m.join(""));
    return id;
  }

  // <mask> pintable de la capa: un trazo que oculta va a negro y uno que revela a
  // blanco; con la máscara invertida se cambian los papeles (y el fondo). Una
  // máscara invertida vacía oculta la capa entera, igual que el compositor.
  function paintMaskFor(layer: SceneLayer): string | null {
    const mask = layer.mask;
    if (!mask) return null;
    if (mask.items.length === 0 && !mask.inverted) return null;
    const inv = mask.inverted;
    const id = nextId("mask");
    const m: string[] = [maskOpen(id), boxRect(inv ? "#000" : "#fff")];
    for (const item of mask.items) {
      const d = pathData(item);
      if (!d) continue;
      const col = item.erase !== inv ? "#fff" : "#000";
      for (const t of item.transforms) {
        const tf = isIdentityMatrix(t) ? "" : ` transform="${toSvgMatrix(t)}"`;
        m.push(`<path${tf} d="${d}" fill="${col}" fill-opacity="${fmt(item.opacity)}" fill-rule="nonzero"/>`);
      }
    }
    m.push(`</mask>`);
    defs.push(m.join(""));
    return id;
  }

  // <clipPath> con la geometría (no borradores) de una capa de tinta base.
  function clipPathFor(base: SceneLayer): string | null {
    if (base.kind !== "ink") return null;
    const inner: string[] = [];
    for (const item of doc.layerItems(base.id)) {
      if (item.erase) continue;
      const d = pathData(item);
      if (!d) continue;
      for (const t of item.transforms) {
        const tf = isIdentityMatrix(t) ? "" : ` transform="${toSvgMatrix(t)}"`;
        inner.push(`<path${tf} d="${d}"/>`);
      }
    }
    if (inner.length === 0) return null;
    const id = nextId("clip");
    defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${inner.join("")}</clipPath>`);
    return id;
  }

  // PLACEHOLDER_SVG_UNITS
  // Contenido de una capa (sin su opacidad/fusión, que las pone el envoltorio):
  // sus items o sus hijos, con la máscara de borrado y la pintable aplicadas.
  function layerContentSvg(layer: SceneLayer): string[] {
    let body: string[];
    if (layer.kind === "group") {
      body = compositeLayersSvg(doc.childLayers(layer.id));
    } else {
      const items = doc.layerItems(layer.id);
      body = itemsToSvg(items);
      const eraseId = eraseMaskFor(items);
      if (eraseId) body = [`<g mask="url(#${eraseId})">`, ...body, `</g>`];
    }
    const maskId = paintMaskFor(layer);
    if (maskId) body = [`<g mask="url(#${maskId})">`, ...body, `</g>`];
    return body;
  }

  // Una capa base y sus recortes: la base marca opacidad/fusión de todo el grupo;
  // cada recorte va con su propia opacidad/fusión y recortado a la base.
  function unitSvg(base: SceneLayer, clips: readonly SceneLayer[]): string[] {
    if (base.kind === "matter" || !svgVisible(base)) return [];
    const content = layerContentSvg(base);
    const visibleClips = clips.filter(svgVisible);
    if (content.length === 0 && visibleClips.length === 0) return [];

    const op = base.opacity * base.fill;
    const opAttr = op < 1 ? ` opacity="${fmt(op)}"` : "";
    const out: string[] = [`<g${opAttr}${blendStyle(base.blend)}>`, ...content];

    const clipId = visibleClips.length > 0 ? clipPathFor(base) : null;
    for (const clip of visibleClips) {
      const cc = layerContentSvg(clip);
      if (cc.length === 0) continue;
      const cop = clip.opacity * clip.fill;
      const copAttr = cop < 1 ? ` opacity="${fmt(cop)}"` : "";
      const cpAttr = clipId ? ` clip-path="url(#${clipId})"` : "";
      out.push(`<g${copAttr}${blendStyle(clip.blend)}${cpAttr}>`, ...cc, `</g>`);
    }
    out.push(`</g>`);
    return out;
  }

  // Recorre una lista ordenada agrupando cada base con los recortes que la siguen.
  function compositeLayersSvg(list: readonly SceneLayer[]): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < list.length) {
      const layer = list[i];
      if (layer.clip) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < list.length && list[j].clip) j++;
      out.push(...unitSvg(layer, list.slice(i + 1, j)));
      i = j;
    }
    return out;
  }

  parts.push(...compositeLayersSvg(doc.childLayers(null)));

  // Materia: un <g> por capa visible, con su opacidad y su modo de fusión, en
  // el mismo orden que en pantalla (abajo→arriba), siempre encima de la tinta.
  if (opt.matter) {
    for (const layer of doc.matterLayers) {
      if (!layer.visible) continue;
      const bodies = doc.physics.bodiesOf(layer.id);
      if (bodies.length === 0) continue;
      const alpha = clamp01(doc.field.alpha) * clamp01(layer.opacity * layer.fill);
      const loops = fieldLoops(bodies, doc.field, opt.fieldCell);
      if (loops.length === 0) continue;
      parts.push(`<g opacity="${fmt(alpha)}"${blendStyle(layer.blend)}>`);
      for (const loop of loops) {
        const d = polygonToSvgPath(loop.poly, false);
        const stroke =
          doc.field.outline > 0
            ? ` stroke="${doc.field.outlineColor}" stroke-width="${fmt(doc.field.outline)}" stroke-linejoin="round"`
            : "";
        parts.push(`<path d="${d}" fill="${rgbToHex(loop.color)}"${stroke}/>`);
      }
      parts.push(`</g>`);
    }
  }

  if (defs.length > 0) parts.splice(1, 0, `<defs>${defs.join("")}</defs>`);
  parts.push("</svg>");
  return parts.join("\n");
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

const isIdentityMatrix = (m: { a: number; b: number; c: number; d: number; e: number; f: number }): boolean =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

/** Descarga un blob o una cadena con el nombre indicado. */
export function download(data: Blob | string, filename: string, mime = "text/plain"): void {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Un tick es suficiente para que el navegador tome el blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timestampName(prefix: string, ext: string): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
