import { useReducer } from 'react'
import type { Behavior, SceneObject } from '@/scene/types'
import { useStore } from '@/state/store'
import { MAX_RADIAL } from '@/symmetry/symmetry'
import type { PressureTarget } from '@/stroke/types'
import {
  ColorPicker,
  Section,
  Segmented,
  Slider,
  Toggle,
  hexToRgb,
  rgbToHex,
} from './controls'
import { useEditor } from './editor-context'

const PRESSURE_TARGETS: Array<{ value: PressureTarget; label: string }> = [
  { value: 'width', label: 'Width' },
  { value: 'opacity', label: 'Opacity' },
  { value: 'mass', label: 'Mass' },
  { value: 'elasticity', label: 'Elastic' },
  { value: 'density', label: 'Density' },
  { value: 'force', label: 'Force' },
  { value: 'scatter', label: 'Reach' },
]

const BEHAVIORS: Array<{ value: Behavior; label: string; title: string }> = [
  { value: 'static', label: 'Static', title: 'No simulation' },
  { value: 'rope', label: 'Rope', title: 'A chain that hangs and swings' },
  { value: 'soft', label: 'Soft', title: 'An inflated deformable body' },
  { value: 'rigid', label: 'Rigid', title: 'Holds its shape while it moves' },
]

