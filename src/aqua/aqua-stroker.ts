/**
 * AquaStroker — convierte el movimiento del puntero en huellas para AquaField.
 *
 * Separa la "intencion de pintura" (donde, con que presion y velocidad) de la
 * simulacion en si. El emisor suaviza el trazo, mide velocidad, y en cada frame
 * siembra pigmento/agua/velocidad a lo largo del tramo recorrido, con el
 * espaciado y radio propios de cada modo:
 *  - pen:   linea fina y oscura; deposita pigmento y moja levemente.
 *  - brush: moja y empuja el fluido (opcionalmente carga algo de pigmento).
 *
 * Es un port directo de la logica `updateBrush` del prototipo inkwash, aislado
 * para que la herramienta de drawi solo tenga que alimentar coordenadas 0..1.
 */

import type { AquaField, AquaMode } from "./aqua-field";

interface PointerState {
  down: boolean;
  tx: number; // objetivo (ultimo evento), en UV 0..1
  ty: number;
  bx: number; // posicion suavizada ("brush")
  by: number;
  speed: number;
  pressure: number;
}

export class AquaStroker {
  private field: AquaField;
  mode: AquaMode = "pen";

  private ptr: PointerState = {
    down: false,
    tx: 0.5,
    ty: 0.5,
    bx: 0.5,
    by: 0.5,
    speed: 0,
    pressure: 0.35,
  };

  constructor(field: AquaField) {
    this.field = field;
  }

  /** Comienza un trazo en UV (0..1). */
  begin(x: number, y: number, pressure = 0.5): void {
    const p = this.ptr;
    p.down = true;
    p.tx = x;
    p.ty = y;
    p.bx = x;
    p.by = y;
    p.speed = 0;
    p.pressure = pressure;
  }

  /** Mueve el objetivo del trazo a UV (0..1). */
  move(x: number, y: number, pressure?: number): void {
    const p = this.ptr;
    p.tx = x;
    p.ty = y;
    if (pressure !== undefined) p.pressure = pressure;
  }

  /** Levanta el lapiz. */
  end(): void {
    this.ptr.down = false;
  }

  /** Escala global del radio segun el slider de tamaño (1/3x .. 3x). */
  private sizeMult(): number {
    return Math.pow(3, (this.field.params.size - 0.5) * 2);
  }

  private penRadius(pr: number, speed: number): number {
    return (0.0016 + 0.0042 * pr) * Math.min(Math.max(1.12 - speed * 0.3, 0.55), 1.12) * this.sizeMult();
  }

  private brushRadius(pr: number, speed: number): number {
    return (0.014 + 0.06 * pr) * (1 + Math.min(speed, 2.5) * 0.28) * this.sizeMult();
  }

  /**
   * Avanza el emisor un frame: suaviza la posicion, mide velocidad y siembra
   * las huellas del tramo recorrido. Llamar antes de `field.step(dt)`.
   */
  update(dt: number): void {
    const p = this.ptr;
    const P = this.field.params;

    // Suavizado exponencial de la posicion (da inercia al trazo).
    const k = 1 - Math.exp(-dt * 14);
    const px = p.bx;
    const py = p.by;
    p.bx += (p.tx - p.bx) * k;
    p.by += (p.ty - p.by) * k;
    const dx = p.bx - px;
    const dy = p.by - py;
    const dist = Math.hypot(dx, dy);
    const inst = dist / Math.max(dt, 1e-4);
    p.speed += (inst - p.speed) * (1 - Math.exp(-dt * 10));

    if (!p.down) return;

    const pr = p.pressure;
    const speed = p.speed;

    if (this.mode === "pen") {
      const radius = this.penRadius(pr, speed);
      const dens = (0.55 + 1.05 * pr) * Math.min(Math.max(1.25 - speed * 0.45, 0.6), 1.25);
      if (dist < radius * 0.4) {
        // El pigmento se encharca mientras el lapiz descansa.
        this.field.splatInk(p.bx, p.by, radius * 1.15, dens * dt * 4);
        this.field.splatWater(p.bx, p.by, radius * 2.8, 0.16);
        return;
      }
      const spacing = radius * 0.6;
      const steps = Math.min(Math.ceil(dist / spacing), 60);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = px + dx * t;
        const y = py + dy * t;
        this.field.splatInk(x, y, radius, dens);
        if (i % 2 === 0 || steps === 1) this.field.splatWater(x, y, radius * 2.8, 0.16);
      }
    } else {
      const radius = this.brushRadius(pr, speed);
      this.field.setBrushFootprint(p.bx, p.by, radius);
      const wAmp = 0.5 + 0.5 * pr;
      const force = 15 + P.flow * 95;
      const vmax = 240;
      let vx = (dx / Math.max(dt, 1e-4)) * force;
      let vy = (dy / Math.max(dt, 1e-4)) * force;
      const vm = Math.hypot(vx, vy);
      if (vm > vmax) {
        vx *= vmax / vm;
        vy *= vmax / vm;
      }
      const bdens = P.brushInk * 0.1 * (0.4 + 0.6 * pr);

      if (dist < radius * 0.25) {
        this.field.splatWater(p.bx, p.by, radius, wAmp);
        // Remueve suavemente mientras el pincel se detiene.
        const a = Math.random() * Math.PI * 2;
        const jm = (6 + 26 * P.flow) * pr;
        this.field.splatVelocity(p.bx, p.by, radius * 0.9, Math.cos(a) * jm, Math.sin(a) * jm);
        if (bdens > 0) this.field.splatInk(p.bx, p.by, radius * 0.8, bdens * dt * 5);
        return;
      }
      const spacing = radius * 0.7;
      const steps = Math.min(Math.ceil(dist / spacing), 12);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = px + dx * t;
        const y = py + dy * t;
        this.field.splatWater(x, y, radius, wAmp);
        this.field.splatVelocity(x, y, radius * 1.15, vx, vy);
        if (bdens > 0) this.field.splatInk(x, y, radius * 0.8, bdens);
      }
    }
  }
}
