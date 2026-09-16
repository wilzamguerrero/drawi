import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from "../core/color";
import { clamp } from "../core/math";
import type { InputSample } from "../input/pointer";
import { createBody, setBodyStatic, syncTransform, type Body } from "../physics/world";
import { boundingRadius } from "../physics/shapes";
import { symmetryTransforms } from "../symmetry/symmetry";
import { apply } from "../core/mat2d";
import type { Tool, ToolContext } from "./types";

/**
 * Herramienta de forma: siembra materia.
 *
 * Al pulsar se crea un cuerpo con la forma activa; arrastrar lo dimensiona y
 * lo gira antes de soltarlo. Si la simetria esta activa, se siembra una copia
 * por cada eje, de modo que la materia hereda la misma composicion que la
 * tinta. Al soltarlo entra en el solver y empieza a fundirse con sus vecinos.
 */
export class ShapeTool implements Tool {
  readonly id = "shape" as const;
  readonly cursor = "crosshair";
  readonly showCursorRing = false;

  private spawned: Body[] = [];
  private cx = 0;
  private cy = 0;
  private baseSize = 0;

  onDown(ctx: ToolContext, s: InputSample): void {
    const w = ctx.toWorld(s);
    ctx.history.begin();
    this.cx = w.x;
    this.cy = w.y;
    this.baseSize = ctx.doc.shape.size;
    this.spawned = [];

    const transforms = symmetryTransforms(ctx.doc.symmetry);
    for (let i = 0; i < transforms.length; i++) {
      const p = apply(transforms[i], { x: w.x, y: w.y });
      const body = createBody({ ...ctx.doc.shape }, { x: p.x, y: p.y }, {
        color: i === 0 ? ctx.color : tintFor(ctx.color, i),
        blend: ctx.doc.field.blend,
        restitution: ctx.doc.physics.settings.restitution,
        friction: ctx.doc.physics.settings.friction,
      });
      // Mientras se dimensiona no debe caer.
      setBodyStatic(body, true);
      ctx.doc.physics.add(body);
      this.spawned.push(body);
    }
    ctx.invalidateField();
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    if (this.spawned.length === 0) return;
    const w = ctx.toWorld(samples[samples.length - 1]);
    const dx = w.x - this.cx;
    const dy = w.y - this.cy;
    const d = Math.hypot(dx, dy);
    if (d < 2) return;

    const size = clamp(Math.max(this.baseSize, d), 4, 4000);
    const angle = Math.atan2(dy, dx);
    for (const body of this.spawned) {
      body.shape = { ...body.shape, size };
      body.angle = angle;
      body.radius = boundingRadius(body.shape);
      rebuild(body);
    }
    ctx.invalidateField();
    ctx.status(`Tamano ${Math.round(size)}`);
  }

  onUp(ctx: ToolContext): void {
    if (this.spawned.length === 0) {
      ctx.history.abort();
      return;
    }
    for (const body of this.spawned) {
      rebuild(body);
      setBodyStatic(body, false);
    }
    ctx.doc.physics.wakeAll();
    const n = this.spawned.length;
    this.spawned = [];
    ctx.history.commit(n > 1 ? `Sembrar ${n} formas` : "Sembrar forma");
    ctx.invalidateField();
  }

  onCancel(ctx: ToolContext): void {
    for (const body of this.spawned) ctx.doc.physics.remove(body.id);
    this.spawned = [];
    ctx.history.abort();
    ctx.invalidateField();
  }

  onHover(ctx: ToolContext, s: InputSample | null): void {
    ctx.setPreviewShape(s !== null);
  }
}

/** Recalcula masa y vertices tras cambiar la forma de un cuerpo ya creado. */
function rebuild(body: Body): void {
  const fresh = createBody(body.shape, body.pos, {
    angle: body.angle,
    color: body.color,
    group: body.group,
    isStatic: body.isStatic,
    density: body.density,
    restitution: body.restitution,
    friction: body.friction,
    blend: body.blend,
  });
  body.local = fresh.local;
  body.world = fresh.world;
  body.normals = fresh.normals;
  body.radius = fresh.radius;
  body.mass = fresh.mass;
  body.invMass = body.isStatic ? 0 : fresh.invMass;
  body.inertia = fresh.inertia;
  body.invInertia = body.isStatic ? 0 : fresh.invInertia;
  body.awake = true;
  body.sleepTimer = 0;
  syncTransform(body);
}

/** Variacion sutil de tono para distinguir las copias simetricas. */
function tintFor(hex: string, index: number): string {
  const hsv = rgbToHsv(hexToRgb(hex));
  hsv.h = (hsv.h + index * 11) % 360;
  hsv.s = clamp(hsv.s * (1 - index * 0.02), 0, 1);
  return rgbToHex(hsvToRgb(hsv));
}
