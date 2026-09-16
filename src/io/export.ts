import { cssRgba, hexToRgb, mixRgb, rgbToHex, type Rgb } from "../core/color";
import { clamp01 } from "../core/math";
import { toSvgMatrix } from "../core/mat2d";
import { fieldContours } from "../physics/marching";
import { sampleField, type FieldSample } from "../physics/sdf";
import type { Body } from "../physics/world";
import { polygonToPath2D, polygonToSvgPath } from "../stroke/outline";
import type { Polygon } from "../stroke/types";
import type { SceneDocument } from "../scene/document";
import { expandRect, type Rect } from "../scene/types";
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

function exportBounds(doc: SceneDocument, margin: number): Rect {
  const b = doc.contentBounds();
  if (b.w <= 0 || b.h <= 0) return { x: -400, y: -300, w: 800, h: 600 };
  return expandRect(b, margin);
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

  ctx.setTransform(opt.scale, 0, 0, opt.scale, -box.x * opt.scale, -box.y * opt.scale);
  ctx.lineJoin = "round";

  for (const item of doc.items) {
    const paths = item.polys.filter((p) => p.length >= 3).map((p) => polygonToPath2D(p, item.smooth));
    if (paths.length === 0) continue;
    ctx.fillStyle = item.gradient
      ? buildGradient(ctx, item.color, item.opacity, item.gy0, item.gy1)
      : cssRgba(hexToRgb(item.color), item.opacity);
    for (const m of item.transforms) {
      ctx.save();
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      for (const p of paths) ctx.fill(p, "nonzero");
      ctx.restore();
    }
  }

  if (opt.matter) {
    const loops = fieldLoops(doc.bodies, doc.field, opt.fieldCell);
    for (const loop of loops) {
      const path = new Path2D();
      path.moveTo(loop.poly[0].x, loop.poly[0].y);
      for (let i = 1; i < loop.poly.length; i++) path.lineTo(loop.poly[i].x, loop.poly[i].y);
      path.closePath();
      ctx.globalAlpha = clamp01(doc.field.alpha);
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
      ctx.globalAlpha = 1;
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
 * SVG vectorial real.
 *
 * Cada item se emite una vez como `<path>` dentro de un `<g transform>` por
 * copia de simetria: el archivo pesa lo mismo con simetria de 24 sectores que
 * sin ella, y se puede editar despues en cualquier programa vectorial.
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
  if (opt.background) {
    parts.push(
      `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" fill="${doc.meta.background}"/>`,
    );
  }

  doc.items.forEach((item, index) => {
    const d = item.polys
      .filter((p) => p.length >= 3)
      .map((p) => polygonToSvgPath(p, item.smooth))
      .join(" ");
    if (!d) return;

    let fill: string;
    if (item.gradient) {
      const id = `g${index}`;
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
    parts.push(`<g fill="${fill}"${opacity} fill-rule="nonzero">`);
    for (const m of item.transforms) {
      const t = isIdentityMatrix(m) ? "" : ` transform="${toSvgMatrix(m)}"`;
      parts.push(`<path${t} d="${d}"/>`);
    }
    parts.push(`</g>`);
  });

  if (opt.matter) {
    const loops = fieldLoops(doc.bodies, doc.field, opt.fieldCell);
    if (loops.length > 0) {
      parts.push(`<g opacity="${fmt(clamp01(doc.field.alpha))}">`);
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
