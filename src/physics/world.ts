import { clamp, TAU } from "../core/math";
import { uid } from "../core/rng";
import * as V from "../core/vec2";
import type { Vec2 } from "../core/vec2";
import {
  boundingRadius,
  colliderVerts,
  massProperties,
  type ShapeDef,
} from "./shapes";

export interface Body {
  id: string;
  shape: ShapeDef;
  /** Vertices del colisionador en local; null = circulo. */
  local: Vec2[] | null;
  /** Cache en mundo, recalculada cuando cambia la transformacion. */
  world: Vec2[];
  normals: Vec2[];
  radius: number;

  pos: Vec2;
  angle: number;
  vel: Vec2;
  angVel: number;

  mass: number;
  invMass: number;
  inertia: number;
  invInertia: number;

  restitution: number;
  friction: number;
  density: number;
  isStatic: boolean;

  color: string;
  /** Grupo de fusion: solo se funden cuerpos del mismo grupo (0 = todos). */
  group: number;
  /** Radio de fusion propio; 0 = usa el global. */
  blend: number;

  awake: boolean;
  sleepTimer: number;

  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  transformDirty: boolean;
}

export interface WorldSettings {
  gravity: Vec2;
  /** Atraccion mutua: hace que las formas se busquen y se fundan. */
  cohesion: number;
  /** Amortiguacion lineal por segundo (0 = sin perdidas). */
  damping: number;
  restitution: number;
  friction: number;
  /** Radio de mezcla suave del campo, en unidades de mundo. */
  blend: number;
  /** Paredes del contenedor. */
  walls: boolean;
  iterations: number;
  timeScale: number;
  /** Los cuerpos duermen cuando se quedan quietos. */
  sleeping: boolean;
}

export const DEFAULT_WORLD: WorldSettings = {
  gravity: { x: 0, y: 900 },
  cohesion: 0,
  damping: 0.25,
  restitution: 0.15,
  friction: 0.35,
  blend: 26,
  walls: true,
  iterations: 8,
  timeScale: 1,
  sleeping: true,
};

interface ContactPoint {
  p: Vec2;
  depth: number;
  pn: number; // impulso normal acumulado
  pt: number; // impulso tangencial acumulado
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  massN: number;
  massT: number;
  bias: number;
}

interface Contact {
  a: Body;
  b: Body;
  normal: Vec2;
  points: ContactPoint[];
  e: number;
  mu: number;
}

const SLOP = 0.35;
const COHESION_GAIN = 55;
const BAUMGARTE = 0.2;
const SLEEP_LINEAR = 6;
const SLEEP_ANGULAR = 0.25;
const SLEEP_TIME = 0.8;

export function createBody(
  shape: ShapeDef,
  pos: Vec2,
  opts: Partial<Pick<Body, "angle" | "color" | "group" | "isStatic" | "density" | "restitution" | "friction" | "blend">> = {},
): Body {
  const local = colliderVerts(shape);
  const density = opts.density ?? 0.0012;
  const { mass, inertia } = massProperties(shape, local, density);
  const isStatic = opts.isStatic ?? false;
  const body: Body = {
    id: uid(),
    shape,
    local,
    world: local ? local.map((p) => ({ x: p.x, y: p.y })) : [],
    normals: local ? local.map(() => ({ x: 0, y: 0 })) : [],
    radius: boundingRadius(shape),
    pos: { x: pos.x, y: pos.y },
    angle: opts.angle ?? 0,
    vel: { x: 0, y: 0 },
    angVel: 0,
    mass,
    invMass: isStatic ? 0 : 1 / mass,
    inertia,
    invInertia: isStatic ? 0 : 1 / inertia,
    restitution: opts.restitution ?? DEFAULT_WORLD.restitution,
    friction: opts.friction ?? DEFAULT_WORLD.friction,
    density,
    isStatic,
    color: opts.color ?? "#e2571f",
    group: opts.group ?? 0,
    blend: opts.blend ?? 0,
    awake: true,
    sleepTimer: 0,
    minx: 0,
    miny: 0,
    maxx: 0,
    maxy: 0,
    transformDirty: true,
  };
  syncTransform(body);
  return body;
}

