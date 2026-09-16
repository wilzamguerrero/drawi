/** PRNG determinista (mulberry32): mismas semillas => mismos "splats". */

export class Rng {
  private s: number;

  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1 - 1e-9));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  /** Ruido gaussiano aproximado (suma de uniformes). */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }

  reseed(seed: number): void {
    this.s = seed >>> 0;
  }
}

export const globalRng = new Rng((Math.random() * 0xffffffff) >>> 0);

export const uid = (): string =>
  Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
