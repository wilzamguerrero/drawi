import type { Vec2 } from "../core/vec2";
import type { InputSample } from "../input/pointer";
import { boundingRadius } from "../physics/shapes";
import { createBody, syncTransform, type Body } from "../physics/world";
import type { MatterOp } from "../app/editor";
import type { Tool, ToolContext } from "./types";

/**
 * Materia: agarrar, lanzar, borrar y transformar (mover/rotar/escalar/pivote).
 *
 * El arrastre no teletransporta el cuerpo: el solver lo lleva con un muelle,
 * asi choca con lo que encuentra por el camino y el resto del monton reacciona.
 * Para rotar/escalar se mueven todas las piezas del mismo trazo en torno a su
 * pivote, sin pasar por el muelle del arrastre.
 *
 * El pivote de cada trazo vive en espacio LOCAL del cuerpo (strokePivotX/Y):
 * rotar alrededor de el lo deja clavado, escalar multiplica su distancia y la
 * fisica lo arrastra con la pieza, sin que haya que reajustarlo nunca. La
 * operacion Pivote lo coloca a mano: arrastra el punto de giro/escala a donde
 * quieras y sigue siendo coherente con cualquier transformacion posterior.
 */
export class MatterTool implements Tool {
  readonly id = "matter" as const;
  readonly cursor = "grab";
  readonly showCursorRing = false;

  private selected: Body[] = [];
  private startPos = new Map<string, Vec2>();
  private startAngles = new Map<string, number>();
  private startSizes = new Map<string, number>();
  private startWorldPos: Vec2 = { x: 0, y: 0 };
  private pivot: Vec2 = { x: 0, y: 0 };
  private moved = false;
  private erasing = false;
  private dragging = false;

  onDown(ctx: ToolContext, s: InputSample): void {
    const w = ctx.toWorld(s);
    const body = ctx.doc.physics.pick(w.x, w.y, 6);
    if (!body) {
      this.selected = [];
      return;
    }
    ctx.history.begin();
    this.moved = false;
    this.dragging = false;
    this.startWorldPos = { x: w.x, y: w.y };

    if (s.eraser || s.barrel) {
      this.erasing = true;
      ctx.doc.physics.remove(body.id);
      ctx.setHighlight(null);
      ctx.invalidateField();
      ctx.history.commit("Borrar materia");
      return;
    }

    this.selected = this.selectGroup(ctx, body);
    this.startPos.clear();
    this.startAngles.clear();
    this.startSizes.clear();
    for (const b of this.selected) {
      this.startPos.set(b.id, { x: b.pos.x, y: b.pos.y });
      this.startAngles.set(b.id, b.angle);
      this.startSizes.set(b.id, b.shape.size);
    }
    this.pivot = this.groupPivot(this.selected);
    ctx.setPivot(this.pivot);
    this.dragging = true;
    ctx.setHighlight(body);
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    const last = samples[samples.length - 1];
    const w = ctx.toWorld(last);

    if (this.erasing) {
      const body = ctx.doc.physics.pick(w.x, w.y, 6);
      if (body) {
        ctx.doc.physics.remove(body.id);
        ctx.invalidateField();
      }
      return;
    }

    if (!this.dragging || this.selected.length === 0) {
      ctx.setHighlight(ctx.doc.physics.pick(w.x, w.y, 6));
      return;
    }

    this.moved = true;
    const op = ctx.matterOp;
    if (op === "pivot") {
      this.placePivot(ctx, w.x, w.y);
    } else if (op === "rotate" || op === "scale") {
      this.transformAroundPivot(w.x, w.y, op);
    } else {
      // mover: desplazamiento delta desde el inicio del gesto
      const dx = w.x - this.startWorldPos.x;
      const dy = w.y - this.startWorldPos.y;
      for (const b of this.selected) {
        const start = this.startPos.get(b.id)!;
        b.pos.x = start.x + dx;
        b.pos.y = start.y + dy;
        syncTransform(b);
      }
    }
    ctx.invalidateField();
  }

  onUp(ctx: ToolContext): void {
    if (this.erasing) {
      this.erasing = false;
      return;
    }
    if (!this.dragging || this.selected.length === 0) return;
    this.dragging = false;
    ctx.doc.physics.wakeAll();
    const label = this.opLabel(ctx.matterOp);
    if (this.moved) ctx.history.commit(label);
    else ctx.history.abort();
    this.selected = [];
    ctx.setPivot(null);
  }

  onCancel(ctx: ToolContext): void {
    for (const b of this.selected) {
      const start = this.startPos.get(b.id);
      const angle = this.startAngles.get(b.id);
      if (start) { b.pos.x = start.x; b.pos.y = start.y; }
      if (angle !== undefined) b.angle = angle;
      if (start || angle !== undefined) syncTransform(b);
    }
    this.selected = [];
    this.erasing = false;
    this.dragging = false;
    ctx.setPivot(null);
    ctx.history.abort();
    ctx.invalidateField();
  }