export function syncTransform(b: Body): void {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  if (b.local) {
    const n = b.local.length;
    for (let i = 0; i < n; i++) {
      const p = b.local[i];
      b.world[i].x = b.pos.x + p.x * c - p.y * s;
      b.world[i].y = b.pos.y + p.x * s + p.y * c;
    }
    for (let i = 0; i < n; i++) {
      const p1 = b.world[i];
      const p2 = b.world[(i + 1) % n];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const l = Math.hypot(dx, dy) || 1;
      // Normal exterior para poligonos en sentido horario en Y hacia abajo.
      b.normals[i].x = dy / l;
      b.normals[i].y = -dx / l;
    }
  }
  b.minx = b.pos.x - b.radius;
  b.miny = b.pos.y - b.radius;
  b.maxx = b.pos.x + b.radius;
  b.maxy = b.pos.y + b.radius;
  b.transformDirty = false;
}

export function setBodyStatic(b: Body, isStatic: boolean): void {
  b.isStatic = isStatic;
  b.invMass = isStatic ? 0 : 1 / b.mass;
  b.invInertia = isStatic ? 0 : 1 / b.inertia;
  if (isStatic) {
    b.vel.x = 0;
    b.vel.y = 0;
    b.angVel = 0;
  }
  wake(b);
}

export function wake(b: Body): void {
  b.awake = true;
  b.sleepTimer = 0;
}

/** Punto de soporte de un poligono en una direccion. */
const support = (verts: Vec2[], dx: number, dy: number): Vec2 => {
  let best = verts[0];
  let bestD = best.x * dx + best.y * dy;
  for (let i = 1; i < verts.length; i++) {
    const d = verts[i].x * dx + verts[i].y * dy;
    if (d > bestD) {
      bestD = d;
      best = verts[i];
    }
  }
  return best;
};

/**
 * Mundo de cuerpos rigidos con solver de impulsos secuenciales.
 *
 * Es deliberadamente compacto: formas convexas (o su envolvente), broadphase por
 * AABB y 8 iteraciones. Con decenas de cuerpos va sobrado a 60 fps y no arrastra
 * ninguna dependencia, que es lo que permite que el campo metaball y la fisica
 * compartan exactamente la misma definicion de forma.
 */
export class PhysicsWorld {
  settings: WorldSettings = { ...DEFAULT_WORLD, gravity: { ...DEFAULT_WORLD.gravity } };
  bodies: Body[] = [];
  bounds: { x: number; y: number; w: number; h: number } = { x: -600, y: -400, w: 1200, h: 800 };

  private contacts: Contact[] = [];
  private accumulator = 0;
  private drag: { body: Body; localX: number; localY: number; targetX: number; targetY: number } | null = null;

  add(body: Body): Body {
    this.bodies.push(body);
    return body;
  }

  remove(id: string): void {
    const i = this.bodies.findIndex((b) => b.id === id);
    if (i >= 0) this.bodies.splice(i, 1);
    if (this.drag && this.drag.body.id === id) this.drag = null;
  }

  clear(): void {
    this.bodies.length = 0;
    this.contacts.length = 0;
    this.drag = null;
  }

  wakeAll(): void {
    for (const b of this.bodies) wake(b);
  }

