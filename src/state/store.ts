import { create } from 'zustand'
import type { Id } from '@/core/id'
import { defaultFieldStyle, type FieldStyle } from '@/render/field-renderer'
import type { BlendMode } from '@/scene/types'
import {
  defaultStrokeOptions,
  type PressureTarget,
  type StrokeOptions,
} from '@/stroke/types'
import { defaultSymmetry, type SymmetrySettings } from '@/symmetry/symmetry'
import {
  defaultBlobOptions,
  defaultSplatOptions,
  type BlobOptions,
  type SplatOptions,
} from '@/tools/shapes'

export type ToolId =
  | 'select'
  | 'stroke'
  | 'fill'
  | 'splat'
  | 'blob'
  | 'grab'
  | 'erase'
  | 'symmetry'

export interface PhysicsSettings {
  running: boolean
  gravityX: number
  gravityY: number
  windX: number
  windY: number
  drag: number
  attraction: number
  attractionRange: number
  iterations: number
  collisions: boolean
  container: boolean
}

export const defaultPhysicsSettings = (): PhysicsSettings => ({
  running: false,
  gravityX: 0,
  gravityY: 1400,
  windX: 0,
  windY: 0,
  drag: 0.08,
  attraction: 0,
  attractionRange: 420,
  iterations: 5,
  collisions: true,
  container: false,
})

export interface LiquidSettings {
  /** Draw the implicit-surface layer at all. */
  visible: boolean
  /** New objects join the field automatically. */
  autoJoin: boolean
  style: FieldStyle
  /** Field resolution scale, 0.3..1. Lower is faster. */
  resolution: number
}

export const defaultLiquidSettings = (): LiquidSettings => ({
  visible: true,
  autoJoin: false,
  style: defaultFieldStyle(),
  resolution: 0.6,
})

export interface Stats {
  fps: number
  frameMs: number
  objects: number
  drawn: number
  sources: number
  particles: number
  bodies: number
  /** Whether the live stroke is reading genuine stylus pressure. */
  realPressure: boolean
}

export interface AppState {
  tool: ToolId
  color: string
  opacity: number
  blend: BlendMode
  /** Depth assigned to new objects. */
  z: number

  brush: StrokeOptions
  splat: SplatOptions
  blob: BlobOptions
  pressureTarget: PressureTarget

  symmetry: SymmetrySettings
  physics: PhysicsSettings
  liquid: LiquidSettings

  showGrid: boolean
  showParticles: boolean
  showStats: boolean

  selection: Id[]
  canUndo: boolean
  canRedo: boolean
  stats: Stats
  /** Non-fatal notice, e.g. the GPU field being unavailable. */
  notice: string | null

  setTool: (tool: ToolId) => void
  setColor: (color: string) => void
  patch: (patch: Partial<AppState>) => void
  patchBrush: (patch: Partial<StrokeOptions>) => void
  patchSplat: (patch: Partial<SplatOptions>) => void
  patchBlob: (patch: Partial<BlobOptions>) => void
  patchSymmetry: (patch: Partial<SymmetrySettings>) => void
  patchPhysics: (patch: Partial<PhysicsSettings>) => void
  patchLiquid: (patch: Partial<LiquidSettings>) => void
  patchFieldStyle: (patch: Partial<FieldStyle>) => void
  setSelection: (ids: Id[]) => void
  setStats: (stats: Partial<Stats>) => void
}

/**
 * UI state.
 *
 * The document itself is deliberately *not* here. Scene geometry changes on
 * every pointer sample, and pushing that through React would re-render the
 * whole interface a few hundred times a second. The editor owns the document
 * and drives the canvas imperatively; this store carries only what the panels
 * need to display.
 */
export const useStore = create<AppState>((set) => ({
  tool: 'stroke',
  color: '#e8e6e1',
  opacity: 1,
  blend: 'normal',
  z: 0,

  brush: defaultStrokeOptions(),
  splat: defaultSplatOptions(),
  blob: defaultBlobOptions(),
  pressureTarget: 'width',

  symmetry: defaultSymmetry(),
  physics: defaultPhysicsSettings(),
  liquid: defaultLiquidSettings(),

  showGrid: true,
  showParticles: false,
  showStats: true,

  selection: [],
  canUndo: false,
  canRedo: false,
  stats: {
    fps: 0,
    frameMs: 0,
    objects: 0,
    drawn: 0,
    sources: 0,
    particles: 0,
    bodies: 0,
    realPressure: false,
  },
  notice: null,

  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  patch: (patch) => set(patch as Partial<AppState>),
  patchBrush: (patch) =>
    set((s) => ({ brush: { ...s.brush, ...patch } })),
  patchSplat: (patch) => set((s) => ({ splat: { ...s.splat, ...patch } })),
  patchBlob: (patch) => set((s) => ({ blob: { ...s.blob, ...patch } })),
  patchSymmetry: (patch) =>
    set((s) => ({ symmetry: { ...s.symmetry, ...patch } })),
  patchPhysics: (patch) =>
    set((s) => ({ physics: { ...s.physics, ...patch } })),
  patchLiquid: (patch) => set((s) => ({ liquid: { ...s.liquid, ...patch } })),
  patchFieldStyle: (patch) =>
    set((s) => ({
      liquid: { ...s.liquid, style: { ...s.liquid.style, ...patch } },
    })),
  setSelection: (selection) => set({ selection }),
  setStats: (stats) => set((s) => ({ stats: { ...s.stats, ...stats } })),
}))