  onHover(ctx: ToolContext, s: InputSample | null): void {
    if (!s) {
      ctx.setHighlight(null);
      if (ctx.matterOp === "pivot") ctx.setPivot(null);
      return;
    }
    const w = ctx.toWorld(s);
    const body = ctx.doc.physics.pick(w.x, w.y, 6);
    ctx.setHighlight(body);
    // En modo Pivote se enseña dónde está el pivote del trazo bajo el cursor,
    // para poder apuntar el arrastre antes de agarrarlo.
    if (ctx.matterOp === "pivot") {
      ctx.setPivot(body ? this.groupPivot(this.selectGroup(ctx, body)) : null);
    }
  }

  private selectGroup(ctx: ToolContext, body: Body): Body[] {
    if (!body.strokeId) return [body];
    return ctx.doc.bodies.filter((b) => b.strokeId === body.strokeId);
  }

  /** Pivote del grupo en mundo: el local de la primera pieza, girado con ella. */
  private groupPivot(bodies: Body[]): Vec2 {
    if (bodies.length === 0) return { x: 0, y: 0 };
    const first = bodies[0];
    if (first.strokePivotX !== undefined && first.strokePivotY !== undefined) {
      const c = Math.cos(first.angle);
      const s = Math.sin(first.angle);
      return {
        x: first.pos.x + first.strokePivotX * c - first.strokePivotY * s,
        y: first.pos.y + first.strokePivotX * s + first.strokePivotY * c,
      };
    }
    let x = 0, y = 0;
    for (const b of bodies) { x += b.pos.x; y += b.pos.y; }
    return { x: x / bodies.length, y: y / bodies.length };
  }

  /**
   * Coloca el pivote del grupo en un punto de mundo: cada pieza lo guarda en
   * SU espacio local, de modo que rotaciones, escalados y la propia fisica lo
   * mantengan clavado al mismo punto de la forma.
   */
  private placePivot(ctx: ToolContext, x: number, y: number): void {
    this.pivot = { x, y };
    for (const b of this.selected) {
      const dx = x - b.pos.x;
      const dy = y - b.pos.y;
      const c = Math.cos(-b.angle);
      const s = Math.sin(-b.angle);
      b.strokePivotX = dx * c - dy * s;
      b.strokePivotY = dx * s + dy * c;
    }
    ctx.setPivot(this.pivot);
  }

  private transformAroundPivot(x: number, y: number, op: MatterOp): void {
    const dx0 = this.startWorldPos.x - this.pivot.x;
    const dy0 = this.startWorldPos.y - this.pivot.y;
    const dx1 = x - this.pivot.x;
    const dy1 = y - this.pivot.y;
    const a0 = Math.atan2(dy0, dx0);
    const a1 = Math.atan2(dy1, dx1);
    const dAngle = a1 - a0;
    const r0 = Math.hypot(dx0, dy0);
    const r1 = Math.hypot(dx1, dy1);
    const scale = op === "scale" && r0 > 1e-6 ? r1 / r0 : 1;
    const c = Math.cos(dAngle);
    const s = Math.sin(dAngle);

    for (const b of this.selected) {
      const sp = this.startPos.get(b.id)!;
      const sx = sp.x - this.pivot.x;
      const sy = sp.y - this.pivot.y;
      const rx = sx * c - sy * s;
      const ry = sx * s + sy * c;
      b.pos.x = this.pivot.x + rx * scale;
      b.pos.y = this.pivot.y + ry * scale;
      const sa = this.startAngles.get(b.id) ?? b.angle;
      b.angle = sa + dAngle;

      if (op === "scale") {
        const startSize = this.startSizes.get(b.id) ?? b.shape.size;
        rebuildShape(b, startSize * scale);
        // El pivote local se escala con la pieza: el punto de mundo al que
        // apunta sigue siendo el mismo tras agrandar o encoger.
        if (b.strokePivotX !== undefined) b.strokePivotX *= scale;
        if (b.strokePivotY !== undefined) b.strokePivotY *= scale;
      }
      syncTransform(b);
    }
  }

  private opLabel(op: MatterOp): string {
    switch (op) {
      case "rotate":
        return "Rotar materia";
      case "scale":
        return "Escalar materia";
      case "pivot":
        return "Mover pivote";
      default:
        return "Mover materia";
    }
  }
}

/**
 * Reconstruye la forma y masa de un cuerpo tras escalar. No toca la identidad
 * del trazo (strokeId/indice/pivote): son campos del cuerpo, no de la forma.
 */
function rebuildShape(body: Body, newSize: number): void {
  const shape = { ...body.shape, size: Math.max(1, newSize) };
  const fresh = createBody(shape, body.pos, {
    angle: body.angle,
    color: body.color,
    group: body.group,
    isStatic: body.isStatic,
    density: body.density,
    restitution: body.restitution,
    friction: body.friction,
    blend: body.blend,
    bridgeReach: body.bridgeReach,
    layerId: body.layerId,
  });
  body.local = fresh.local;
  body.world = fresh.world;
  body.normals = fresh.normals;
  body.radius = boundingRadius(shape);
  body.shape = shape;
  body.mass = fresh.mass;
  body.invMass = body.isStatic ? 0 : fresh.invMass;
  body.inertia = fresh.inertia;
  body.invInertia = body.isStatic ? 0 : fresh.invInertia;
  body.awake = true;
  body.sleepTimer = 0;
}
