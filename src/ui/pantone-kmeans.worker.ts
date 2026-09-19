import { colorsFromPixels } from "./pantone-kmeans";
import type { ImportedColor } from "./pantone-palettes";

/**
 * Worker de extraccion de color.
 *
 * El hilo principal decodifica la imagen (necesita el canvas del DOM) y envia
 * aqui solo los pixeles RGBA ya listos; el k-means, que es lo que congelaba la
 * interfaz, corre en este hilo aparte y devuelve la lista de colores.
 */

interface Request {
  data: ArrayBuffer;
  numColors: number;
}

interface Response {
  colors?: ImportedColor[];
  error?: string;
}

self.onmessage = (e: MessageEvent<Request>) => {
  try {
    const pixels = new Uint8ClampedArray(e.data.data);
    const colors = colorsFromPixels(pixels, e.data.numColors);
    (self as unknown as Worker).postMessage({ colors } satisfies Response);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Error al procesar la imagen";
    (self as unknown as Worker).postMessage({ error } satisfies Response);
  }
};