  /** Cuerpo cuyo interior contiene el punto (el ultimo dibujado gana). */
  pick(x: number, y: number, margin = 0): Body | null {
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (x < b.minx - margin || x > b.maxx + margin || y < b.miny - margin || y > b.maxy + margin) {
        continue;
      }
      if (this.containsPoint(b, x, y, margin)) return b;
    }
    return null;
  }

  containsPoint(b: Body, x: number, y: number, margin = 0): boolean {
    if (!b.local) return Math.hypot(x - b.pos.x, y - b.pos.y) <= b.shape.size + margin;
    const n = b.world.length;
    for (let i = 0; i < n; i++) {
      const d =
        b.normals[i].x * (x - b.world[i].x) + b.normals[i].y * (y - b.world[i].y);
      if (d > margin) return false;
    }
    return true;
  }

  beginDrag(body: Body, x: number, y: number): void {
    const c = Math.cos(-body.angle);
    const s = Math.sin(-body.angle);
    const dx = x - body.pos.x;
    const dy = y - body.pos.y;
    this.drag = {
      body,
      localX: dx * c - dy * s,
      localY: dx * s + dy * c,
      targetX: x,
      targetY: y,
    };
    wake(body);
  }

  moveDrag(x: number, y: number): void {
    if (!this.drag) return;
    this.drag.targetX = x;
    this.drag.targetY = y;
  }

  endDrag(): void {
    this.drag = null;
  }

  get dragging(): Body | null {
    return this.drag?.body ?? null;
  }

  /** Avanza con paso fijo para que la simulacion no dependa del framerate. */
  update(dtSeconds: number): void {
    const scaled = clamp(dtSeconds, 0, 0.05) * this.settings.timeScale;
    this.accumulator += scaled;
    const fixed = 1 / 120;
    let steps = 0;
    while (this.accumulator >= fixed && steps < 8) {
      this.step(fixed);
      this.accumulator -= fixed;
      steps++;
    }
    if (steps === 8) this.accumulator = 0;
  }

  step(dt: number): void {
    const s = this.settings;
    this.applyForces(dt);
    this.buildContacts();
    this.prepareContacts(dt);
    for (let i = 0; i < s.iterations; i++) this.solveContacts();
    this.integrate(dt);
    if (s.walls) this.solveWalls();
    for (const b of this.bodies) if (b.transformDirty) syncTransform(b);
    if (s.sleeping) this.updateSleep(dt);
  }

  private applyForces(dt: number): void {
    const s = this.settings;
    const damp = Math.exp(-s.damping * dt);
    for (const b of this.bodies) {
      if (b.isStatic || !b.awake) continue;
      b.vel.x += s.gravity.x * dt;
      b.vel.y += s.gravity.y * dt;
      b.vel.x *= damp;
      b.vel.y *= damp;
      b.angVel *= damp;
    }

    if (s.cohesion !== 0) this.applyCohesion(dt);

    if (this.drag) {
      const { body, localX, localY, targetX, targetY } = this.drag;
      const c = Math.cos(body.angle);
      const sn = Math.sin(body.angle);
      const rx = localX * c - localY * sn;
      const ry = localX * sn + localY * c;
      const px = body.pos.x + rx;
      const py = body.pos.y + ry;
      // Muelle critico: sigue al dedo sin rebotar.
      const k = 26;
      const vx = (targetX - px) * k;
      const vy = (targetY - py) * k;
      if (!body.isStatic) {
        body.vel.x += (vx - (body.vel.x - body.angVel * ry)) * 0.55;
        body.vel.y += (vy - (body.vel.y + body.angVel * rx)) * 0.55;
        body.angVel *= 0.82;
      } else {
        body.pos.x = targetX - rx;
        body.pos.y = targetY - ry;
        body.transformDirty = true;
      }
      wake(body);
    }
  }

  /** Atraccion de corto alcance entre cuerpos cercanos del mismo grupo. */
  private applyCohesion(dt: number): void {
    const n = this.bodies.length;
    // La aceleracion que sale de la formula esta acotada por `strength`, porque
    // dx/d <= 1. Sin ganancia, el maximo del deslizador (1) daria ~1 px/s2, es
    // decir, nada perceptible; COHESION_GAIN lleva el 0..1 del control a un
    // rango que se siente (hasta ~55 px/s2, aun asi suave frente a la gravedad).
    const strength = this.settings.cohesion * COHESION_GAIN;
    for (let i = 0; i < n; i++) {
      const a = this.bodies[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[j];
        if (a.isStatic && b.isStatic) continue;
        if (a.group !== 0 && b.group !== 0 && a.group !== b.group) continue;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const d2 = dx * dx + dy * dy;
        const reach = (a.radius + b.radius) * 2.6;
        if (d2 > reach * reach || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const falloff = 1 - d / reach;
        const f = (strength * falloff * falloff) / d;
        if (!a.isStatic && a.awake) {
          a.vel.x += dx * f * dt;
          a.vel.y += dy * f * dt;
        }
        if (!b.isStatic && b.awake) {
          b.vel.x -= dx * f * dt;
          b.vel.y -= dy * f * dt;
        }
      }
    }
  }

  private integrate(dt: number): void {
    for (const b of this.bodies) {
      if (b.isStatic || !b.awake) continue;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.angle += b.angVel * dt;
      if (b.angle > TAU || b.angle < -TAU) b.angle %= TAU;
      b.transformDirty = true;
    }
  }

  private solveWalls(): void {
    const { x, y, w, h } = this.bounds;
    const e = this.settings.restitution;
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      const r = b.radius;
      let hit = false;
      if (b.pos.x - r < x) {
        b.pos.x = x + r;
        if (b.vel.x < 0) b.vel.x = -b.vel.x * e;
        hit = true;
      } else if (b.pos.x + r > x + w) {
        b.pos.x = x + w - r;
        if (b.vel.x > 0) b.vel.x = -b.vel.x * e;
        hit = true;
      }
      if (b.pos.y - r < y) {
        b.pos.y = y + r;
        if (b.vel.y < 0) b.vel.y = -b.vel.y * e;
        hit = true;
      } else if (b.pos.y + r > y + h) {
        b.pos.y = y + h - r;
        if (b.vel.y > 0) {
          b.vel.y = -b.vel.y * e;
          b.vel.x *= 1 - this.settings.friction * 0.35;
          b.angVel *= 0.9;
        }
        hit = true;
      }
      if (hit) {
        b.transformDirty = true;
        wake(b);
      }
    }
  }

  private updateSleep(dt: number): void {
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      const still =
        Math.hypot(b.vel.x, b.vel.y) < SLEEP_LINEAR && Math.abs(b.angVel) < SLEEP_ANGULAR;
      if (still) {
        b.sleepTimer += dt;
        if (b.sleepTimer > SLEEP_TIME) {
          b.awake = false;
          b.vel.x = 0;
          b.vel.y = 0;
          b.angVel = 0;
        }
      } else {
        b.sleepTimer = 0;
        b.awake = true;
      }
    }
  }

  // ---------------------------------------------------------------- colisiones

  private buildContacts(): void {
    this.contacts.length = 0;
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      const a = this.bodies[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[j];
        if (a.isStatic && b.isStatic) continue;
        if (!a.awake && !b.awake) continue;
        if (a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny) continue;
        const c = collide(a, b);
        if (c) {
          this.contacts.push(c);
          if (a.awake !== b.awake) {
            wake(a);
            wake(b);
          }
        }
      }
    }
  }

  private prepareContacts(dt: number): void {
    for (const c of this.contacts) {
      const { a, b, normal } = c;
      const tx = -normal.y;
      const ty = normal.x;
      for (const p of c.points) {
        p.rax = p.p.x - a.pos.x;
        p.ray = p.p.y - a.pos.y;
        p.rbx = p.p.x - b.pos.x;
        p.rby = p.p.y - b.pos.y;

        const rnA = p.rax * normal.y - p.ray * normal.x;
        const rnB = p.rbx * normal.y - p.rby * normal.x;
        p.massN =
          1 /
          (a.invMass + b.invMass + a.invInertia * rnA * rnA + b.invInertia * rnB * rnB);

        const rtA = p.rax * ty - p.ray * tx;
        const rtB = p.rbx * ty - p.rby * tx;
        p.massT =
          1 / (a.invMass + b.invMass + a.invInertia * rtA * rtA + b.invInertia * rtB * rtB);

        p.bias = (-BAUMGARTE / dt) * Math.min(0, -p.depth + SLOP);
        p.pn = 0;
        p.pt = 0;
      }
    }
  }

  private solveContacts(): void {
    for (const c of this.contacts) {
      const { a, b, normal } = c;
      const tx = -normal.y;
      const ty = normal.x;
      for (const p of c.points) {
        // Velocidad relativa en el punto de contacto.
        const dvx =
          b.vel.x - b.angVel * p.rby - (a.vel.x - a.angVel * p.ray);
        const dvy =
          b.vel.y + b.angVel * p.rbx - (a.vel.y + a.angVel * p.rax);

        const vn = dvx * normal.x + dvy * normal.y;
        let dPn = p.massN * (-vn + p.bias - vn * c.e);
        const newPn = Math.max(p.pn + dPn, 0);
        dPn = newPn - p.pn;
        p.pn = newPn;

        const pnx = dPn * normal.x;
        const pny = dPn * normal.y;
        applyImpulse(a, -pnx, -pny, p.rax, p.ray);
        applyImpulse(b, pnx, pny, p.rbx, p.rby);

        const dvx2 = b.vel.x - b.angVel * p.rby - (a.vel.x - a.angVel * p.ray);
        const dvy2 = b.vel.y + b.angVel * p.rbx - (a.vel.y + a.angVel * p.rax);
        const vt = dvx2 * tx + dvy2 * ty;
        let dPt = p.massT * -vt;
        const maxPt = c.mu * p.pn;
        const newPt = clamp(p.pt + dPt, -maxPt, maxPt);
        dPt = newPt - p.pt;
        p.pt = newPt;

        applyImpulse(a, -dPt * tx, -dPt * ty, p.rax, p.ray);
        applyImpulse(b, dPt * tx, dPt * ty, p.rbx, p.rby);
      }
    }
  }
}

