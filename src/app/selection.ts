import type { Vec2 } from "../core/vec2";
import type { Rect } from "../scene/types";
import type { SceneDocument } from "../scene/document";

export class Selection {
  inkIds = new Set<string>();
  imageIds = new Set<string>();
  bodyIds = new Set<string>();
  customPivot: Vec2 | null = null;

  clear(): void {
    this.inkIds.clear();
    this.imageIds.clear();
    this.bodyIds.clear();
    this.customPivot = null;
  }
  get empty(): boolean {
    return this.inkIds.size === 0 && this.imageIds.size === 0 && this.bodyIds.size === 0;
  }
  get count(): number { return this.inkIds.size + this.imageIds.size + this.bodyIds.size; }

  hasInk(id: string): boolean { return this.inkIds.has(id); }
  hasImage(id: string): boolean { return this.imageIds.has(id); }
  hasBody(id: string): boolean { return this.bodyIds.has(id); }

  bounds(doc: SceneDocument): Rect | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    // Ink items: use tight world polygon bounds from transforms, not stale AABB
    for (const id of this.inkIds) {
      const it = doc.items.find((i) => i.id === id);
      if (!it) continue;
      if (it.polys.length === 0 || it.transforms.length === 0) {
        const b = it.bounds;
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
      } else {
        for (const m of it.transforms) {
          for (const poly of it.polys) {
            for (const p of poly) {
              const wx = m.a * p.x + m.c * p.y + m.e;
              const wy = m.b * p.x + m.d * p.y + m.f;
              minX = Math.min(minX, wx); minY = Math.min(minY, wy);
              maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy);
            }
          }
        }
      }
      any = true;
    }
    for (const id of this.imageIds) {
      const l = doc.layerById(id);
      if (!l || l.kind !== "image") continue;
      const x = l.imageX ?? 0, y = l.imageY ?? 0, w = l.imageW ?? 0, h = l.imageH ?? 0;
      const ang = l.imageAngle ?? 0;
      if (Math.abs(ang) < 1e-6) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      } else {
        const cx = x + w / 2, cy = y + h / 2;
        const c = Math.cos(ang), s = Math.sin(ang);
        const pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
        for (const p of pts) {
          const rx = cx + (p.x - cx) * c - (p.y - cy) * s;
          const ry = cy + (p.x - cx) * s + (p.y - cy) * c;
          minX = Math.min(minX, rx); minY = Math.min(minY, ry);
          maxX = Math.max(maxX, rx); maxY = Math.max(maxY, ry);
        }
      }
      any = true;
    }
    for (const id of this.bodyIds) {
      const b = doc.physics.bodies.find((bb) => bb.id === id);
      if (!b) continue;
      if (!b.world || b.world.length === 0) {
        minX = Math.min(minX, b.pos.x - b.radius); minY = Math.min(minY, b.pos.y - b.radius);
        maxX = Math.max(maxX, b.pos.x + b.radius); maxY = Math.max(maxY, b.pos.y + b.radius);
      } else {
        for (const p of b.world) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
      }
      any = true;
    }
    if (!any) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  pivot(doc: SceneDocument): Vec2 | null {
    if (this.customPivot) return { ...this.customPivot };
    const b = this.bounds(doc);
    if (!b) return null;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  isLocked(doc: SceneDocument): boolean {
    for (const id of this.inkIds) {
      const it = doc.items.find((i) => i.id === id);
      if (it && doc.layerById(it.layerId)?.locked) return true;
    }
    for (const id of this.imageIds) if (doc.layerById(id)?.locked) return true;
    for (const id of this.bodyIds) {
      const b = doc.physics.bodies.find((bb) => bb.id === id);
      if (b && doc.layerById(b.layerId)?.locked) return true;
    }
    return false;
  }
}
