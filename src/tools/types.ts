import type { Rng } from "../core/rng";
import type { Mat2d } from "../core/mat2d";
import type { InputSample } from "../input/pointer";
import type { Vec2 } from "../core/vec2";
import type { Camera } from "../render/camera";
import type { SceneDocument } from "../scene/document";
import type { History } from "../app/history";
import type { BrushSettings, Polygon } from "../stroke/types";
import type { Body } from "../physics/world";
import type { MatterOp } from "../app/editor";
import type { PullFamily } from "./pull-shapes";

export type ToolId = "select" | "brush" | "shape" | "matter" | "bridge" | "symmetry" | "picker" | "hand" | "aqua";

export const TOOL_LABELS: Record<ToolId, string> = {
  select: "Selección",
  brush: "Pincel",
  shape: "Forma",
  matter: "Materia",
  bridge: "Puente",
  symmetry: "Simetria",
  picker: "Cuentagotas",
  hand: "Mano",
  aqua: "Acuarela",
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
  /** Trazo de borrado: se compone con destination-out sobre la tinta. */
  erase?: boolean;
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
  /** Operacion activa de la herramienta Materia (mover/rotar/escalar). */
  matterOp: MatterOp;
  selectOp: import("../app/editor").SelectOp;
  keepAspect: boolean;
  selection: import("../app/selection").Selection;

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
  /** Pivote de transformacion visible (null lo oculta). */
  setPivot(p: Vec2 | null): void;
  setPreviewShape(visible: boolean): void;
  status(message: string): void;
  /** Lee el color compuesto de un punto de pantalla. */
  sampleScreenColor(x: number, y: number): string | null;
  /** Puerto a la acuarela (null si el plano no esta activo/disponible). */
  readonly aqua: AquaPort | null;
}

/**
 * Lo que la herramienta de acuarela necesita del editor: traducir pantalla a UV
 * y alimentar al emisor de fluido. El editor implementa esto sobre AquaField +
 * AquaStroker; la herramienta no conoce WebGL.
 */
export interface AquaPort {
  /** Modo de huella: pluma (pigmento) o pincel de agua. */
  mode: "pen" | "brush";
  /** Convierte un punto de pantalla (px CSS) a UV 0..1 del plano. */
  toUv(x: number, y: number): { x: number; y: number };
  begin(x: number, y: number, pressure: number): void;
  move(x: number, y: number, pressure: number): void;
  end(): void;
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