function applyImpulse(b: Body, px: number, py: number, rx: number, ry: number): void {
  if (b.isStatic) return;
  b.vel.x += px * b.invMass;
  b.vel.y += py * b.invMass;
  b.angVel += b.invInertia * (rx * py - ry * px);
}

// ------------------------------------------------------------- narrowphase

function collide(a: Body, b: Body): Contact | null {
  const e = Math.max(a.restitution, b.restitution);
  const mu = Math.sqrt(a.friction * b.friction);
  if (!a.local && !b.local) return circleCircle(a, b, e, mu);
  if (!a.local) {
    const c = circlePolygon(a, b, e, mu);
    return c;
  }
  if (!b.local) {
    const c = circlePolygon(b, a, e, mu);
    if (c) {
      c.normal.x = -c.normal.x;
      c.normal.y = -c.normal.y;
      const tmp = c.a;
      c.a = c.b;
      c.b = tmp;
    }
    return c;
  }
  return polygonPolygon(a, b, e, mu);
}

function makePoint(x: number, y: number, depth: number): ContactPoint {
  return {
    p: { x, y },
    depth,
    pn: 0,
    pt: 0,
    rax: 0,
    ray: 0,
    rbx: 0,
    rby: 0,
    massN: 0,
    massT: 0,
    bias: 0,
  };
}

