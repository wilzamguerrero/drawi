import type { InputSample } from "../input/pointer";
import { syncTransform } from "../physics/world";
import type { Vec2 } from "../core/vec2";
import type { Rect } from "../scene/types";
import type { Tool, ToolContext } from "./types";

type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate" | "pivot";

function pointInPoly(poly: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pointInImageWorld(px: number, py: number, x: number, y: number, w: number, h: number, ang: number): boolean {
  const cx = x + w / 2, cy = y + h / 2;
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const dx = px - cx, dy = py - cy;
  const rx = dx * c - dy * s + cx, ry = dx * s + dy * c + cy;
  return rx >= x && rx <= x + w && ry >= y && ry <= y + h;
}
function hitTestInk(ctx: ToolContext, x: number, y: number): string | null {
  for (let i = ctx.doc.items.length - 1; i >= 0; i--) {
    const it = ctx.doc.items[i];
    if (ctx.doc.layerById(it.layerId)?.locked) continue;
    const b = it.bounds;
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    let hit = false;
    for (const m of it.transforms as unknown as { a: number; b: number; c: number; d: number; e: number; f: number }[]) {
      for (const poly of it.polys) {
        const wp = poly.map((p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }));
        if (pointInPoly(wp, x, y)) { hit = true; break; }
      }
      if (hit) break;
    }
    if (hit) return it.id;
  }
  return null;
}

export class SelectTool implements Tool {
  readonly id = "select" as const;
  readonly cursor = "default";
  readonly showCursorRing = false;
  // how many transforms the selected ink items had at snapshot time; used to detect symmetry clones mismatch
  private startTransformLen = new Map<string, number>();

  private dragging = false;
  private handle: Handle | null = null;
  private startW: Vec2 = { x: 0, y: 0 };
  private startBounds: Rect | null = null;
  private startPivot: Vec2 | null = null;
  private marqueeStart: Vec2 | null = null;
  private marqueeEnd: Vec2 | null = null;
  private startInk = new Map<string, Rect>();
  private startImage = new Map<string, { x: number; y: number; w: number; h: number; angle: number }>();
  private startBodyPos = new Map<string, Vec2>();
  private startBodyAngle = new Map<string, number>();

  private getSel(ctx: ToolContext): import("../app/selection").Selection {
    const ed = (globalThis as unknown as { __drawiEditor?: import("../app/editor").Editor }).__drawiEditor;
    if (ed) return ed.selection;
    return (ctx as unknown as { selection: import("../app/selection").Selection }).selection;
  }

