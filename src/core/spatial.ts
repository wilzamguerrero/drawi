import type { Id } from '@/core/id'
import type { Bounds } from '@/stroke/types'

/**
 * Uniform grid spatial index.
 *
 * The canvas is infinite, so a quadtree would need constant rebalancing as the
 * user pans into empty space. A hashed uniform grid has no root and no bounds:
 * cells only exist where something was inserted, which suits a sketch that
 * grows in whatever direction the user drags.
 */
export class SpatialGrid {
  private readonly cellSize: number
  private readonly cells = new Map<number, Id[]>()
  /** Every cell key an id currently occupies, for cheap removal. */
  private readonly membership = new Map<Id, number[]>()

  constructor(cellSize = 256) {
    this.cellSize = cellSize
  }

  private key(cx: number, cy: number): number {
    // Interleave into a single number. 2^20 cells per axis at any cell size is
    // far beyond what a document reaches, and keeps the key a fast integer.
    return ((cx + 0x80000) << 21) | (cy + 0x80000)
  }

  insert(id: Id, bounds: Bounds): void {
    this.remove(id)
    if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) return

    const x0 = Math.floor(bounds.minX / this.cellSize)
    const y0 = Math.floor(bounds.minY / this.cellSize)
    const x1 = Math.floor(bounds.maxX / this.cellSize)
    const y1 = Math.floor(bounds.maxY / this.cellSize)

    const keys: number[] = []
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = this.key(cx, cy)
        let bucket = this.cells.get(k)
        if (!bucket) {
          bucket = []
          this.cells.set(k, bucket)
        }
        bucket.push(id)
        keys.push(k)
      }
    }
    this.membership.set(id, keys)
  }

  remove(id: Id): void {
    const keys = this.membership.get(id)
    if (!keys) return
    for (const k of keys) {
      const bucket = this.cells.get(k)
      if (!bucket) continue
      const i = bucket.indexOf(id)
      if (i >= 0) bucket.splice(i, 1)
      if (bucket.length === 0) this.cells.delete(k)
    }
    this.membership.delete(id)
  }

  /** Collects candidate ids overlapping `bounds`. Deduplicated. */
  query(bounds: Bounds, into: Set<Id> = new Set()): Set<Id> {
    if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) {
      return into
    }
    const x0 = Math.floor(bounds.minX / this.cellSize)
    const y0 = Math.floor(bounds.minY / this.cellSize)
    const x1 = Math.floor(bounds.maxX / this.cellSize)
    const y1 = Math.floor(bounds.maxY / this.cellSize)
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.cells.get(this.key(cx, cy))
        if (!bucket) continue
        for (const id of bucket) into.add(id)
      }
    }
    return into
  }

  clear(): void {
    this.cells.clear()
    this.membership.clear()
  }
}