function circleCircle(a: Body, b: Body, e: number, mu: number): Contact | null {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const ra = a.shape.size;
  const rb = b.shape.size;
  const d = Math.hypot(dx, dy);
  if (d >= ra + rb) return null;
  const normal = d > 1e-6 ? { x: dx / d, y: dy / d } : { x: 0, y: 1 };
  const depth = ra + rb - d;
  const px = a.pos.x + normal.x * (ra - depth / 2);
  const py = a.pos.y + normal.y * (ra - depth / 2);
  return { a, b, normal, points: [makePoint(px, py, depth)], e, mu };
}

/** `circle` es un cuerpo circular; `poly` tiene vertices. Normal de circle a poly. */
function circlePolygon(circle: Body, poly: Body, e: number, mu: number): Contact | null {
  const r = circle.shape.size;
  const n = poly.world.length;
  let bestIdx = 0;
  let bestSep = -Infinity;
  for (let i = 0; i < n; i++) {
    const sep =
      poly.normals[i].x * (circle.pos.x - poly.world[i].x) +
      poly.normals[i].y * (circle.pos.y - poly.world[i].y);
    if (sep > r) return null;
    if (sep > bestSep) {
      bestSep = sep;
      bestIdx = i;
    }
  }

  const v1 = poly.world[bestIdx];
  const v2 = poly.world[(bestIdx + 1) % n];

  if (bestSep < 1e-6) {
    // Centro dentro del poligono: empuja por la cara mas cercana.
    const nrm = poly.normals[bestIdx];
    return {
      a: circle,
      b: poly,
      normal: { x: -nrm.x, y: -nrm.y },
      points: [makePoint(circle.pos.x, circle.pos.y, r - bestSep)],
      e,
      mu,
    };
  }

  const ex = v2.x - v1.x;
  const ey = v2.y - v1.y;
  const t = clamp(
    ((circle.pos.x - v1.x) * ex + (circle.pos.y - v1.y) * ey) / (ex * ex + ey * ey || 1),
    0,
    1,
  );
  const cx = v1.x + ex * t;
  const cy = v1.y + ey * t;
  const dx = cx - circle.pos.x;
  const dy = cy - circle.pos.y;
  const d = Math.hypot(dx, dy);
  if (d > r) return null;
  const normal = d > 1e-6 ? { x: dx / d, y: dy / d } : { x: poly.normals[bestIdx].x, y: poly.normals[bestIdx].y };
  return { a: circle, b: poly, normal, points: [makePoint(cx, cy, r - d)], e, mu };
}

