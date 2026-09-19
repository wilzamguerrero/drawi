import type { ImportedColor } from "./pantone-palettes";

/**
 * Nucleo de extraccion de color por k-means, sin DOM.
 *
 * Se separo de `pantone-importers.ts` para poder compartirlo entre el hilo
 * principal (fallback) y un Web Worker: el agrupamiento es la parte cara y, si
 * corre en el hilo principal, congela la interfaz. Aqui solo hay matematica pura
 * sobre pixeles, asi que el mismo codigo sirve dentro del worker.
 */

export type RGB = [number, number, number];

interface Cluster {
  center: RGB;
  count: number;
}

const dist2 = (a: RGB, b: RGB): number => {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
};

/** Muestrea la imagen ya decodificada: salta transparentes y un pixel de cada dos. */
export const samplePixels = (data: Uint8ClampedArray): RGB[] => {
  const sample: RGB[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // salta transparentes
    if ((i / 4) % 2 === 0) sample.push([data[i], data[i + 1], data[i + 2]]);
  }
  return sample;
};

const kMeans = (pixels: RGB[], k: number, maxIter: number): Cluster[] => {
  // Semillas por k-means++: dispersa los centros iniciales para no arrancar con
  // dos casi encima y perder un color.
  const centroids: RGB[] = [pixels[Math.floor(Math.random() * pixels.length)]];
  for (let i = 1; i < k; i++) {
    let sum = 0;
    const d2 = new Float64Array(pixels.length);
    for (let j = 0; j < pixels.length; j++) {
      let m = Infinity;
      for (const c of centroids) {
        const d = dist2(pixels[j], c);
        if (d < m) m = d;
      }
      d2[j] = m;
      sum += m;
    }
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

  const counts = new Int32Array(centroids.length);
  const sums = new Float64Array(centroids.length * 3);
  for (let iter = 0; iter < maxIter; iter++) {
    counts.fill(0);
    sums.fill(0);
    for (const p of pixels) {
      let min = Infinity;
      let idx = 0;
      for (let i = 0; i < centroids.length; i++) {
        const d = dist2(p, centroids[i]);
        if (d < min) {
          min = d;
          idx = i;
        }
      }
      counts[idx]++;
      sums[idx * 3] += p[0];
      sums[idx * 3 + 1] += p[1];
      sums[idx * 3 + 2] += p[2];
    }

    let converged = true;
    for (let i = 0; i < centroids.length; i++) {
      if (counts[i] === 0) continue;
      const c: RGB = [sums[i * 3] / counts[i], sums[i * 3 + 1] / counts[i], sums[i * 3 + 2] / counts[i]];
      if (dist2(centroids[i], c) > 1) converged = false;
      centroids[i] = c;
    }
    if (converged) break;
  }

  return centroids
    .map((center, i) => ({ center, count: counts[i] }))
    .filter((c) => c.count > 0);
};

/** Extrae `numColors` colores dominantes de los pixeles RGBA ya decodificados. */
export const colorsFromPixels = (data: Uint8ClampedArray, numColors: number): ImportedColor[] => {
  const sample = samplePixels(data);
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

/** Nombre descriptivo del color a partir de su HSL. */
export const colorName = (r: number, g: number, b: number, index: number): string => {
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
