# drawi

A 2.5D visual creation lab. You draw; what you drew becomes matter.

Not another illustration editor: a stroke here keeps its pressure, its skeleton
and its seed, so the same mark can be a line, a rope, an inflated body or a drop
of liquid — and go back to being an editable outline afterwards. Nothing is
rasterised, and nothing is consumed by the simulation.

```
DRAW  →  TRANSFORM  →  SIMULATE  →  VECTORIZE  →  EXPORT
```

## Running it

```bash
npm install
npm run dev        # http://localhost:5180
npm run build
npm run typecheck
npm run smoke      # runs the DOM-free engine checks under Node
```

## What is here

**Drawing.** A streaming stroke engine in the spirit of `perfect-freehand`, but
incremental: only the taper tail is ever rebuilt, so per-sample cost stays flat
no matter how long the stroke gets. Pointer input recovers coalesced samples
through `pointerrawupdate`, so a 240 Hz tablet is not quietly downsampled to
frame rate.

**Pressure that means something.** With a stylus, real pressure. Without one,
pressure is synthesised from stroke speed — and the model detects mid-session
which case it is in, including drivers that report a frozen `0.5` forever. The
signal is recorded on every point, and you choose what it *drives*: width,
opacity, mass, elasticity, density, gravity or field reach.

**Symmetry.** Mirror, perpendicular mirror and up to 48-fold radial, composable,
with a movable and rotatable axis. It is expressed as affine transforms, so one
stroke is built once and instanced — a 16-fold mandala costs what one stroke
costs, and every copy is exact.

**Splat and fill.** Splat scatters droplets whose size and throw follow pressure
and speed, then traces their contour out of an implicit field — so a splat is a
real editable outline, not a texture. Fill is the same stroke engine with a wide,
flat nib: you paint a mass directly instead of outlining and filling it.

**Liquid.** A GPU implicit-surface layer. Every drawable reduces to swept
circles, so strokes, splats and blobs all fuse with each other. Sources can be
negative, which means a shape can *carve* into its neighbours through the same
proximity blend that fuses them. Vectorize traces the surface back into ordinary
vector objects.

**Physics.** One Position Based Dynamics model with different coefficients:
distance constraints, an internal pressure term and shape matching. A rope is
that model with no area term; a jelly turns both partway up; a rigid body is
shape matching at full strength. Behaviour switches without a rebuild, and
grabbing a body moves particles directly, so manipulation resolves in the same
frame.

**2.5D.** Every object carries a `z`. Tilting the camera shears the stack —
parallax and a slight scale, with paint order from depth. The projection stays
affine, so a whole depth slice still draws in one `setTransform`.

## Keys

| | |
|---|---|
| `B` `F` `X` `O` | stroke, fill, splat, blob |
| `V` `G` `E` `M` | select, grab, erase, symmetry axis |
| space / middle drag | pan · wheel zooms · two fingers do both |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+S` | save project |
| `Delete` | delete selection |

With the symmetry tool: drag places the axis origin, `Shift`-drag rotates it.

## Structure

```
src/
  core/       maths, 2D transforms, seeded noise, spatial index
  input/      pointer events, coalescing, palm rejection, gestures
  stroke/     pressure model, incremental outline builder, ribbon rebuild
  symmetry/   mirror and radial transform generation
  scene/      document, objects, geometry/transform/style/physics/field
  physics/    PBD solver: ropes, soft bodies, rigid, collisions, attraction
  field/      implicit sources, CPU evaluation, marching squares
  render/     camera, Canvas2D scene renderer, WebGL2 field renderer
  tools/      splat and blob generators
  io/         project JSON, SVG and PNG export
  state/      UI store
  ui/         React panels
  app/        editor orchestration, history
```

The document is deliberately outside React: geometry changes on every pointer
sample, and the store carries only what the panels display.

## Requirements

WebGL2 with `EXT_color_buffer_float` for the liquid layer — without it the app
runs normally and says so in a notice. Everything else is Canvas2D.

## References

Conceptual and technical references, not dependencies: `references/webchemy-master`
for exploratory sketching, symmetry and splat; `references/perfect-freehand-main`
for stroke outlining. Neither is copied; the design brief is in
`references/info.md`.
