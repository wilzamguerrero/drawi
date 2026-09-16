/**
 * Filtro "One Euro" (Casiez, Roussel, Vogel).
 *
 * Es el compromiso correcto para un lapiz: a baja velocidad filtra con fuerza
 * (elimina el temblor de la mano y el ruido del digitalizador) y a alta velocidad
 * casi no filtra, asi que el trazo no se queda atras. Un promedio movil clasico,
 * en cambio, introduce retardo constante: esa es justo la sensacion de "no responde".
 */
export class LowPass {
  private y = 0;
  private initialized = false;

  filter(x: number, alpha: number): number {
    if (!this.initialized) {
      this.y = x;
      this.initialized = true;
      return x;
    }
    this.y = alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  get value(): number {
    return this.y;
  }

  reset(x?: number): void {
    this.initialized = x !== undefined;
    this.y = x ?? 0;
  }
}

const alphaOf = (cutoff: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / Math.max(dt, 1e-4));
};

export class OneEuroFilter {
  /** Corte base en Hz: mas bajo = mas suave en reposo. */
  minCutoff: number;
  /** Cuanto sube el corte con la velocidad: mas alto = menos retardo al acelerar. */
  beta: number;
  /** Corte del estimador de derivada. */
  dCutoff: number;

  private xf = new LowPass();
  private dxf = new LowPass();
  private lastX: number | null = null;

  constructor(minCutoff = 1.4, beta = 0.035, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  /** @param dt segundos transcurridos desde la muestra anterior. */
  filter(x: number, dt: number): number {
    const d = this.lastX === null ? 0 : (x - this.lastX) / Math.max(dt, 1e-4);
    this.lastX = x;
    const dHat = this.dxf.filter(d, alphaOf(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(dHat);
    return this.xf.filter(x, alphaOf(cutoff, dt));
  }

  reset(): void {
    this.xf.reset();
    this.dxf.reset();
    this.lastX = null;
  }
}

/** Par de filtros One-Euro para una posicion 2D. */
export class OneEuroVec2 {
  readonly fx: OneEuroFilter;
  readonly fy: OneEuroFilter;

  constructor(minCutoff = 1.4, beta = 0.035, dCutoff = 1) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  configure(minCutoff: number, beta: number): void {
    this.fx.minCutoff = minCutoff;
    this.fx.beta = beta;
    this.fy.minCutoff = minCutoff;
    this.fy.beta = beta;
  }

  filter(x: number, y: number, dt: number): { x: number; y: number } {
    return { x: this.fx.filter(x, dt), y: this.fy.filter(y, dt) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
