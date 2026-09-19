/**
 * Paletas de la rueda Pantone.
 *
 * Portado de `PantoneWheel/colors.ts` del estudio de referencia: cada paleta se
 * genera proceduralmente en HSL y se reparte en anillos concentricos de sectores
 * (spokes). El patron de altura da la silueta irregular caracteristica —unos
 * radios llegan mas lejos que otros— en vez de una corona perfecta.
 */

export interface Swatch {
  id: string;
  hex: string;
  name: string;
  family: string;
  ringIndex: number;
  startAngle: number;
  endAngle: number;
}

export interface Ring {
  radius: number;
  items: Swatch[];
}

export interface Palette {
  id: string;
  name: string;
  rings: Ring[];
  preview: string[];
}

// Geometria de los anillos (px, en el espacio local de la rueda).
const START_RADIUS = 95;
const RING_DEPTH = 52;
const MAX_RINGS = 6;

/** Cuantos anillos ocupa cada sector: da el borde irregular de la rueda. */
const HEIGHT_PATTERN = [6, 4, 5, 3, 5, 4, 6, 3, 5, 4, 5, 3];

const hslToHex = (h: number, s: number, l: number): string => {
  l /= 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
};

const emptyRings = (): Ring[] =>
  Array.from({ length: MAX_RINGS }, (_, i) => ({
    radius: START_RADIUS + i * RING_DEPTH,
    items: [],
  }));

/** Paleta "Copic Universal": grises frios, grises calidos y cromaticos. */
const generateCopic = (): Palette => {
  const SECTORS = 48;
  const WEDGE = 360 / SECTORS;
  const rings = emptyRings();

  for (let i = 0; i < SECTORS; i++) {
    const angle = i * WEDGE;
    let hue = 0;
    let satBase = 0;
    let family = "";
    let prefix = "";

    if (i < 8) {
      hue = 210;
      satBase = 15;
      family = "Gris frio";
      prefix = "C";
    } else if (i < 16) {
      hue = 40;
      satBase = 15;
      family = "Gris calido";
      prefix = "W";
    } else {
      hue = ((i - 16) / (SECTORS - 16)) * 360;
      satBase = 85;
      family = "Color";
      prefix = "C";
    }

    const depth = HEIGHT_PATTERN[i % HEIGHT_PATTERN.length];
    for (let r = 0; r < depth; r++) {
      let l = 0;
      let s = satBase;
      if (r === 0) {
        l = 15;
        s = Math.max(0, s - 10);
      } else if (r === 1) l = 35;
      else if (r === 2) l = 50;
      else {
        const t = (r - 2) / (MAX_RINGS - 3);
        l = 65 + t * 30;
        s = Math.max(10, s - t * 20);
      }
      if (prefix === "C" || prefix === "W") l = r === 0 ? 10 : 20 + r * 15;

      rings[r].items.push({
        id: `univ-${i}-${r}`,
        hex: hslToHex(hue, s, l),
        name: `${prefix}${Math.floor(hue / 10)}${r}`,
        family,
        ringIndex: r,
        startAngle: angle,
        endAngle: angle + WEDGE,
      });
    }
  }

  return { id: "universal", name: "Copic Universal", preview: ["#333", "#4FA1D8", "#E8C547", "#fff"], rings };
};

/** Paleta por interpolacion de tonos alrededor de la rueda. */
const generateSpectrum = (
  id: string,
  name: string,
  baseHues: number[],
  saturation: number,
  lightness: [number, number],
  sectors = 48,
): Palette => {
  const WEDGE = 360 / sectors;
  const rings = emptyRings();
  const preview = (baseHues.length ? baseHues : [0, 90, 180, 270])
    .slice(0, 4)
    .map((h) => hslToHex(h, saturation, 50));

  for (let i = 0; i < sectors; i++) {
    const progress = i / sectors;
    let hue: number;
    if (baseHues.length === 0) {
      hue = progress * 360;
    } else {
      hue = baseHues[Math.floor(progress * baseHues.length) % baseHues.length];
      hue += (i % (sectors / baseHues.length)) * 2;
    }

    const angle = i * WEDGE;
    const depth = HEIGHT_PATTERN[i % HEIGHT_PATTERN.length];
    for (let r = 0; r < depth; r++) {
      const step = (lightness[1] - lightness[0]) / (MAX_RINGS - 1);
      const l = lightness[0] + r * step;
      const s = Math.max(0, saturation - r * 5);
      rings[r].items.push({
        id: `${id}-${i}-${r}`,
        hex: hslToHex(hue, s, l),
        name: `${id.slice(0, 3).toUpperCase()}${i}${r}`,
        family: name,
        ringIndex: r,
        startAngle: angle,
        endAngle: angle + WEDGE,
      });
    }
  }

  return { id, name, preview, rings };
};

export const PANTONE_PALETTES: Palette[] = [
  generateCopic(),
  generateSpectrum("gray", "Escala de gris", [0], 0, [10, 95], 24),
  generateSpectrum("skin", "Tonos de piel", [10, 20, 30, 40, 350, 15], 30, [20, 90], 24),
  generateSpectrum("nature", "Bosque y tierra", [120, 140, 100, 30, 40, 200], 50, [20, 70], 36),
  generateSpectrum("ocean", "Oceano profundo", [180, 190, 200, 210, 220, 230], 70, [15, 85], 32),
  generateSpectrum("sunset", "Atardecer", [260, 280, 320, 360, 20, 40], 80, [30, 80], 36),
  generateSpectrum("neon", "Neon", [300, 320, 240, 180, 120, 60], 100, [30, 80]),
  generateSpectrum("pastel", "Pasteles", [], 40, [70, 95]),
  generateSpectrum("vintage", "Vintage", [40, 50, 180, 200, 350], 30, [30, 70], 36),
  generateSpectrum("pop", "Pop art", [0, 60, 120, 240, 300], 90, [40, 60], 20),
  generateSpectrum("gold", "Oro y metal", [40, 45, 50, 55], 80, [20, 80], 24),
];

export const getPalette = (id: string): Palette =>
  PANTONE_PALETTES.find((p) => p.id === id) ?? PANTONE_PALETTES[0];