export const Inspector = () => {
  const editor = useEditor()
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const tool = useStore((s) => s.tool)
  const color = useStore((s) => s.color)
  const opacity = useStore((s) => s.opacity)
  const blend = useStore((s) => s.blend)
  const z = useStore((s) => s.z)
  const brush = useStore((s) => s.brush)
  const splat = useStore((s) => s.splat)
  const blob = useStore((s) => s.blob)
  const pressureTarget = useStore((s) => s.pressureTarget)
  const symmetry = useStore((s) => s.symmetry)
  const physics = useStore((s) => s.physics)
  const liquid = useStore((s) => s.liquid)
  const showGrid = useStore((s) => s.showGrid)
  const showParticles = useStore((s) => s.showParticles)
  const selection = useStore((s) => s.selection)

  const setColor = useStore((s) => s.setColor)
  const patch = useStore((s) => s.patch)
  const patchBrush = useStore((s) => s.patchBrush)
  const patchSplat = useStore((s) => s.patchSplat)
  const patchBlob = useStore((s) => s.patchBlob)
  const patchSymmetry = useStore((s) => s.patchSymmetry)
  const patchPhysics = useStore((s) => s.patchPhysics)
  const patchLiquid = useStore((s) => s.patchLiquid)
  const patchFieldStyle = useStore((s) => s.patchFieldStyle)

  const selected: SceneObject[] = selection
    .map((id) => editor.doc.get(id))
    .filter((o): o is SceneObject => Boolean(o))
  const primary = selected[0]

  /** Writes a property to every selected object and refreshes the panel. */
  const editSelection = (mutate: (object: SceneObject) => void): void => {
    for (const object of selected) {
      mutate(object)
      object.revision += 1
      editor.doc.reindex(object.id)
    }
    editor.physics.sync(editor.doc)
    bump()
  }

  const isBrushTool = tool === 'stroke' || tool === 'fill' || tool === 'erase'

  return (
    <aside className="inspector">
      <Section title="Appearance">
        <ColorPicker value={color} onChange={setColor} />
        <Slider
          label="Opacity"
          value={opacity}
          min={0.02}
          max={1}
          onChange={(v) => patch({ opacity: v })}
        />
        <Segmented
          label="Blend"
          value={blend}
          options={[
            { value: 'normal', label: 'Norm' },
            { value: 'multiply', label: 'Mult' },
            { value: 'screen', label: 'Scrn' },
            { value: 'add', label: 'Add' },
          ]}
          onChange={(v) => patch({ blend: v })}
        />
        <Slider
          label="Depth Z"
          value={z}
          min={-600}
          max={600}
          step={10}
          precision={0}
          onChange={(v) => patch({ z: v })}
        />
        <p className="hint">
          Depth orders the stack and drives parallax when the camera tilts.
        </p>
      </Section>

      {isBrushTool && (
        <Section title="Brush">
          <Slider
            label="Size"
            value={brush.size}
            min={1}
            max={220}
            step={0.5}
            precision={1}
            onChange={(v) => patchBrush({ size: v })}
          />
          <Slider
            label="Thinning"
            value={brush.thinning}
            min={-1}
            max={1}
            onChange={(v) => patchBrush({ thinning: v })}
          />
          <Slider
            label="Streamline"
            value={brush.streamline}
            min={0}
            max={0.95}
            onChange={(v) => patchBrush({ streamline: v })}
          />
          <Slider
            label="Smoothing"
            value={brush.smoothing}
            min={0}
            max={1}
            onChange={(v) => patchBrush({ smoothing: v })}
          />
          <Slider
            label="Taper in"
            value={typeof brush.taperStart === 'number' ? brush.taperStart : 0}
            min={0}
            max={200}
            step={1}
            precision={0}
            onChange={(v) => patchBrush({ taperStart: v })}
          />
          <Slider
            label="Taper out"
            value={typeof brush.taperEnd === 'number' ? brush.taperEnd : 0}
            min={0}
            max={200}
            step={1}
            precision={0}
            onChange={(v) => patchBrush({ taperEnd: v })}
          />
          <Slider
            label="Irregular"
            value={brush.irregularity}
            min={0}
            max={1}
            onChange={(v) => patchBrush({ irregularity: v })}
          />
          <Slider
            label="Grain"
            value={brush.irregularityScale}
            min={4}
            max={160}
            step={1}
            precision={0}
            onChange={(v) => patchBrush({ irregularityScale: v })}
          />
          <Slider
            label="Tilt nib"
            value={brush.tiltInfluence}
            min={0}
            max={1}
            onChange={(v) => patchBrush({ tiltInfluence: v })}
          />
          <p className="hint">
            Irregularity modulates each side of the contour independently, so an
            edge breaks up instead of wobbling symmetrically.
          </p>
        </Section>
      )}

      <Section title="Pressure">
        <Segmented
          label="Source"
          value={brush.pressureSource}
          options={[
            { value: 'auto', label: 'Auto', title: 'Pen when present, speed otherwise' },
            { value: 'pen', label: 'Pen' },
            { value: 'velocity', label: 'Speed' },
            { value: 'constant', label: 'Flat' },
          ]}
          onChange={(v) => patchBrush({ pressureSource: v })}
        />
        <Slider
          label="Curve"
          value={brush.pressureCurve}
          min={0.3}
          max={3}
          onChange={(v) => patchBrush({ pressureCurve: v })}
        />
        <Slider
          label="Speed max"
          value={brush.velocityMax}
          min={0.2}
          max={6}
          onChange={(v) => patchBrush({ velocityMax: v })}
        />
        <div className="row">
          <label>Drives</label>
          <div />
        </div>
        <Segmented
          value={pressureTarget}
          options={PRESSURE_TARGETS.slice(0, 4)}
          onChange={(v) => patch({ pressureTarget: v })}
        />
        <Segmented
          value={pressureTarget}
          options={PRESSURE_TARGETS.slice(4)}
          onChange={(v) => patch({ pressureTarget: v })}
        />
        <p className="hint">
          Width is always affected. This picks what else the pressure of a
          stroke becomes once it is a physical object.
        </p>
      </Section>

      {tool === 'splat' && (
        <Section title="Splat">
          <Slider
            label="Size"
            value={splat.size}
            min={4}
            max={200}
            step={1}
            precision={0}
            onChange={(v) => patchSplat({ size: v })}
          />
          <Slider
            label="Droplets"
            value={splat.count}
            min={0}
            max={40}
            step={1}
            precision={0}
            onChange={(v) => patchSplat({ count: v })}
          />
          <Slider
            label="Scatter"
            value={splat.scatter}
            min={0.2}
            max={5}
            onChange={(v) => patchSplat({ scatter: v })}
          />
          <Slider
            label="Throw"
            value={splat.elongation}
            min={0}
            max={1}
            onChange={(v) => patchSplat({ elongation: v })}
          />
          <Slider
            label="Irregular"
            value={splat.irregularity}
            min={0}
            max={1}
            onChange={(v) => patchSplat({ irregularity: v })}
          />
          <Slider
            label="Merge"
            value={splat.smoothness}
            min={1}
            max={60}
            step={0.5}
            precision={1}
            onChange={(v) => patchSplat({ smoothness: v })}
          />
          <p className="hint">
            Droplets are fused through the same implicit field the liquid layer
            uses, then traced back into a real outline.
          </p>
        </Section>
      )}

      {tool === 'blob' && (
        <Section title="Blob">
          <Slider
            label="Radius"
            value={blob.radius}
            min={6}
            max={400}
            step={1}
            precision={0}
            onChange={(v) => patchBlob({ radius: v })}
          />
          <Slider
            label="Points"
            value={blob.segments}
            min={12}
            max={220}
            step={1}
            precision={0}
            onChange={(v) => patchBlob({ segments: v })}
          />
          <Slider
            label="Wobble"
            value={blob.wobble}
            min={0}
            max={0.8}
            onChange={(v) => patchBlob({ wobble: v })}
          />
          <Slider
            label="Frequency"
            value={blob.wobbleScale}
            min={0.5}
            max={9}
            onChange={(v) => patchBlob({ wobbleScale: v })}
          />
          <Slider
            label="Squash"
            value={blob.squash}
            min={0.2}
            max={3}
            onChange={(v) => patchBlob({ squash: v })}
          />
          <p className="hint">Drag after placing to set scale and rotation.</p>
        </Section>
      )}

      <Section title="Symmetry">
        <Toggle
          label="Enabled"
          value={symmetry.enabled}
          onChange={(v) => patchSymmetry({ enabled: v })}
        />
        <Toggle
          label="Mirror"
          value={symmetry.mirror}
          onChange={(v) => patchSymmetry({ mirror: v })}
        />
        <Toggle
          label="Cross"
          value={symmetry.mirrorPerpendicular}
          onChange={(v) => patchSymmetry({ mirrorPerpendicular: v })}
        />
        <Slider
          label="Radial"
          value={symmetry.radial}
          min={1}
          max={MAX_RADIAL}
          step={1}
          precision={0}
          onChange={(v) => patchSymmetry({ radial: Math.round(v) })}
        />
        <Slider
          label="Angle"
          value={(symmetry.angle * 180) / Math.PI}
          min={-180}
          max={180}
          step={1}
          precision={0}
          suffix="°"
          onChange={(v) => patchSymmetry({ angle: (v * Math.PI) / 180 })}
        />
        <Toggle
          label="Guides"
          value={symmetry.showGuides}
          onChange={(v) => patchSymmetry({ showGuides: v })}
        />
        <div className="grid2">
          <button
            type="button"
            className="btn"
            onClick={() =>
              patchSymmetry({
                originX: editor.camera.x,
                originY: editor.camera.y,
              })
            }
          >
            Centre axis
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => patchSymmetry({ originX: 0, originY: 0, angle: Math.PI / 2 })}
          >
            Reset axis
          </button>
        </div>
        <p className="hint">
          Pick the axis tool (M) and drag on the canvas to move the origin;
          hold Shift while dragging to rotate it.
        </p>
      </Section>

      <Section title={`Matter${selected.length ? ` · ${selected.length}` : ''}`}>
        {!primary && (
          <p className="hint">
            Select something with V to give it behaviour. Every object keeps its
            drawn geometry, so you can always switch back to Static.
          </p>
        )}
        {primary && (
          <>
            <Segmented
              label="Behaviour"
              value={primary.physics.behavior}
              options={BEHAVIORS}
              onChange={(v) => {
                editor.setBehavior(v)
                bump()
              }}
            />
            <Slider
              label="Mass"
              value={primary.physics.mass}
              min={0.05}
              max={8}
              onChange={(v) => editSelection((o) => (o.physics.mass = v))}
            />
            <Slider
              label="Stiffness"
              value={primary.physics.stiffness}
              min={0.02}
              max={1}
              onChange={(v) => editSelection((o) => (o.physics.stiffness = v))}
            />
            <Slider
              label="Damping"
              value={primary.physics.damping}
              min={0}
              max={0.6}
              onChange={(v) => editSelection((o) => (o.physics.damping = v))}
            />
            <Slider
              label="Inflation"
              value={primary.physics.internalPressure}
              min={0}
              max={4}
              onChange={(v) =>
                editSelection((o) => (o.physics.internalPressure = v))
              }
            />
            <Slider
              label="Gravity"
              value={primary.physics.gravityScale}
              min={-2}
              max={3}
              onChange={(v) =>
                editSelection((o) => (o.physics.gravityScale = v))
              }
            />
            <div className="grid2">
              <button
                type="button"
                className="btn"
                title="Pin the first particle so the body hangs from it"
                onClick={() =>
                  editSelection((o) => {
                    o.physics.pinned = o.physics.pinned.length > 0 ? [] : [0]
                  })
                }
              >
                {primary.physics.pinned.length > 0 ? 'Unpin' : 'Pin end'}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => editor.deleteSelection()}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </Section>

      <Section title="Liquid">
        <Toggle
          label="Show layer"
          value={liquid.visible}
          onChange={(v) => patchLiquid({ visible: v })}
        />
        <Toggle
          label="Auto join"
          value={liquid.autoJoin}
          onChange={(v) => patchLiquid({ autoJoin: v })}
        />
        <Slider
          label="Threshold"
          value={liquid.style.iso}
          min={0.08}
          max={1.2}
          onChange={(v) => patchFieldStyle({ iso: v })}
        />
        <Slider
          label="Shading"
          value={liquid.style.shading}
          min={0}
          max={1}
          onChange={(v) => patchFieldStyle({ shading: v })}
        />
        <Slider
          label="Rim"
          value={liquid.style.rim}
          min={0}
          max={0.6}
          onChange={(v) => patchFieldStyle({ rim: v })}
        />
        <Slider
          label="Quality"
          value={liquid.resolution}
          min={0.3}
          max={1}
          onChange={(v) => patchLiquid({ resolution: v })}
        />
        <div className="row">
          <label>Colour</label>
          <input
            className="color-input"
            type="color"
            value={rgbToHex(liquid.style.color)}
            onChange={(e) =>
              patchFieldStyle({ color: hexToRgb(e.target.value) })
            }
          />
        </div>

        {primary && (
          <>
            <Toggle
              label="In field"
              value={primary.field.enabled}
              onChange={(v) => {
                editor.toggleField(v)
                bump()
              }}
            />
            <Slider
              label="Reach"
              value={primary.field.smoothness}
              min={1}
              max={120}
              step={0.5}
              precision={1}
              onChange={(v) =>
                editSelection((o) => {
                  o.field.smoothness = v
                  o.field.enabled = true
                })
              }
            />
            <Slider
              label="Strength"
              value={primary.field.strength}
              min={0.1}
              max={3}
              onChange={(v) =>
                editSelection((o) => (o.field.strength = v))
              }
            />
            <div className="grid2">
              <button
                type="button"
                className={`btn${primary.field.polarity > 0 ? ' active' : ''}`}
                title="This shape adds to the field"
                onClick={() => {
                  editor.setFieldPolarity(1)
                  bump()
                }}
              >
                Fuse
              </button>
              <button
                type="button"
                className={`btn${primary.field.polarity < 0 ? ' active' : ''}`}
                title="This shape carves into nearby shapes"
                onClick={() => {
                  editor.setFieldPolarity(-1)
                  bump()
                }}
              >
                Carve
              </button>
            </div>
          </>
        )}
        <p className="hint">
          Shapes in the field fuse or carve purely by proximity — nothing is
          grouped, and moving them apart separates them again.
        </p>
      </Section>

      <Section title="World" defaultOpen={false}>
        <Toggle
          label="Simulate"
          value={physics.running}
          onChange={(v) => patchPhysics({ running: v })}
        />
        <Slider
          label="Gravity"
          value={physics.gravityY}
          min={-3000}
          max={3000}
          step={20}
          precision={0}
          onChange={(v) => patchPhysics({ gravityY: v })}
        />
        <Slider
          label="Sideways"
          value={physics.gravityX}
          min={-2000}
          max={2000}
          step={20}
          precision={0}
          onChange={(v) => patchPhysics({ gravityX: v })}
        />
        <Slider
          label="Wind"
          value={physics.windX}
          min={-2000}
          max={2000}
          step={20}
          precision={0}
          onChange={(v) => patchPhysics({ windX: v })}
        />
        <Slider
          label="Drag"
          value={physics.drag}
          min={0}
          max={0.9}
          onChange={(v) => patchPhysics({ drag: v })}
        />
        <Slider
          label="Attract"
          value={physics.attraction}
          min={-40}
          max={40}
          step={0.5}
          precision={1}
          onChange={(v) => patchPhysics({ attraction: v })}
        />
        <Slider
          label="Reach"
          value={physics.attractionRange}
          min={60}
          max={1600}
          step={10}
          precision={0}
          onChange={(v) => patchPhysics({ attractionRange: v })}
        />
        <Slider
          label="Accuracy"
          value={physics.iterations}
          min={1}
          max={14}
          step={1}
          precision={0}
          onChange={(v) => patchPhysics({ iterations: Math.round(v) })}
        />
        <Toggle
          label="Collisions"
          value={physics.collisions}
          onChange={(v) => patchPhysics({ collisions: v })}
        />
        <Toggle
          label="Walls"
          value={physics.container}
          onChange={(v) => patchPhysics({ container: v })}
        />
        <p className="hint">
          Negative attraction repels. Walls use the current viewport as a box.
        </p>
      </Section>

      <Section title="View" defaultOpen={false}>
        <Toggle
          label="Grid"
          value={showGrid}
          onChange={(v) => patch({ showGrid: v })}
        />
        <Toggle
          label="Particles"
          value={showParticles}
          onChange={(v) => patch({ showParticles: v })}
        />
        <Slider
          label="Tilt X"
          value={editor.camera.tiltX}
          min={-1.2}
          max={1.2}
          onChange={(v) => {
            editor.camera.setTilt(v, editor.camera.tiltY)
            bump()
          }}
        />
        <Slider
          label="Tilt Y"
          value={editor.camera.tiltY}
          min={-1.2}
          max={1.2}
          onChange={(v) => {
            editor.camera.setTilt(editor.camera.tiltX, v)
            bump()
          }}
        />
        <div className="grid2">
          <button type="button" className="btn" onClick={() => editor.frameAll()}>
            Frame all
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              editor.resetView()
              bump()
            }}
          >
            Reset view
          </button>
        </div>
      </Section>
    </aside>
  )
}