function maxSeparation(a: Body, b: Body): { sep: number; idx: number } {
  let best = -Infinity;
  let idx = 0;
  const n = a.world.length;
  for (let i = 0; i < n; i++) {
    const nx = a.normals[i].x;
    const ny = a.normals[i].y;
    const s = support(b.world, -nx, -ny);
    const sep = nx * (s.x - a.world[i].x) + ny * (s.y - a.world[i].y);
    if (sep > best) {
      best = sep;
      idx = i;
    }
  }
  return { sep: best, idx };
}

function polygonPolygon(a: Body, b: Body, e: number, mu: number): Contact | null {
  const sa = maxSeparation(a, b);
  if (sa.sep > 0) return null;
  const sb = maxSeparation(b, a);
  if (sb.sep > 0) return null;

  // El poligono de referencia es el de mayor separacion (con sesgo por estabilidad).
  const flip = sb.sep > sa.sep + 0.01;
  const ref = flip ? b : a;
  const inc = flip ? a : b;
  const refIdx = flip ? sb.idx : sa.idx;

  const rn = ref.normals[refIdx];
  const rv1 = ref.world[refIdx];
  const rv2 = ref.world[(refIdx + 1) % ref.world.length];

  // Cara incidente: la mas antiparalela a la normal de referencia.
  const m = inc.world.length;
  let incIdx = 0;
  let minDot = Infinity;
  for (let i = 0; i < m; i++) {
    const d = inc.normals[i].x * rn.x + inc.normals[i].y * rn.y;
    if (d < minDot) {
      minDot = d;
      incIdx = i;
    }
  }
  let i1 = { x: inc.world[incIdx].x, y: inc.world[incIdx].y };
  let i2 = { x: inc.world[(incIdx + 1) % m].x, y: inc.world[(incIdx + 1) % m].y };

  const tx = rv2.x - rv1.x;
  const ty = rv2.y - rv1.y;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;

  const clipped = clipSegment(i1, i2, -ux, -uy, -(ux * rv1.x + uy * rv1.y));
  if (!clipped) return null;
  [i1, i2] = clipped;
  const clipped2 = clipSegment(i1, i2, ux, uy, ux * rv2.x + uy * rv2.y);
  if (!clipped2) return null;
  [i1, i2] = clipped2;

  const points: ContactPoint[] = [];
  for (const p of [i1, i2]) {
    const sep = rn.x * (p.x - rv1.x) + rn.y * (p.y - rv1.y);
    if (sep <= 0) points.push(makePoint(p.x, p.y, -sep));
  }
  if (points.length === 0) return null;

  const normal = flip ? { x: -rn.x, y: -rn.y } : { x: rn.x, y: rn.y };
  return { a, b, normal, points, e, mu };
}

/** Recorta el segmento al semiplano n.p <= offset. */
function clipSegment(
  p1: Vec2,
  p2: Vec2,
  nx: number,
  ny: number,
  offset: number,
): [Vec2, Vec2] | null {
  const d1 = nx * p1.x + ny * p1.y - offset;
  const d2 = nx * p2.x + ny * p2.y - offset;
  const out: Vec2[] = [];
  if (d1 <= 0) out.push(p1);
  if (d2 <= 0) out.push(p2);
  if (d1 * d2 < 0) {
    const t = d1 / (d1 - d2);
    out.push({ x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t });
  }
  if (out.length < 2) return null;
  return [out[0], out[1]];
}

export const distanceBetween = (a: Body, b: Body): number =>
  V.dist(a.pos, b.pos) - a.radius - b.radius;
