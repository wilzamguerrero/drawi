import { uid } from "../core/rng";
import { multiply, type Mat2d } from "../core/mat2d";
import { polygonBounds } from "../stroke/outline";
import type { Polygon } from "../stroke/types";
import { boundingRadius, DEFAULT_SHAPE, type ShapeDef } from "../physics/shapes";
import { createBody, PhysicsWorld, type Body, type WorldSettings } from "../physics/world";
import { DEFAULT_SYMMETRY, symmetryTransforms, type SymmetryState } from "../symmetry/symmetry";
import { DEFAULT_FIELD_STYLE, type FieldStyle } from "../render/field-gl";
import { EMPTY_RECT, unionRect, type InkItem, type Rect } from "./types";

export interface DocumentMeta {
  name: string;
  background: string;
  createdAt: number;
}

/** Instantanea serializable de un cuerpo (lo que guarda el historial). */
export interface BodySnapshot {
  id: string;
  shape: ShapeDef;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  av: number;
  color: string;
  group: number;
  blend: number;
  isStatic: boolean;
  density: number;
  restitution: number;
  friction: number;
}

export interface SceneSnapshot {
  items: InkItem[];
  bodies: BodySnapshot[];
  symmetry: SymmetryState;
  world: WorldSettings;
  field: FieldStyle;
  background: string;
}

const cloneSymmetry = (s: SymmetryState): SymmetryState => ({ ...s });
const cloneWorld = (w: WorldSettings): WorldSettings => ({ ...w, gravity: { ...w.gravity } });

export function snapshotBody(b: Body): BodySnapshot {
  return {
    id: b.id,
    shape: { ...b.shape },
    x: b.pos.x,
    y: b.pos.y,
    angle: b.angle,
    vx: b.vel.x,
    vy: b.vel.y,
    av: b.angVel,
    color: b.color,
    group: b.group,
    blend: b.blend,
    isStatic: b.isStatic,
    density: b.density,
    restitution: b.restitution,
    friction: b.friction,
  };
}

export function restoreBody(s: BodySnapshot): Body {
  const body = createBody({ ...s.shape }, { x: s.x, y: s.y }, {
    angle: s.angle,
    color: s.color,
    group: s.group,
    blend: s.blend,
    isStatic: s.isStatic,
    density: s.density,
    restitution: s.restitution,
    friction: s.friction,
  });
  body.id = s.id;
  body.vel.x = s.vx;
  body.vel.y = s.vy;
  body.angVel = s.av;
  return body;
}

/**
 * Documento: tinta + materia.
 *
 * La tinta es una lista plana de `InkItem` inmutables (cada trazo se guarda
 * con sus transformaciones de simetria ya congeladas). La materia vive en el
 * mundo fisico y se mueve sola. El historial fotografia ambas: la tinta se
 * comparte por referencia (nunca se muta un item) y de los cuerpos se guarda
 * un snapshot plano, que es barato y exacto.
 */
export class SceneDocument {
  meta: DocumentMeta = {
    name: "Sin titulo",
    background: "#f4f1ea",
    createdAt: Date.now(),
  };

  items: InkItem[] = [];
  readonly physics = new PhysicsWorld();
  symmetry: SymmetryState = cloneSymmetry(DEFAULT_SYMMETRY);
  field: FieldStyle = { ...DEFAULT_FIELD_STYLE };
  shape: ShapeDef = { ...DEFAULT_SHAPE };

  /** Cambia con cada modificacion; los renderizadores lo usan como cache key. */
  inkRevision = 0;

  get bodies(): Body[] {
    return this.physics.bodies;
  }

  get isEmpty(): boolean {
    return this.items.length === 0 && this.physics.bodies.length === 0;
  }

  addItem(item: InkItem): InkItem {
    this.items.push(item);
    this.inkRevision++;
    return item;
  }

  removeItem(id: string): void {
    const i = this.items.findIndex((it) => it.id === id);
    if (i >= 0) {
      this.items.splice(i, 1);
      this.inkRevision++;
    }
  }

  clearInk(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.inkRevision++;
  }

  clearMatter(): void {
    this.physics.clear();
  }

  clearAll(): void {
    this.clearInk();
    this.clearMatter();
  }

  /** Crea el item de tinta de un trazo aplicando la simetria vigente. */
  buildItem(
    polys: Polygon[],
    color: string,
    opacity: number,
    smooth: boolean,
    gradient: boolean,
    extraTransform?: Mat2d,
  ): InkItem | null {
    if (polys.length === 0) return null;
    let base = symmetryTransforms(this.symmetry);
    if (extraTransform) base = base.map((m) => multiply(m, extraTransform));

    let bounds: Rect | null = null;
    for (const poly of polys) {
      if (poly.length < 3) continue;
      const b = polygonBounds(poly);
      for (const m of base) {
        bounds = unionRect(bounds, transformRect(b, m));
      }
    }
    if (!bounds) return null;

    return {
      id: uid(),
      polys,
      transforms: base,
      color,
      opacity,
      smooth,
      gradient,
      gy0: bounds.y,
      gy1: bounds.y + bounds.h,
      bounds,
    };
  }

  /** Caja de todo lo dibujado, tinta y materia. */
  contentBounds(): Rect {
    let r: Rect | null = null;
    for (const item of this.items) r = unionRect(r, item.bounds);
    for (const b of this.physics.bodies) {
      const rad = boundingRadius(b.shape) + b.blend;
      r = unionRect(r, { x: b.pos.x - rad, y: b.pos.y - rad, w: rad * 2, h: rad * 2 });
    }
    return r ?? { ...EMPTY_RECT };
  }

  snapshot(): SceneSnapshot {
    return {
      items: this.items.slice(),
      bodies: this.physics.bodies.map(snapshotBody),
      symmetry: cloneSymmetry(this.symmetry),
      world: cloneWorld(this.physics.settings),
      field: { ...this.field },
      background: this.meta.background,
    };
  }

  restore(snap: SceneSnapshot): void {
    this.items = snap.items.slice();
    this.symmetry = cloneSymmetry(snap.symmetry);
    this.physics.settings = cloneWorld(snap.world);
    this.field = { ...snap.field };
    this.meta.background = snap.background;
    this.physics.clear();
    for (const b of snap.bodies) this.physics.add(restoreBody(b));
    this.inkRevision++;
  }
}

/** Caja envolvente de un rect transformado (se transforman las 4 esquinas). */
export function transformRect(r: Rect, m: Mat2d): Rect {
  const xs = [r.x, r.x + r.w, r.x, r.x + r.w];
  const ys = [r.y, r.y, r.y + r.h, r.y + r.h];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const x = m.a * xs[i] + m.c * ys[i] + m.e;
    const y = m.b * xs[i] + m.d * ys[i] + m.f;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