  private pickHandle(ctx: ToolContext, wx: number, wy: number): Handle | null {
    const sel = this.getSel(ctx);
    const ed = (globalThis as unknown as { __drawiEditor?: import("../app/editor").Editor }).__drawiEditor;
    const b = sel.bounds(ctx.doc as unknown as never);
    if (!b) return null;
    const pivot = sel.pivot(ctx.doc as unknown as never);
    const zoom = ctx.camera.zoom;
    const tol = 11 / Math.max(zoom, 0.1);
    if (pivot && Math.hypot(wx - pivot.x, wy - pivot.y) < tol) {
      const op = (ed as unknown as { selectOp?: string })?.selectOp ?? (ctx as unknown as { selectOp?: string }).selectOp;
      if (op === "pivot") return "pivot";
    }
    const op = (ed as unknown as { selectOp?: string })?.selectOp ?? (ctx as unknown as { selectOp?: string }).selectOp ?? "move";
    if (op === "rotate") return "rotate";
    if (op === "pivot") return "pivot";
    if (op === "scale") {
      const { x, y, w, h } = b;
      const pts: Record<string, Vec2> = {
        nw: { x, y }, n: { x: x + w / 2, y }, ne: { x: x + w, y },
        e: { x: x + w, y: y + h / 2 }, se: { x: x + w, y: y + h }, s: { x: x + w / 2, y: y + h },
        sw: { x, y: y + h }, w: { x, y: y + h / 2 },
      };
      for (const k of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]) {
        const p = pts[k]; if (Math.hypot(wx - p.x, wy - p.y) < tol) return k;
      }
    }
    if (wx >= b.x - tol && wx <= b.x + b.w + tol && wy >= b.y - tol && wy <= b.y + b.h + tol) return "move";
    return null;
  }

  onDown(ctx: ToolContext, s: InputSample): void {
    const w = ctx.toWorld(s);
    const sel = this.getSel(ctx);
    const ed = (globalThis as unknown as { __drawiEditor?: import("../app/editor").Editor }).__drawiEditor;
    const isShift = !!(s as unknown as { shiftKey?: boolean }).shiftKey;

    const h = !sel.empty ? this.pickHandle(ctx, w.x, w.y) : null;
    if (h && !sel.empty) {
      if (sel.isLocked(ctx.doc as unknown as never)) { ctx.status("Capa bloqueada"); return; }
      ctx.history.begin();
      this.handle = h; this.dragging = true;
      this.startW = { ...w };
      this.startBounds = sel.bounds(ctx.doc as unknown as never);
      this.startPivot = sel.pivot(ctx.doc as unknown as never);
      this.snapshotStart(ctx);
      return;
    }

    const body = ctx.doc.physics.pick(w.x, w.y, 6);
    if (body && !ctx.doc.layerById(body.layerId)?.locked) {
      const already = sel.hasBody(body.id);
      if (!already && !isShift) sel.clear();
      const group = body.strokeId ? ctx.doc.bodies.filter((b) => b.strokeId === body.strokeId) : [body];
      for (const b of group) if (!already || !isShift) sel.bodyIds.add(b.id); else sel.bodyIds.delete(b.id);
      if (already && isShift) { /* toggled */ } else if (!already) { /* added */ }
      if (already && isShift && group.length > 0 && sel.hasBody(group[0].id)) { /* kept */ }
      // Normalize toggle: if was already selected and shift, remove; else add
      // (handled above; ensure no duplicate)
      this.afterSelect(ctx); return;
    }

    // Image hit topmost
    let imgHit: import("../scene/layer").SceneLayer | null = null;
    for (let i = ctx.doc.layers.length - 1; i >= 0; i--) {
      const l = ctx.doc.layers[i];
      if (l.kind !== "image" || !l.imageSrc || l.locked) continue;
      if (pointInImageWorld(w.x, w.y, l.imageX ?? 0, l.imageY ?? 0, l.imageW ?? 0, l.imageH ?? 0, l.imageAngle ?? 0)) { imgHit = l; break; }
    }
    if (imgHit) {
      const already = sel.hasImage(imgHit.id);
      if (!already && !isShift) sel.clear();
      if (already && isShift) sel.imageIds.delete(imgHit.id); else sel.imageIds.add(imgHit.id);
      this.afterSelect(ctx); return;
    }

    const inkId = hitTestInk(ctx, w.x, w.y);
    if (inkId) {
      const already = sel.hasInk(inkId);
      if (!already && !isShift) sel.clear();
      if (already && isShift) sel.inkIds.delete(inkId); else sel.inkIds.add(inkId);
      this.afterSelect(ctx); return;
    }

    // Marquee from empty or additive
    if (!isShift) sel.clear();
    ctx.history.begin();
    this.marqueeStart = { ...w }; this.marqueeEnd = { ...w };
    this.dragging = true; this.handle = null;
    this.afterSelect(ctx);
    void ed;
  }

  onMove(ctx: ToolContext, samples: InputSample[]): void {
    const sel = this.getSel(ctx);
    const w = ctx.toWorld(samples[samples.length - 1]);

    if (this.marqueeStart) {
      this.marqueeEnd = { ...w };
      const a = this.marqueeStart, b = this.marqueeEnd;
      const r: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
      this.selectInRect(ctx, r);
      ctx.invalidateOverlay(); return;
    }
    if (!this.dragging || !this.handle || !this.startBounds || !this.startPivot) {
      ctx.setPivot(sel.pivot(ctx.doc as unknown as never));
      return;
    }
    if (sel.isLocked(ctx.doc as unknown as never)) return;
    const ed = (globalThis as unknown as { __drawiEditor?: import("../app/editor").Editor }).__drawiEditor;
    const keepAspect = !!(ed?.keepAspect ?? (ctx as unknown as { keepAspect?: boolean }).keepAspect);

    if (this.handle === "pivot") {
      sel.customPivot = { x: w.x, y: w.y };
      ctx.setPivot(sel.customPivot); ctx.invalidateOverlay(); return;
    }
    if (this.handle === "move") {
      const dx = w.x - this.startW.x, dy = w.y - this.startW.y;
      this.applyMove(ctx, dx, dy); ctx.invalidateOverlay(); return;
    }
    if (this.handle === "rotate") {
      const p = this.startPivot!;
      const a0 = Math.atan2(this.startW.y - p.y, this.startW.x - p.x);
      const a1 = Math.atan2(w.y - p.y, w.x - p.x);
      this.applyRotate(ctx, p, a1 - a0); ctx.invalidateOverlay(); return;
    }
    const b = this.startBounds, p = this.startPivot!;
    let sx = 1, sy = 1;
    const dx = w.x - this.startW.x, dy = w.y - this.startW.y;
    // derive scale from handle direction
    if (this.handle.includes("e")) sx = (b.w + dx) / Math.max(1, b.w);
    if (this.handle.includes("w")) sx = (b.w - dx) / Math.max(1, b.w);
    if (this.handle.includes("s")) sy = (b.h + dy) / Math.max(1, b.h);
    if (this.handle.includes("n")) sy = (b.h - dy) / Math.max(1, b.h);
    if (this.handle === "n" || this.handle === "s") sx = sy;
    if (this.handle === "e" || this.handle === "w") sy = sx;
    if (keepAspect && (this.handle === "nw" || this.handle === "ne" || this.handle === "se" || this.handle === "sw")) {
      const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = s; sy = s;
    }
    this.applyScale(ctx, p, sx, sy);
    ctx.invalidateOverlay();
  }

  onUp(_ctx: ToolContext): void {
    if (this.marqueeStart) {
      const a = this.marqueeStart, b = this.marqueeEnd ?? a;
      const r: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
      if (r.w > 2 && r.h > 2) this.selectInRect(_ctx, r);
      this.marqueeStart = null; this.marqueeEnd = null;
      _ctx.history.abort(); _ctx.invalidateOverlay(); this.afterSelect(_ctx); return;
    }
    if (this.dragging && this.handle) {
      this.dragging = false;
      _ctx.history.commit(this.labelFor(this.handle));
      this.handle = null; this.clearStart(); _ctx.invalidateOverlay(); this.emitState(_ctx); return;
    }
    this.dragging = false; this.handle = null; this.clearStart(); _ctx.invalidateOverlay();
  }

  onCancel(ctx: ToolContext): void {
    if (this.dragging && (this.startBounds || this.marqueeStart)) this.restoreStart(ctx);
    this.dragging = false; this.handle = null; this.marqueeStart = null; this.marqueeEnd = null;
    this.clearStart(); ctx.history.abort(); ctx.invalidateOverlay();
  }

  onHover(ctx: ToolContext): void {
    const sel = this.getSel(ctx);
    if (!sel || sel.empty) { ctx.setHighlight(null); ctx.setPivot(null); return; }
    ctx.setPivot(sel.pivot(ctx.doc as unknown as never));
  }

  private afterSelect(ctx: ToolContext): void {
    ctx.setPivot(null);
    ctx.invalidateOverlay();
    this.emitState(ctx);
  }
  private emitState(ctx: ToolContext): void {
    const ed = (globalThis as unknown as { __drawiEditor?: import("../app/editor").Editor }).__drawiEditor;
    ed?.emitState();
    void ctx;
  }
  private selectInRect(ctx: ToolContext, r: Rect): void {
    const sel = this.getSel(ctx);
    for (const b of ctx.doc.bodies) {
      if (ctx.doc.layerById(b.layerId)?.locked) continue;
      if (b.pos.x >= r.x && b.pos.x <= r.x + r.w && b.pos.y >= r.y && b.pos.y <= r.y + r.h) {
        if (b.strokeId) for (const bb of ctx.doc.bodies) if (bb.strokeId === b.strokeId) sel.bodyIds.add(bb.id);
        else sel.bodyIds.add(b.id);
      }
    }
    for (const l of ctx.doc.layers) {
      if (l.kind !== "image" || l.locked) continue;
      const cx = (l.imageX ?? 0) + (l.imageW ?? 0) / 2, cy = (l.imageY ?? 0) + (l.imageH ?? 0) / 2;
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) sel.imageIds.add(l.id);
    }
    for (const it of ctx.doc.items) {
      if (ctx.doc.layerById(it.layerId)?.locked) continue;
      const cx = it.bounds.x + it.bounds.w / 2, cy = it.bounds.y + it.bounds.h / 2;
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) sel.inkIds.add(it.id);
    }
  }
  private startInkTransforms = new Map<string, { a: number; b: number; c: number; d: number; e: number; f: number }[]>();
  private startInkGy = new Map<string, { gy0: number; gy1: number }>();

  private snapshotStart(ctx: ToolContext): void {
    const sel = this.getSel(ctx);
    this.startInk.clear(); this.startImage.clear(); this.startBodyPos.clear(); this.startBodyAngle.clear();
    this.startInkTransforms.clear(); this.startInkGy.clear(); this.startTransformLen.clear();
    for (const id of sel.inkIds) {
      const it = ctx.doc.items.find((i) => i.id === id);
      if (it) {
        this.startInk.set(id, { ...it.bounds });
        this.startInkTransforms.set(id, it.transforms.map((m) => ({ ...m })));
        this.startTransformLen.set(id, it.transforms.length);
        this.startInkGy.set(id, { gy0: it.gy0, gy1: it.gy1 });
      }
    }
    for (const id of sel.imageIds) {
      const l = ctx.doc.layerById(id);
      if (l) this.startImage.set(id, { x: l.imageX ?? 0, y: l.imageY ?? 0, w: l.imageW ?? 0, h: l.imageH ?? 0, angle: l.imageAngle ?? 0 });
    }
    for (const id of sel.bodyIds) {
      const b = ctx.doc.physics.bodies.find((bb) => bb.id === id);
      if (b) { this.startBodyPos.set(id, { ...b.pos }); this.startBodyAngle.set(id, b.angle); }
    }
  }
  private clearStart(): void { this.startInk.clear(); this.startImage.clear(); this.startBodyPos.clear(); this.startBodyAngle.clear(); this.startInkTransforms.clear(); this.startInkGy.clear(); this.startTransformLen.clear(); this.startBounds = null; this.startPivot = null; }
  private labelFor(h: Handle): string { if (h === "move") return "Mover selección"; if (h === "rotate") return "Rotar selección"; if (h === "pivot") return "Mover pivote"; return "Escalar selección"; }

  private applyMove(ctx: ToolContext, dx: number, dy: number): void {
    const sel = this.getSel(ctx);
    for (const id of sel.inkIds) {
      const it = ctx.doc.items.find((i) => i.id === id); const sb = this.startInk.get(id);
      const sm = this.startInkTransforms.get(id); const sgy = this.startInkGy.get(id);
      if (!it || !sb || !sm || !sgy) continue;
      for (let i = 0; i < it.transforms.length; i++) {
        it.transforms[i].a = sm[i].a; it.transforms[i].b = sm[i].b; it.transforms[i].c = sm[i].c; it.transforms[i].d = sm[i].d;
        it.transforms[i].e = sm[i].e + dx; it.transforms[i].f = sm[i].f + dy;
      }
      it.bounds = { x: sb.x + dx, y: sb.y + dy, w: sb.w, h: sb.h };
      it.gy0 = sgy.gy0 + dy; it.gy1 = sgy.gy1 + dy;
    }
    for (const id of sel.imageIds) { const l = ctx.doc.layerById(id), s = this.startImage.get(id); if (l && s) { l.imageX = s.x + dx; l.imageY = s.y + dy; } }
    for (const id of sel.bodyIds) { const b = ctx.doc.physics.bodies.find((bb) => bb.id === id), sp = this.startBodyPos.get(id); if (b && sp) { b.pos.x = sp.x + dx; b.pos.y = sp.y + dy; syncTransform(b); } }
    if (sel.customPivot && this.startPivot) { sel.customPivot = { x: this.startPivot.x + dx, y: this.startPivot.y + dy }; }
    ctx.doc.inkRevision++; ctx.invalidateInk(); ctx.invalidateField();
  }
  private applyRotate(ctx: ToolContext, pivot: Vec2, dAngle: number): void {
    const sel = this.getSel(ctx);
    const c = Math.cos(dAngle), s = Math.sin(dAngle);
    for (const id of sel.imageIds) {
      const l = ctx.doc.layerById(id), img = this.startImage.get(id);
      if (!l || !img) continue;
      const cx = img.x + img.w / 2, cy = img.y + img.h / 2;
      const rx = pivot.x + (cx - pivot.x) * c - (cy - pivot.y) * s;
      const ry = pivot.y + (cx - pivot.x) * s + (cy - pivot.y) * c;
      l.imageX = rx - img.w / 2; l.imageY = ry - img.h / 2;
      l.imageAngle = (img.angle ?? 0) + dAngle;
    }
    for (const id of sel.bodyIds) {
      const b = ctx.doc.physics.bodies.find((bb) => bb.id === id), sp = this.startBodyPos.get(id), sa = this.startBodyAngle.get(id);
      if (!b || !sp || sa === undefined) continue;
      b.pos.x = pivot.x + (sp.x - pivot.x) * c - (sp.y - pivot.y) * s;
      b.pos.y = pivot.y + (sp.x - pivot.x) * s + (sp.y - pivot.y) * c;
      b.angle = sa + dAngle;
      if (b.strokePivotX !== undefined) { const dx = b.strokePivotX, dy = b.strokePivotY ?? 0; b.strokePivotX = dx * c - dy * s; b.strokePivotY = dx * s + dy * c; }
      syncTransform(b);
    }
    // Ink rotation: rebuild each transform from its START value as R_pivot * T_start
    for (const id of sel.inkIds) {
      const it = ctx.doc.items.find((i) => i.id === id);
      const sm = this.startInkTransforms.get(id);
      if (!it || !sm) continue;
      // Ensure transform count hasn't changed (symmetry clones); if it did, rebuild.
      if (it.transforms.length !== sm.length) {
        it.transforms.length = 0;
        for (const mm of sm) it.transforms.push({ ...mm });
      }
      for (let i = 0; i < sm.length; i++) {
        const m0 = sm[i], m = it.transforms[i];
        // Rotate translation around pivot
        const rx = pivot.x + (m0.e - pivot.x) * c - (m0.f - pivot.y) * s;
        const ry = pivot.y + (m0.e - pivot.x) * s + (m0.f - pivot.y) * c;
        m.e = rx; m.f = ry;
        // Rotate linear part: m_lin = R * m0_lin
        m.a = c * m0.a - s * m0.b;
        m.b = s * m0.a + c * m0.b;
        m.c = c * m0.c - s * m0.d;
        m.d = s * m0.c + c * m0.d;
      }
      // Recompute tight bounds from transforms+polys so the box snaps to the object
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of it.transforms) for (const poly of it.polys) for (const p of poly) {
        const wx = m.a * p.x + m.c * p.y + m.e, wy = m.b * p.x + m.d * p.y + m.f;
        minX = Math.min(minX, wx); minY = Math.min(minY, wy); maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy);
      }
      if (isFinite(minX)) it.bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    ctx.doc.inkRevision++; ctx.invalidateInk(); ctx.invalidateField();
  }
  private applyScale(ctx: ToolContext, pivot: Vec2, sx: number, sy: number): void {
    const sel = this.getSel(ctx);
    sx = Math.max(0.05, Math.min(40, sx)); sy = Math.max(0.05, Math.min(40, sy));
    const sc = (x: number, y: number): Vec2 => ({ x: pivot.x + (x - pivot.x) * sx, y: pivot.y + (y - pivot.y) * sy });
    for (const id of sel.imageIds) {
      const l = ctx.doc.layerById(id), s = this.startImage.get(id);
      if (!l || !s) continue;
      const nw = s.w * sx, nh = s.h * sy;
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const nc = sc(cx, cy);
      l.imageX = nc.x - nw / 2; l.imageY = nc.y - nh / 2;
      l.imageW = nw; l.imageH = nh;
    }
    for (const id of sel.bodyIds) {
      const b = ctx.doc.physics.bodies.find((bb) => bb.id === id), sp = this.startBodyPos.get(id);
      if (!b || !sp) continue;
      const np = sc(sp.x, sp.y); b.pos.x = np.x; b.pos.y = np.y;
      const uni = (sx + sy) / 2;
      const newSize = Math.max(4, (b.shape.size) * uni);
      b.shape = { ...b.shape, size: newSize };
      syncTransform(b);
      if (b.strokePivotX !== undefined) { b.strokePivotX *= uni; if (b.strokePivotY !== undefined) b.strokePivotY *= uni; }
      b.awake = true;
    }
    for (const id of sel.inkIds) {
      const it = ctx.doc.items.find((i) => i.id === id);
      const sm = this.startInkTransforms.get(id);
      if (!it || !sm) continue;
      if (it.transforms.length !== sm.length) { it.transforms.length = 0; for (const mm of sm) it.transforms.push({ ...mm }); }
      // Scale = T(pivot) * S(sx,sy) * T(-pivot)  composed with m0: S_pivot * m0
      // For an affine m0 = [A t], (S_pivot)*m0 = [S*A, S*t + (I-S)*pivot - but easier: recompute t scaled]
      for (let i = 0; i < sm.length; i++) {
        const m0 = sm[i], m = it.transforms[i];
        const ne = pivot.x + (m0.e - pivot.x) * sx, nf = pivot.y + (m0.f - pivot.y) * sy;
        m.e = ne; m.f = nf;
        // Linear: diag(sx,sy) * A
        m.a = sx * m0.a; m.b = sy * m0.b; m.c = sx * m0.c; m.d = sy * m0.d;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of it.transforms) for (const poly of it.polys) for (const p of poly) {
        const wx = m.a * p.x + m.c * p.y + m.e, wy = m.b * p.x + m.d * p.y + m.f;
        minX = Math.min(minX, wx); minY = Math.min(minY, wy); maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy);
      }
      if (isFinite(minX)) it.bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    ctx.doc.inkRevision++; ctx.invalidateInk(); ctx.invalidateField();
  }
  private restoreStart(ctx: ToolContext): void {
    for (const [id, sm] of this.startInkTransforms) {
      const it = ctx.doc.items.find((i) => i.id === id);
      const sb = this.startInk.get(id), sgy = this.startInkGy.get(id);
      if (!it || !sb || !sgy) continue;
      it.transforms.length = 0; for (const m of sm) it.transforms.push({ ...m });
      it.bounds = { ...sb }; it.gy0 = sgy.gy0; it.gy1 = sgy.gy1;
    }
    for (const [id, s] of this.startImage) { const l = ctx.doc.layerById(id); if (l) { l.imageX = s.x; l.imageY = s.y; l.imageW = s.w; l.imageH = s.h; l.imageAngle = s.angle; } }
    for (const [id, sp] of this.startBodyPos) { const b = ctx.doc.physics.bodies.find((bb) => bb.id === id), sa = this.startBodyAngle.get(id); if (b) { b.pos.x = sp.x; b.pos.y = sp.y; if (sa !== undefined) b.angle = sa; syncTransform(b); } }
    ctx.doc.inkRevision++;
  }
}
