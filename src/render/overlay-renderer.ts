import { TAU } from "../core/math";
import type { Vec2 } from "../core/vec2";
import { outlinePolygon } from "../physics/shapes";
import type { ShapeDef } from "../physics/shapes";
import type { Body } from "../physics/world";
import { GIZMO, type SymmetryHandle, type SymmetryState } from "../symmetry/symmetry";
import type { Camera } from "./camera";
import type { Layer } from "./layer";

const ACCENT = "#4f8cff";
const ACCENT_SOFT = "rgba(79, 140, 255, 0.22)";
const HOT = "#ffb347";
const INK = "rgba(18, 20, 26, 0.55)";

export interface OverlayState {
  symmetry: SymmetryState;
  hoverHandle: SymmetryHandle;
  activeHandle: SymmetryHandle;
  /** Cursor del pincel en pantalla (null = puntero fuera). */
  cursor: Vec2 | null;
  /** Radio del pincel en px de pantalla. */
  cursorRadius: number;
  /** Forma en previsualizacion bajo el cursor (herramienta forma). */
  previewShape: ShapeDef | null;
  /** Cuerpo resaltado (hover o arrastre). */
  highlight: Body | null;
  /** Muestra la caja de contencion de la fisica. */
  showWalls: boolean;
  walls: { x: number; y: number; w: number; h: number };
  /** Dibuja los colisionadores encima del campo (depuracion). */
  debugColliders: boolean;
  bodies: readonly Body[];
}

/**
 * Capa de guias: gizmo de simetria, cursor del pincel, previsualizacion de
 * forma y ayudas de depuracion. Nunca se exporta ni entra en el historial.
 */
