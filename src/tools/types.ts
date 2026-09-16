import type { Rng } from "../core/rng";
import type { Mat2d } from "../core/mat2d";
import type { InputSample } from "../input/pointer";
import type { Vec2 } from "../core/vec2";
import type { Camera } from "../render/camera";
import type { SceneDocument } from "../scene/document";
import type { History } from "../app/history";
import type { BrushSettings, Polygon } from "../stroke/types";
import type { Body } from "../physics/world";
import type { PullFamily } from "./pull-shapes";

export type ToolId = "brush" | "shape" | "matter" | "symmetry" | "picker" | "hand";

export const TOOL_LABELS: Record<ToolId, string> = {
  brush: "Pincel",
  shape: "Forma",
  matter: "Materia",
  symmetry: "Simetria",
  picker: "Cuentagotas",
  hand: "Mano",
};

/** Trazo humedo: lo que se pinta mientras el gesto sigue vivo. */
export interface WetStroke {
  polys: Polygon[];
  transforms: Mat2d[];
  color: string;
  opacity: number;
  smooth: boolean;
  gradient: boolean;
  gy0: number;
  gy1: number;
}

/**
 * Fachada que el editor ofrece a las herramientas.
 *
 * Las herramientas no conocen el DOM ni el bucle de render: piden cambios y
 * marcan capas sucias. Asi una herramienta nueva se escribe sin tocar el
 * editor, y el editor puede reordenar el render sin tocar las herramientas.
 */
export interface ToolContext {
  readonly doc: SceneDocument;
  readonly camera: Camera;
  readonly history: History;
  readonly rng: Rng;

  brush: BrushSettings;
  color: string;
  /** Familia de forma "pull" activa; "random" elige una distinta cada vez. */
  pullFamily: PullFamily | "random";

  toWorld(s: InputSample, out?: Vec2): Vec2;
  setColor(hex: string): void;

  /** Trazo en curso (null lo borra). */
  setWet(wet: WetStroke | null): void;
  /** Consolida el trazo humedo como item de tinta. */
  commitWet(wet: WetStroke): void;

  invalidateInk(): void;
  invalidateField(): void;
  invalidateOverlay(): void;

  setHighlight(body: Body | null): void;
  setPreviewShape(visible: boolean): void;
  status(message: string): void;
  /** Lee el color compuesto de un punto de pantalla. */
  sampleScreenColor(x: number, y: number): string | null;
}

export interface Tool {
  readonly id: ToolId;
  /** Cursor CSS mientras la herramienta esta activa. */
  readonly cursor: string;
  /** Dibujar el anillo del pincel bajo el puntero. */
  readonly showCursorRing: boolean;

  onDown(ctx: ToolContext, s: InputSample): void;
  onMove(ctx: ToolContext, samples: InputSample[], predicted: InputSample[]): void;
  onUp(ctx: ToolContext, s: InputSample): void;
  onCancel(ctx: ToolContext): void;
  onHover?(ctx: ToolContext, s: InputSample | null): void;
}
