import { clamp, TAU } from "../core/math";
import type { Vec2 } from "../core/vec2";

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  rotation: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 64;

/**
 * Camara 2D con paneo, zoom y rotacion.
 * (x, y) es el punto de mundo que queda en el centro del viewport.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  rotation = 0;
  width = 1;
  height = 1;

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  get state(): CameraState {
    return { x: this.x, y: this.y, zoom: this.zoom, rotation: this.rotation };
  }

  set state(s: CameraState) {
    this.x = s.x;
    this.y = s.y;
    this.zoom = s.zoom;
    this.rotation = s.rotation;
  }

  worldToScreen(p: Vec2, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    const dx = p.x - this.x;
    const dy = p.y - this.y;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    out.x = (dx * c - dy * s) * this.zoom + this.width / 2;
    out.y = (dx * s + dy * c) * this.zoom + this.height / 2;
    return out;
  }

  screenToWorld(sx: number, sy: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    const dx = (sx - this.width / 2) / this.zoom;
    const dy = (sy - this.height / 2) / this.zoom;
    const c = Math.cos(-this.rotation);
    const s = Math.sin(-this.rotation);
    out.x = dx * c - dy * s + this.x;
    out.y = dx * s + dy * c + this.y;
    return out;
  }

  /** Escala un vector de pantalla a mundo (sin trasladar). */
  screenDeltaToWorld(dx: number, dy: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    const c = Math.cos(-this.rotation);
    const s = Math.sin(-this.rotation);
    const nx = dx / this.zoom;
    const ny = dy / this.zoom;
    out.x = nx * c - ny * s;
    out.y = nx * s + ny * c;
    return out;
  }

  panByScreen(dx: number, dy: number): void {
    const d = this.screenDeltaToWorld(dx, dy);
    this.x -= d.x;
    this.y -= d.y;
  }

  /** Zoom manteniendo fijo el punto de pantalla indicado. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  rotateAt(sx: number, sy: number, delta: number): void {
    const before = this.screenToWorld(sx, sy);
    this.rotation = (this.rotation + delta) % TAU;
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Aplica la transformacion a un contexto 2D ya escalado por dpr. */
  applyTo(ctx: CanvasRenderingContext2D, dpr: number): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.width / 2, this.height / 2);
    ctx.rotate(this.rotation);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.rotation = 0;
  }

  fit(bounds: { x: number; y: number; w: number; h: number }, padding = 0.9): void {
    if (bounds.w <= 0 || bounds.h <= 0) {
      this.reset();
      return;
    }
    this.rotation = 0;
    this.x = bounds.x + bounds.w / 2;
    this.y = bounds.y + bounds.h / 2;
    this.zoom = clamp(
      Math.min(this.width / bounds.w, this.height / bounds.h) * padding,
      MIN_ZOOM,
      MAX_ZOOM,
    );
  }

  /** Rectangulo del mundo visible (envolvente, tiene en cuenta la rotacion). */
  visibleBounds(margin = 0): { x: number; y: number; w: number; h: number } {
    const corners = [
      this.screenToWorld(0, 0),
      this.screenToWorld(this.width, 0),
      this.screenToWorld(this.width, this.height),
      this.screenToWorld(0, this.height),
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }
    return {
      x: minX - margin,
      y: minY - margin,
      w: maxX - minX + margin * 2,
      h: maxY - minY + margin * 2,
    };
  }
}