export class OverlayRenderer {
  render(layer: Layer, state: OverlayState, camera: Camera): void {
    const ctx = layer.ctx;
    ctx.setTransform(layer.dpr, 0, 0, layer.dpr, 0, 0);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (state.showWalls) this.drawWalls(ctx, state.walls, camera);
    if (state.debugColliders) this.drawColliders(ctx, state.bodies, camera);
    if (state.highlight) this.drawHighlight(ctx, state.highlight, camera);
    if (state.previewShape && state.cursor) {
      this.drawShapePreview(ctx, state.previewShape, state.cursor, camera);
    }
    if (state.symmetry.visible && state.symmetry.mode !== "none") {
      this.drawSymmetry(ctx, state, camera);
    } else if (state.symmetry.visible && state.activeHandle) {
      this.drawSymmetry(ctx, state, camera);
    }
    if (state.cursor && !state.previewShape) {
      this.drawCursor(ctx, state.cursor, state.cursorRadius);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawCursor(ctx: CanvasRenderingContext2D, p: Vec2, radius: number): void {
    const r = Math.max(1.5, radius);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, TAU);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawWalls(
    ctx: CanvasRenderingContext2D,
    walls: { x: number; y: number; w: number; h: number },
    camera: Camera,
  ): void {
    const a = camera.worldToScreen({ x: walls.x, y: walls.y });
    const b = camera.worldToScreen({ x: walls.x + walls.w, y: walls.y });
    const c = camera.worldToScreen({ x: walls.x + walls.w, y: walls.y + walls.h });
    const d = camera.worldToScreen({ x: walls.x, y: walls.y + walls.h });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.setLineDash([8, 7]);
    ctx.strokeStyle = "rgba(120,132,158,0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawColliders(
    ctx: CanvasRenderingContext2D,
    bodies: readonly Body[],
    camera: Camera,
  ): void {
    ctx.strokeStyle = "rgba(255, 96, 128, 0.85)";
    ctx.lineWidth = 1;
    for (const body of bodies) {
      ctx.beginPath();
      if (!body.local) {
        const p = camera.worldToScreen(body.pos);
        ctx.arc(p.x, p.y, body.shape.size * camera.zoom, 0, TAU);
      } else {
        for (let i = 0; i < body.world.length; i++) {
          const p = camera.worldToScreen(body.world[i]);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.stroke();
    }
  }

  private drawHighlight(ctx: CanvasRenderingContext2D, body: Body, camera: Camera): void {
    const poly = outlinePolygon(body.shape, 64);
    const cos = Math.cos(body.angle);
    const sin = Math.sin(body.angle);
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const lx = poly[i].x;
      const ly = poly[i].y;
      const p = camera.worldToScreen({
        x: body.pos.x + lx * cos - ly * sin,
        y: body.pos.y + lx * sin + ly * cos,
      });
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private drawShapePreview(
    ctx: CanvasRenderingContext2D,
    shape: ShapeDef,
    cursor: Vec2,
    camera: Camera,
  ): void {
    const poly = outlinePolygon(shape, 72);
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const x = cursor.x + poly[i].x * camera.zoom;
      const y = cursor.y + poly[i].y * camera.zoom;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = ACCENT_SOFT;
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /**
   * Gizmo de simetria arrastrable.
   *
   * Origen (disco), angulo (tirador sobre el eje) y numero de sectores
   * (tirador perpendicular). Se dibuja en pantalla, no en mundo, para que su
   * tamano no dependa del zoom y siga siendo agarrable siempre.
   */
  private drawSymmetry(ctx: CanvasRenderingContext2D, state: OverlayState, camera: Camera): void {
    const s = state.symmetry;
    const o = camera.worldToScreen({ x: s.x, y: s.y });
    const ang = s.angle + camera.rotation;
    const active = state.activeHandle;
    const hover = state.hoverHandle;
    const colorOf = (h: SymmetryHandle): string =>
      active === h ? HOT : hover === h ? "#ffffff" : ACCENT;

    const diag = Math.hypot(camera.width, camera.height);

    ctx.save();
    ctx.globalAlpha = s.locked ? 0.45 : 1;

    // Ejes de simetria proyectados a lo largo del viewport.
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = "rgba(79,140,255,0.75)";
    const lines = s.mode === "mirror" ? 1 : Math.max(1, Math.round(s.count));
    for (let i = 0; i < lines; i++) {
      const a = ang + (Math.PI * i) / lines;
      ctx.beginPath();
      ctx.moveTo(o.x - Math.cos(a) * diag, o.y - Math.sin(a) * diag);
      ctx.lineTo(o.x + Math.cos(a) * diag, o.y + Math.sin(a) * diag);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Tirador de angulo.
    const hx = o.x + Math.cos(ang) * GIZMO.axisRadius;
    const hy = o.y + Math.sin(ang) * GIZMO.axisRadius;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(hx, hy);
    ctx.strokeStyle = colorOf("axis");
    ctx.lineWidth = 2;
    ctx.stroke();
    dot(ctx, hx, hy, 7, colorOf("axis"));

    // Tirador de sectores.
    if (s.mode === "radial" || s.mode === "kaleido") {
      const ca = ang + Math.PI / 2;
      const cx = o.x + Math.cos(ca) * GIZMO.countRadius;
      const cy = o.y + Math.sin(ca) * GIZMO.countRadius;
      ctx.beginPath();
      ctx.arc(o.x, o.y, GIZMO.countRadius, ca - 0.5, ca + 0.5);
      ctx.strokeStyle = colorOf("count");
      ctx.lineWidth = 2;
      ctx.stroke();
      dot(ctx, cx, cy, 7, colorOf("count"));
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#e8ecf6";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(Math.round(s.count)), cx, cy - 15);
    }

    // Origen.
    ctx.beginPath();
    ctx.arc(o.x, o.y, GIZMO.originRadius, 0, TAU);
    ctx.fillStyle = "rgba(14,18,28,0.55)";
    ctx.fill();
    ctx.strokeStyle = colorOf("origin");
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(o.x, o.y, 2.5, 0, TAU);
    ctx.fillStyle = colorOf("origin");
    ctx.fill();

    ctx.restore();
  }
}

function dot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(10,12,18,0.7)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
