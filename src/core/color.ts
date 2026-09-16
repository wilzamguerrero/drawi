import { clamp01 } from "./math";

export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
}

export interface Hsv {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

export const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

export const rgbToHsv = ({ r, g, b }: Rgb): Hsv => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max <= 1e-6 ? 0 : d / max, v: max };
};

export const hsvToRgb = ({ h, s, v }: Hsv): Rgb => {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
};

const hex2 = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

export const rgbToHex = ({ r, g, b }: Rgb): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export const hexToRgb = (hex: string): Rgb => {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

export const cssRgba = (c: Rgb, alpha = 1): string =>
  `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${clamp01(alpha)})`;

export const rgbToFloat = (c: Rgb): [number, number, number] => [
  c.r / 255,
  c.g / 255,
  c.b / 255,
];

/** Luminancia relativa: decide si el texto sobre el color va claro u oscuro. */
export const luminance = ({ r, g, b }: Rgb): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});

export interface Palette {
  name: string;
  colors: string[];
}

/** Paletas de arranque: neutra (Alchemy), y varias de materia. */
export const DEFAULT_PALETTES: Palette[] = [
  {
    name: "Tinta",
    colors: ["#000000", "#1b1b1f", "#3d3d46", "#6e6e78", "#a8a8b3", "#d6d6dd", "#ffffff"],
  },
  {
    name: "Magma",
    colors: ["#1a0a0a", "#5c1717", "#a32222", "#e2571f", "#f59f2b", "#ffd66b", "#fff2cc"],
  },
  {
    name: "Abismo",
    colors: ["#04070f", "#0b1c3a", "#123a6b", "#1d6fa5", "#2ea8c4", "#7fdbd4", "#d8f7f2"],
  },
  {
    name: "Bioma",
    colors: ["#0d1a0e", "#1f3d22", "#3d6b33", "#6fa33f", "#b6cc4a", "#e8e06b", "#f6f5d6"],
  },
  {
    name: "Neón",
    colors: ["#0a0a12", "#2d1b69", "#6f2dbd", "#c724b1", "#ff3d81", "#ff8c42", "#ffe066"],
  },
  {
    name: "Arcilla",
    colors: ["#2b1d16", "#5a3a29", "#8c5f42", "#bd8b62", "#dcb894", "#efe0cc", "#fdf8f2"],
  },
];
