import { makeId, type Id } from '@/core/id'
import { SpatialGrid } from '@/core/spatial'
import { boundsIntersect, emptyBounds, growBounds, type Bounds } from '@/stroke/types'
import { hitTestObject, objectWorldBounds } from './object'
import type { Layer, SceneObject } from './types'

/**
 * The document.
 *
 * Objects live in a map; paint order lives in a separate array. Keeping them
 * apart means reordering never touches the objects themselves, and an object
 * reference stays stable across every edit — which is what lets the physics
 * solver and the field renderer hold onto objects between frames.
 */
export class SceneDocument {
  readonly objects = new Map<Id, SceneObject>()
  /** Paint order, back to front, independent of layer grouping. */
  readonly order: Id[] = []
  readonly layers: Layer[] = []

  /** Bumped on any structural or geometric change. Render caches compare it. */
  revision = 1

  private readonly grid = new SpatialGrid(320)
  private renderCache: SceneObject[] = []
  private renderCacheRevision = -1
  /** Paint-order position by id, rebuilt with the render cache. */
  private orderIndex = new Map<Id, number>()

  constructor() {
    this.addLayer('Layer 1')
  }

  get activeLayerId(): Id {
    return this.layers[this.layers.length - 1].id
  }

  addLayer(name: string): Layer {
    const layer: Layer = {
      id: makeId('l'),
      name,
      visible: true,
      locked: false,
      opacity: 1,
    }
    this.layers.push(layer)
    this.revision += 1
    return layer
  }

  add(object: SceneObject): SceneObject {
    this.objects.set(object.id, object)
    this.order.push(object.id)
    this.grid.insert(object.id, objectWorldBounds(object))
    this.revision += 1
    return object
  }

  remove(id: Id): SceneObject | undefined {
    const object = this.objects.get(id)
    if (!object) return undefined
    this.objects.delete(id)
    const i = this.order.indexOf(id)
    if (i >= 0) this.order.splice(i, 1)
    this.grid.remove(id)
    this.revision += 1
    return object
  }

  get(id: Id): SceneObject | undefined {
    return this.objects.get(id)
  }

  /** Re-indexes an object after its geometry or transform changed. */
  reindex(id: Id): void {
    const object = this.objects.get(id)
    if (!object) return
    this.grid.insert(id, objectWorldBounds(object))
    this.revision += 1
  }

  /**
   * Paint order: layer order first, then depth inside a layer. Sorting by z
   * here is what gives the 2.5D stack its occlusion without a depth buffer.
   */
  renderList(): readonly SceneObject[] {
    if (this.renderCacheRevision === this.revision) return this.renderCache
    const layerIndex = new Map<Id, number>()
    this.layers.forEach((l, i) => layerIndex.set(l.id, i))

    // Insertion position is looked up from a map, not searched for. A linear
    // scan inside the comparator would make this quadratic, and the simulation
    // re-sorts on every frame.
    this.orderIndex.clear()
    this.order.forEach((id, i) => this.orderIndex.set(id, i))

    const list: SceneObject[] = []
    for (const id of this.order) {
      const o = this.objects.get(id)
      if (o) list.push(o)
    }
    list.sort((a, b) => {
      const la = layerIndex.get(a.layerId) ?? 0
      const lb = layerIndex.get(b.layerId) ?? 0
      if (la !== lb) return la - lb
      if (a.transform.z !== b.transform.z) return a.transform.z - b.transform.z
      return (this.orderIndex.get(a.id) ?? 0) - (this.orderIndex.get(b.id) ?? 0)
    })

    this.renderCache = list
    this.renderCacheRevision = this.revision
    return list
  }

  /** Objects whose world bounds overlap `bounds`, in paint order. */
  query(bounds: Bounds, pad = 0): SceneObject[] {
    const candidates = this.grid.query(bounds)
    const out: SceneObject[] = []
    for (const id of candidates) {
      const o = this.objects.get(id)
      if (!o) continue
      if (boundsIntersect(objectWorldBounds(o), bounds, pad)) out.push(o)
    }
    // Paint order, so the caller can composite or pick without re-sorting.
    const list = this.renderList()
    const rank = new Map<Id, number>()
    list.forEach((o, i) => rank.set(o.id, i))
    out.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    return out
  }

  /** Topmost object under a world-space point, honouring locks and visibility. */
  pick(x: number, y: number, tolerance = 2): SceneObject | undefined {
    const probe: Bounds = {
      minX: x - tolerance,
      minY: y - tolerance,
      maxX: x + tolerance,
      maxY: y + tolerance,
    }
    const candidates = this.query(probe)
    for (let i = candidates.length - 1; i >= 0; i--) {
      const o = candidates[i]
      if (!o.visible || o.locked) continue
      const layer = this.layers.find((l) => l.id === o.layerId)
      if (layer && (!layer.visible || layer.locked)) continue
      if (hitTestObject(o, x, y, tolerance)) return o
    }
    return undefined
  }

  /** Union of the world bounds of the given ids, or of the whole document. */
  boundsOf(ids?: Iterable<Id>): Bounds {
    const out = emptyBounds()
    const source = ids ?? this.order
    for (const id of source) {
      const o = this.objects.get(id)
      if (!o) continue
      const b = objectWorldBounds(o)
      growBounds(out, b.minX, b.minY)
      growBounds(out, b.maxX, b.maxY)
    }
    return out
  }

  clear(): void {
    this.objects.clear()
    this.order.length = 0
    this.grid.clear()
    this.revision += 1
  }
}
