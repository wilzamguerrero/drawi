import type { ImportedColor } from "./pantone-palettes";

/**
 * Importadores de color para la rueda Pantone.
 *
 * Portado de `PantoneWheel/importers.ts` del estudio de referencia: lee paletas
 * en los formatos de Adobe (.ase / .aco, big-endian) y extrae una paleta de una
 * imagen por agrupamiento k-means en el espacio RGB. Nada de esto toca el DOM
 * salvo el canvas temporal que muestrea la imagen.
 */

// ------------------------------------------------------------ extraer de imagen

export const extractColorsFromImage = (file: File, numColors = 12): Promise<ImportedColor[]> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.onload = () => {
        try {
          resolve(getImageColors(img, numColors));
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

const getImageColors = (img: HTMLImageElement, numColors: number): ImportedColor[] => {
  // Se reduce la imagen: para sacar los colores dominantes no hace falta el
  // detalle, y muestrear 300px de lado es mucho mas rapido que la original.
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
  const pixels = ctx.getImageData(0, 0, width, height).data;

  const sample: RGB[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue; // salta transparentes
    if ((i / 4) % 2 === 0) sample.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  if (sample.length === 0) throw new Error("La imagen no tiene pixeles validos");

  const clusters = kMeans(sample, numColors, 20);
  clusters.sort((a, b) => b.count - a.count);
  return clusters.map((c, i) => ({
    r: Math.round(c.center[0]),
    g: Math.round(c.center[1]),
    b: Math.round(c.center[2]),
    name: colorName(c.center[0], c.center[1], c.center[2], i + 1),
  }));
};

type RGB = [number, number, number];

interface Cluster {
  center: RGB;
  pixels: RGB[];
  count: number;
}

const dist = (a: RGB, b: RGB): number => {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

const kMeans = (pixels: RGB[], k: number, maxIter: number): Cluster[] => {
  // Semillas por k-means++: dispersa los centros iniciales para no arrancar con
  // dos casi encima y perder un color.
  const centroids: RGB[] = [pixels[Math.floor(Math.random() * pixels.length)]];
  for (let i = 1; i < k; i++) {
    const d2 = pixels.map((p) => {
      const m = Math.min(...centroids.map((c) => dist(p, c)));
      return m * m;
    });
    const sum = d2.reduce((a, b) => a + b, 0);
    let target = Math.random() * sum;
    let picked = false;
    for (let j = 0; j < pixels.length; j++) {
      target -= d2[j];
      if (target <= 0) {
        centroids.push([...pixels[j]]);
        picked = true;
        break;
      }
    }
    if (!picked) centroids.push(pixels[Math.floor(Math.random() * pixels.length)]);
  }

  let clusters: Cluster[] = [];
  for (let iter = 0; iter < maxIter; iter++) {
    clusters = centroids.map((c) => ({ center: [...c] as RGB, pixels: [], count: 0 }));
    for (const p of pixels) {
      let min = Infinity;
      let idx = 0;
      for (let i = 0; i < centroids.length; i++) {
        const d = dist(p, centroids[i]);
        if (d < min) {
          min = d;
          idx = i;
        }
      }
      clusters[idx].pixels.push(p);
      clusters[idx].count++;
    }

    let converged = true;
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].pixels.length === 0) continue;
      const c: RGB = [0, 0, 0];
      for (const p of clusters[i].pixels) {
        c[0] += p[0];
        c[1] += p[1];
        c[2] += p[2];
      }
      c[0] /= clusters[i].pixels.length;
      c[1] /= clusters[i].pixels.length;
      c[2] /= clusters[i].pixels.length;
      if (dist(centroids[i], c) > 1) converged = false;
      centroids[i] = c;
      clusters[i].center = c;
    }
    if (converged) break;
  }
  return clusters.filter((c) => c.count > 0);
};

/** Nombre descriptivo del color a partir de su HSL. */
const colorName = (r: number, g: number, b: number, index: number): string => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  h *= 360;
  s *= 100;
  const lp = l * 100;

  if (s < 10) {
    if (lp < 15) return `Negro ${index}`;
    if (lp < 35) return `Gris osc ${index}`;
    if (lp < 65) return `Gris ${index}`;
    if (lp < 85) return `Gris cl ${index}`;
    return `Blanco ${index}`;
  }

  let hue = "";
  if (h < 15 || h >= 345) hue = "Rojo";
  else if (h < 45) hue = "Naranja";
  else if (h < 75) hue = "Amaril";
  else if (h < 105) hue = "Lima";
  else if (h < 135) hue = "Verde";
  else if (h < 165) hue = "Teal";
  else if (h < 195) hue = "Cian";
  else if (h < 225) hue = "Cielo";
  else if (h < 255) hue = "Azul";
  else if (h < 285) hue = "Purpura";
  else if (h < 315) hue = "Magenta";
  else hue = "Rosa";

  const lm = lp < 25 ? "Osc " : lp > 75 ? "Cl " : "";
  return `${lm}${hue} ${index}`;
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
