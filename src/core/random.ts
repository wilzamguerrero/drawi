/**
 * Deterministic randomness.
 *
 * Every procedural element (splat scatter, edge irregularity, blob wobble)
 * stores a seed instead of baked geometry, so a document can be re-rendered,
 * re-scaled or re-exported and still look identical.
 */

/** mulberry32 — small, fast, good enough distribution for visuals. */
export const makeRng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randomSeed = (): number => (Math.random() * 0xffffffff) >>> 0

/** Integer hash → [0, 1). Stateless, so it can be called out of order. */
export const hash01 = (n: number): number => {
  let x = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = x ^ (x >>> 16)
  return (x >>> 0) / 4294967296
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)

/**
 * 1D value noise with cubic interpolation, in [-1, 1].
 * Used to modulate stroke radius along its arc length.
 */
export const noise1 = (x: number, seed = 0): number => {
  const i = Math.floor(x)
  const f = x - i
  const a = hash01(i * 374761393 + seed * 668265263)
  const b = hash01((i + 1) * 374761393 + seed * 668265263)
  return (a + (b - a) * fade(f)) * 2 - 1
}

/** 2D value noise in [-1, 1]. */
export const noise2 = (x: number, y: number, seed = 0): number => {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = fade(x - ix)
  const fy = fade(y - iy)
  const h = (px: number, py: number): number =>
    hash01(px * 374761393 + py * 668265263 + seed * 2147483647)
  const a = h(ix, iy)
  const b = h(ix + 1, iy)
  const c = h(ix, iy + 1)
  const d = h(ix + 1, iy + 1)
  const top = a + (b - a) * fx
  const bottom = c + (d - c) * fx
  return (top + (bottom - top) * fy) * 2 - 1
}

/** Fractal brownian motion over `noise1`. */
export const fbm1 = (x: number, octaves = 3, seed = 0): number => {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise1(x * freq, seed + i * 17) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.07
  }
  return norm > 0 ? sum / norm : 0
}
