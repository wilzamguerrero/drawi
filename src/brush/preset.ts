import type { BrushSettings } from "../stroke/types";
import { uid } from "../core/rng";

/**
 * Preset de pincel ráster: el paquete serializable que define un pincel al
 * estilo Photoshop. Es la unidad de la biblioteca —se guarda, se comparte, se
 * importa— y al aplicarse fija los campos `raster*` de `BrushSettings` más la
 * punta activa.
 *
 * La punta es procedural (redonda, con dureza) o un bitmap: una imagen cuyo
 * ALFA es la cobertura. Las puntas importadas (de un `.abr` o de un pack propio)
 * se guardan como dataURL de ese mapa de alfa, así un preset es autocontenido.
 */

export type RasterTip =
  | { kind: "round" }
  | { kind: "image"; src: string };

export interface BrushPreset {
  id: string;
  name: string;
  tip: RasterTip;
  /** Diámetro base en px de mundo. */
  size: number;
  opacity: number;
  hardness: number;
  spacing: number;
  flow: number;
  /** Ángulo base en grados. */
  angle: number;
  roundness: number;
  angleFollow: boolean;
  scatter: number;
  scatterCount: number;
  sizeJitter: number;
  angleJitter: number;
  roundnessJitter: number;
  flowJitter: number;
}

/** Campos de `BrushSettings` que un preset fija al aplicarse (la punta aparte). */
export function presetToBrush(p: BrushPreset): Partial<BrushSettings> {
  return {
    size: p.size,
    opacity: p.opacity,
    rasterHardness: p.hardness,
    rasterSpacing: p.spacing,
    rasterFlow: p.flow,
    rasterAngle: p.angle,
    rasterRoundness: p.roundness,
    rasterAngleFollow: p.angleFollow,
    rasterScatter: p.scatter,
    rasterScatterCount: p.scatterCount,
    rasterSizeJitter: p.sizeJitter,
    rasterAngleJitter: p.angleJitter,
    rasterRoundnessJitter: p.roundnessJitter,
    rasterFlowJitter: p.flowJitter,
  };
}

/** Fotografía los ajustes ráster actuales como preset (para "exportar el mío"). */
export function brushToPreset(b: BrushSettings, tip: RasterTip, name: string, id = uid()): BrushPreset {
  return {
    id,
    name,
    tip,
    size: b.size,
    opacity: b.opacity,
    hardness: b.rasterHardness,
    spacing: b.rasterSpacing,
    flow: b.rasterFlow,
    angle: b.rasterAngle,
    roundness: b.rasterRoundness,
    angleFollow: b.rasterAngleFollow,
    scatter: b.rasterScatter,
    scatterCount: b.rasterScatterCount,
    sizeJitter: b.rasterSizeJitter,
    angleJitter: b.rasterAngleJitter,
    roundnessJitter: b.rasterRoundnessJitter,
    flowJitter: b.rasterFlowJitter,
  };
}

const base = (): Omit<BrushPreset, "id" | "name"> => ({
  tip: { kind: "round" },
  size: 20,
  opacity: 1,
  hardness: 0.8,
  spacing: 0.1,
  flow: 0.9,
  angle: 0,
  roundness: 1,
  angleFollow: false,
  scatter: 0,
  scatterCount: 1,
  sizeJitter: 0,
  angleJitter: 0,
  roundnessJitter: 0,
  flowJitter: 0,
});

/** Pinceles de fábrica: cubren el abanico (duro, suave, lápiz, aerógrafo, etc.). */
export function defaultPresets(): BrushPreset[] {
  const mk = (name: string, over: Partial<BrushPreset>): BrushPreset => ({
    id: `builtin-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    ...base(),
    ...over,
  });
  return [
    mk("Redondo duro", { hardness: 1, spacing: 0.05, flow: 1, size: 12 }),
    mk("Redondo suave", { hardness: 0.35, spacing: 0.08, flow: 0.9, size: 24 }),
    mk("Lápiz", { hardness: 0.95, size: 4, spacing: 0.06, flow: 1, flowJitter: 0.1 }),
    mk("Aerógrafo", { hardness: 0.2, size: 42, spacing: 0.05, flow: 0.25, scatter: 0.5, scatterCount: 3, sizeJitter: 0.3 }),
    mk("Caligráfico", { hardness: 0.9, roundness: 0.25, angleFollow: true, size: 26, spacing: 0.04, flow: 1 }),
    mk("Tiza", { hardness: 0.8, size: 28, spacing: 0.14, flow: 0.9, flowJitter: 0.5, sizeJitter: 0.4, scatter: 0.25, scatterCount: 2 }),
  ];
}
