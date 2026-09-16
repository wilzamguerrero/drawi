/**
 * A field source: a swept circle (an "uneven capsule") in document space.
 *
 * Every drawable in the app reduces to a list of these. A stroke becomes one
 * source per spine segment, with the radius the pressure produced at each end;
 * a splat becomes one source per droplet; a blob becomes a single source with
 * both endpoints equal. That uniformity is what lets strokes, splats and blobs
 * all fuse with each other instead of each needing its own special case.
 */
export interface FieldSource {
  ax: number
  ay: number
  bx: number
  by: number
  ra: number
  rb: number
  /** Field contribution. Negative values carve instead of fusing. */
  strength: number
  /** Reach beyond the surface, in document units. Controls how far it fuses. */
  influence: number
}

/** Floats per source in the GPU instance buffer. */
export const SOURCE_STRIDE = 8

/**
 * Growable packed buffer of sources.
 *
 * Sources are rebuilt every frame the scene changes, which would otherwise mean
 * thousands of small allocations per second. This keeps one buffer and reuses it.
 */
export class FieldSourceBuffer {
  data: Float32Array
  count = 0

  constructor(capacity = 512) {
    this.data = new Float32Array(capacity * SOURCE_STRIDE)
  }

  get capacity(): number {
    return this.data.length / SOURCE_STRIDE
  }

  reset(): void {
    this.count = 0
  }

  push(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    ra: number,
    rb: number,
    strength: number,
    influence: number
  ): void {
    if (this.count >= this.capacity) this.grow()
    const o = this.count * SOURCE_STRIDE
    const d = this.data
    d[o] = ax
    d[o + 1] = ay
    d[o + 2] = bx
    d[o + 3] = by
    d[o + 4] = ra
    d[o + 5] = rb
    d[o + 6] = strength
    d[o + 7] = influence
    this.count += 1
  }

  private grow(): void {
    const next = new Float32Array(this.data.length * 2)
    next.set(this.data)
    this.data = next
  }

  /** The filled portion, ready to upload. */
  view(): Float32Array {
    return this.data.subarray(0, this.count * SOURCE_STRIDE)
  }
}
