import type { ImportedColor } from "./pantone-palettes";
import { colorsFromPixels } from "./pantone-kmeans";

/**
 * Importadores de color para la rueda Pantone.
 *
 * Portado de `PantoneWheel/importers.ts` del estudio de referencia: lee paletas
 * en los formatos de Adobe (.ase / .aco, big-endian) y extrae una paleta de una
 * imagen por agrupamiento k-means en el espacio RGB. Nada de esto toca el DOM
 * salvo el canvas temporal que muestrea la imagen.
 */

// ------------------------------------------------------------ extraer de imagen

/**
 * Decodifica la imagen a un buffer RGBA reducido (max 300px de lado).
 *
 * Necesita el canvas del DOM, asi que corre en el hilo principal; es rapido. El
 * k-means, que es lo caro, se hace aparte (worker o fallback) sobre este buffer.
 */
export const decodeImagePixels = (file: File): Promise<{ data: Uint8ClampedArray }> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.onload = () => {
        try {
          const maxSize = 300;
          const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
          const width = Math.floor(img.width * scale);
          const height = Math.floor(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("No hay contexto 2D disponible");
          ctx.drawImage(img, 0, 0, width, height);
          resolve({ data: ctx.getImageData(0, 0, width, height).data });
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("No se pudo cargar la imagen"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });

/** Extrae los colores dominantes en el hilo principal (fallback sin worker). */
export const extractColorsFromImage = async (file: File, numColors = 12): Promise<ImportedColor[]> => {
  const { data } = await decodeImagePixels(file);
  return colorsFromPixels(data, numColors);
};

// ---------------------------------------------------------------- ASE / ACO

const be16 = (v: DataView, o: number): number => v.getUint16(o, false);
const be32 = (v: DataView, o: number): number => v.getUint32(o, false);
const bef32 = (v: DataView, o: number): number => v.getFloat32(o, false);

const readUtf16 = (v: DataView, offset: number, length: number): string => {
  let str = "";
  for (let i = 0; i < length - 1; i++) {
    const code = v.getUint16(offset + i * 2, false);
    if (code !== 0) str += String.fromCharCode(code);
  }
  return str;
};

/** Adobe Swatch Exchange (.ase): RGB, escala de grises o CMYK. */
export const parseASE = (buffer: ArrayBuffer): ImportedColor[] => {
  const view = new DataView(buffer);
  const colors: ImportedColor[] = [];
  let offset = 0;

  if (view.getUint32(0, false) !== 0x41534546) throw new Error("Firma ASE invalida");
  offset += 8; // firma + version

  const blocks = be32(view, offset);
  offset += 4;

  for (let i = 0; i < blocks; i++) {
    if (offset >= view.byteLength) break;
    const type = be16(view, offset);
    offset += 2;
    const len = be32(view, offset);
    offset += 4;
    const end = offset + len;

    if (type === 0x0001) {
      const nameLen = be16(view, offset);
      offset += 2;
      const name = readUtf16(view, offset, nameLen);
      offset += nameLen * 2;

      const model = [0, 1, 2, 3]
        .map((k) => String.fromCharCode(view.getUint8(offset + k)))
        .join("")
        .trim();
      offset += 4;

      let r = 0;
      let g = 0;
      let b = 0;
      if (model === "RGB") {
        r = bef32(view, offset) * 255;
        g = bef32(view, offset + 4) * 255;
        b = bef32(view, offset + 8) * 255;
      } else if (model === "Gray") {
        r = g = b = bef32(view, offset) * 255;
      } else if (model === "CMYK") {
        const c = bef32(view, offset);
        const m = bef32(view, offset + 4);
        const y = bef32(view, offset + 8);
        const k = bef32(view, offset + 12);
        r = 255 * (1 - c) * (1 - k);
        g = 255 * (1 - m) * (1 - k);
        b = 255 * (1 - y) * (1 - k);
      }

      if (model === "RGB" || model === "Gray" || model === "CMYK") {
        colors.push({ r: Math.round(r), g: Math.round(g), b: Math.round(b), name: name || `Color ${colors.length + 1}` });
      }
    }
    offset = end;
  }
  return colors;
};

/** Photoshop Color Swatch (.aco): se lee la seccion v2 con nombres. */
export const parseACO = (buffer: ArrayBuffer): ImportedColor[] => {
  const view = new DataView(buffer);
  const colors: ImportedColor[] = [];
  let offset = 0;

  offset += 2; // version v1
  let count = be16(view, offset);
  offset += 2;
  offset += count * 10; // salta bloque v1

  if (offset >= view.byteLength) return [];
  if (be16(view, offset) !== 2) return [];
  offset += 2;
  count = be16(view, offset);
  offset += 2;

  for (let i = 0; i < count; i++) {
    const space = be16(view, offset);
    offset += 2;
    const w = be16(view, offset);
    const x = be16(view, offset + 2);
    const y = be16(view, offset + 4);
    offset += 8; // w,x,y,z

    let name = "";
    let safe = 0;
    while (safe < 100) {
      const ch = be16(view, offset);
      offset += 2;
      if (ch === 0) break;
      name += String.fromCharCode(ch);
      safe++;
    }

    let r = 0;
    let g = 0;
    let b = 0;
    if (space === 0) {
      r = w / 256;
      g = x / 256;
      b = y / 256;
    } else if (space === 8) {
      r = g = b = (w / 10000) * 255;
    }
    colors.push({ r: Math.round(r), g: Math.round(g), b: Math.round(b), name: name || `Color ${i + 1}` });
  }
  return colors;
};
