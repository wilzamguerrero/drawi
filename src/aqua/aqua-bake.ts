/**
 * Horneado de la acuarela: del fluido vivo a un ráster de mundo.
 *
 * El fluido de `AquaField` vive en la GPU y está anclado al VIEWPORT: sus
 * coordenadas son UV de pantalla, así que no acompaña al paneo ni al zoom y no
 * se puede serializar. Para guardar, exportar o simplemente dejar la mancha
 * clavada en el dibujo hay que pasarla a coordenadas de MUNDO, y eso es lo que
 * hace este módulo: dibuja el lienzo del fluido a través de la transformación
 * inversa de la cámara sobre un lienzo cuyo rectángulo de mundo se conoce.
 *
 * Una capa de acuarela puede tener ya un ráster horneado de antes. Hornear otra
 * vez no lo pisa: se compone el viejo y el nuevo en un lienzo que cubre la unión
 * de ambos rectángulos, de modo que hornear es acumulativo y nunca pierde lo
 * que ya estaba seco.
 */

import type { Camera } from "../render/camera";
import type { SceneLayer } from "../scene/layer";
import { unionRect, type Rect } from "../scene/types";

/** Ráster de acuarela ya en coordenadas de mundo. */
export interface BakedAqua {
  canvas: HTMLCanvasElement;
  rect: Rect;
}

/** Lado máximo del ráster horneado: evita que acumular horneados dispare la
 *  memoria (y que `toDataURL` tarde un segundo entero). */
const MAX_SIDE = 4096;

/**
 * Hornea una capa de acuarela a un ráster de mundo.
 *
 * `live` es el lienzo del fluido (espacio de pantalla, puede ser null si la capa
 * no tiene simulación viva) y `previous` el ráster ya horneado de la capa (ya
 * decodificado por quien llama, porque decodificar es asíncrono y esto no).
 * Devuelve null si no hay nada que hornear.
 */
export function bakeAqua(
  layer: SceneLayer,
  live: HTMLCanvasElement | null,
  previous: CanvasImageSource | null,
  camera: Camera,
): BakedAqua | null {
  const prevRect = previous && layer.aquaRect ? layer.aquaRect : null;
  // El fluido cubre exactamente el viewport; en mundo, su envolvente.
  const liveRect = live ? camera.visibleBounds(0) : null;
  const rect = liveRect ? unionRect(prevRect, liveRect) : prevRect;
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;

  // Resolución: la del fluido en pantalla, para no perder detalle, acotada.
  const pxPerWorld = live
    ? (live.width / Math.max(camera.width, 1)) * camera.zoom
    : prevRect && previous
      ? sourceWidth(previous) / Math.max(prevRect.w, 1e-6)
      : 1;
  const scale = Math.min(
    Math.max(pxPerWorld, 0.01),
    MAX_SIDE / Math.max(rect.w, rect.h),
  );

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.w * scale));
  canvas.height = Math.max(1, Math.round(rect.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Primero lo que ya estaba seco, luego el fluido encima: el mismo orden en
  // que lo compone la pantalla, así hornear no cambia lo que se ve.
  if (previous && prevRect) {
    worldTransform(ctx, rect, scale);
    ctx.drawImage(previous, prevRect.x, prevRect.y, prevRect.w, prevRect.h);
  }
  if (live) {
    worldTransform(ctx, rect, scale);
    screenToWorldTransform(ctx, camera);
    ctx.drawImage(live, 0, 0, camera.width, camera.height);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, rect };
}

/** Deja el contexto en coordenadas de MUNDO sobre un lienzo que cubre `rect`. */
export function worldTransform(ctx: CanvasRenderingContext2D, rect: Rect, scale: number): void {
  ctx.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
}

/**
 * Encadena la inversa de la cámara: tras esto, dibujar en PÍXELES DE PANTALLA
 * cae donde le toca en el mundo. Es `Camera.applyTo` al revés, y por eso el
 * orden va del revés: trasladar a la cámara, deshacer el zoom, deshacer el giro
 * y centrar el viewport.
 */
export function screenToWorldTransform(ctx: CanvasRenderingContext2D, camera: Camera): void {
  ctx.translate(camera.x, camera.y);
  ctx.scale(1 / camera.zoom, 1 / camera.zoom);
  ctx.rotate(-camera.rotation);
  ctx.translate(-camera.width / 2, -camera.height / 2);
}

const sourceWidth = (src: CanvasImageSource): number => {
  if (src instanceof HTMLImageElement) return src.naturalWidth || src.width;
  if (src instanceof HTMLCanvasElement) return src.width;
  return 1;
};

/** Decodifica un dataURL a una imagen lista para dibujar (null si falla). */
export function decodeImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
