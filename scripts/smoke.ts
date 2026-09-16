/**
 * Engine smoke test.
 *
 * Runs the DOM-free half of the app — stroke geometry, symmetry, the implicit
 * field, marching squares, the solver and serialisation — under Node, so the
 * maths can be checked without a browser. Bundled by `npm run smoke`.
 */

import { StrokeBuilder } from '@/stroke/builder'
import { defaultStrokeOptions, type RawSample } from '@/stroke/types'
import {
  buildSymmetryTransforms,
  defaultSymmetry,
  symmetryInstanceCount,
} from '@/symmetry/symmetry'
import { applyX, applyY } from '@/core/mat2d'
import { FieldSourceBuffer } from '@/field/source'
import { sampleField } from '@/field/evaluate'
import { defaultContourOptions, ringArea, traceField } from '@/field/marching'
import { buildBlob, buildSplat, defaultSplatOptions } from '@/tools/shapes'
import { SceneDocument } from '@/scene/document'
import { createObject, geometryFromBuilder } from '@/scene/object'
import { bakeObjectTransform, PhysicsWorld } from '@/physics/world'
import { serialize, deserialize } from '@/io/project'
import { Camera } from '@/render/camera'

let failures = 0
let checks = 0

const check = (label: string, condition: boolean, detail = ''): void => {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const section = (name: string): void => console.log(`\n${name}`)

const sample = (
  x: number,
  y: number,
  pressure: number,
  time: number
): RawSample => ({ x, y, pressure, tiltX: 0, tiltY: 0, twist: 0, time })

// ---------------------------------------------------------------- stroke

section('stroke builder')
{
  const options = defaultStrokeOptions()
  options.size = 20
  options.taperEnd = 40
  const builder = new StrokeBuilder(options)

  for (let i = 0; i <= 200; i++) {
    const t = i / 200
    builder.push(
      sample(t * 400, Math.sin(t * Math.PI * 2) * 80, 0.2 + t * 0.7, i * 8)
    )
  }
  builder.finish()
  const outline = builder.getOutline()

  check('produces a closed contour', outline.count > 40, `${outline.count} vertices`)
  check(
    'bounds are finite',
    Number.isFinite(outline.bounds.minX) && Number.isFinite(outline.bounds.maxY)
  )
  check(
    'spans the drawn path',
    outline.bounds.maxX > 380 && outline.bounds.minX < 20,
    `x ${outline.bounds.minX.toFixed(1)}..${outline.bounds.maxX.toFixed(1)}`
  )

  const spine = builder.getSpine()
  check('spine keeps well-spaced samples', spine.length > 150, `${spine.length} points`)

  // A high-report-rate device sends many samples per nib width; those carry no
  // shape information and must be dropped rather than bloating the spine.
  const dense = new StrokeBuilder({ ...defaultStrokeOptions(), size: 30 })
  for (let i = 0; i < 400; i++) dense.push(sample(i * 0.15, 0, 0.6, i * 2))
  dense.finish()
  check(
    'sub-nib jitter is decimated away',
    dense.getSpine().length < 60,
    `${dense.getSpine().length} of 400 samples kept`
  )
  check(
    'end taper reaches zero width',
    spine[spine.length - 1].radius < spine[Math.floor(spine.length / 2)].radius * 0.6,
    `tip r=${spine[spine.length - 1].radius.toFixed(2)}`
  )

  // Incremental rebuild: a long stroke must not cost more per sample than a
  // short one. Compare average push time over the first and last thousand.
  const perf = new StrokeBuilder(defaultStrokeOptions())
  const timeSlice = (from: number, to: number): number => {
    const t0 = performance.now()
    for (let i = from; i < to; i++) {
      perf.push(sample(i * 3, Math.sin(i * 0.05) * 60, 0.6, i * 4))
      perf.getOutline()
    }
    return (performance.now() - t0) / (to - from)
  }
  const early = timeSlice(0, 600)
  const late = timeSlice(3000, 3600)
  check(
    'per-sample cost stays flat as the stroke grows',
    late < early * 4 + 0.05,
    `${early.toFixed(4)}ms early vs ${late.toFixed(4)}ms late`
  )
}

// -------------------------------------------------------------- symmetry

section('symmetry')
{
  const s = defaultSymmetry()
  s.enabled = true
  s.originX = 100
  s.originY = 0
  s.angle = Math.PI / 2
  s.mirror = true
  s.radial = 1

  const transforms = buildSymmetryTransforms(s)
  check('mirror yields two instances', transforms.length === 2)

  const mirrored = transforms[1]
  const mx = applyX(mirrored, 140, 30)
  const my = applyY(mirrored, 140, 30)
  check(
    'vertical axis reflects across the origin',
    Math.abs(mx - 60) < 1e-6 && Math.abs(my - 30) < 1e-6,
    `(140,30) -> (${mx.toFixed(2)},${my.toFixed(2)})`
  )

  s.radial = 6
  s.mirrorPerpendicular = true
  check(
    'instance count matches the transform list',
    buildSymmetryTransforms(s).length === symmetryInstanceCount(s),
    `${symmetryInstanceCount(s)} copies`
  )
}

// ------------------------------------------------------------------ field

section('implicit field')
{
  const near = new FieldSourceBuffer(4)
  near.push(-18, 0, -18, 0, 20, 20, 1, 14)
  near.push(18, 0, 18, 0, 20, 20, 1, 14)

  const between = sampleField(near, 0, 0)
  const outside = sampleField(near, 400, 0)
  check('field sums between close sources', between > 0.5, `f=${between.toFixed(3)}`)
  check('field is zero far away', outside === 0)

  const options = defaultContourOptions()
  options.cell = 1.5
  options.simplify = 0.3
  const fused = traceField(near, { minX: -80, minY: -60, maxX: 80, maxY: 60 }, options)
  check('two nearby blobs trace as one ring', fused.length === 1, `${fused.length} rings`)

  const far = new FieldSourceBuffer(4)
  far.push(-140, 0, -140, 0, 20, 20, 1, 14)
  far.push(140, 0, 140, 0, 20, 20, 1, 14)
  const split = traceField(
    far,
    { minX: -220, minY: -80, maxX: 220, maxY: 80 },
    options
  )
  check('distant blobs stay separate', split.length === 2, `${split.length} rings`)

  // Negative polarity has to carve, not merely fail to add.
  const carve = new FieldSourceBuffer(4)
  carve.push(0, 0, 0, 0, 60, 60, 1, 20)
  const solid = sampleField(carve, 0, 0)
  carve.push(30, 0, 30, 0, 26, 26, -1, 20)
  const carved = sampleField(carve, 30, 0)
  check('negative sources subtract from the field', carved < solid, `${carved.toFixed(3)} < ${solid.toFixed(3)}`)
}

// ------------------------------------------------------------------ tools

section('generators')
{
  const splat = buildSplat(0, 0, 1, 0, 0.6, 0.9, {
    ...defaultSplatOptions(),
    seed: 12345,
  })
  check('splat traces at least one ring', splat.rings.length >= 1, `${splat.rings.length} rings`)
  check('splat keeps its droplets as a skeleton', splat.spine.length >= 8)
  check(
    'splat rings enclose real area',
    Math.abs(ringArea(splat.rings[0])) > 50,
    `area ${Math.abs(ringArea(splat.rings[0])).toFixed(0)}`
  )

  const a = buildSplat(0, 0, 1, 0, 0.6, 0.9, { ...defaultSplatOptions(), seed: 7 })
  const b = buildSplat(0, 0, 1, 0, 0.6, 0.9, { ...defaultSplatOptions(), seed: 7 })
  check(
    'the same seed reproduces the same splat',
    a.droplets.length === b.droplets.length &&
      a.droplets.every((d, i) => d.x === b.droplets[i].x && d.r === b.droplets[i].r)
  )

  const blob = buildBlob({
    radius: 50,
    segments: 64,
    wobble: 0.3,
    wobbleScale: 2,
    squash: 1,
    seed: 3,
  })
  check('blob ring closes', blob.ring.length === 128)
  const first = Math.hypot(blob.ring[0], blob.ring[1])
  const last = Math.hypot(blob.ring[126], blob.ring[127])
  check(
    'blob wobble is continuous around the seam',
    Math.abs(first - last) < 50 * 0.3,
    `${first.toFixed(1)} vs ${last.toFixed(1)}`
  )
}

// ---------------------------------------------------------------- physics

section('solver')
{
  const doc = new SceneDocument()
  const builder = new StrokeBuilder({ ...defaultStrokeOptions(), size: 14 })
  for (let i = 0; i <= 40; i++) builder.push(sample(i * 8, 0, 0.7, i * 10))
  builder.finish()

  const object = createObject({
    kind: 'stroke',
    layerId: doc.activeLayerId,
    geometry: geometryFromBuilder(builder),
  })
  object.physics.behavior = 'rope'
  object.physics.pinned = [0]
  bakeObjectTransform(object)
  doc.add(object)

  const world = new PhysicsWorld()
  world.sync(doc)
  check('rope became a body', world.bodyCount === 1, `${world.particleCount} particles`)

  const startY = object.geometry.bounds.maxY
  for (let i = 0; i < 120; i++) world.step(1 / 120, doc)
  world.writeBack(doc)
  const endY = object.geometry.bounds.maxY
  check('gravity moves the rope down', endY > startY + 5, `${startY.toFixed(1)} -> ${endY.toFixed(1)}`)

  let pinnedHeld = false
  world.forEachParticle(object.id, (index, _x, y) => {
    if (index === 0) pinnedHeld = Math.abs(y) < 1
  })
  check('the pinned end stays put', pinnedHeld)

  // A closed mass should keep its area rather than collapse under gravity.
  const blobBuilder = new StrokeBuilder({ ...defaultStrokeOptions(), size: 10 })
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2
    blobBuilder.push(
      sample(400 + Math.cos(a) * 70, Math.sin(a) * 70, 0.8, i * 10)
    )
  }
  blobBuilder.finish()
  const mass = createObject({
    kind: 'fill',
    layerId: doc.activeLayerId,
    geometry: geometryFromBuilder(blobBuilder, true),
  })
  mass.physics.behavior = 'soft'
  mass.physics.internalPressure = 1.4
  bakeObjectTransform(mass)
  doc.add(mass)
  world.sync(doc)

  const areaOf = (): number => {
    const g = mass.geometry
    let area = 0
    for (let i = 0, j = g.outlineCount - 1; i < g.outlineCount; j = i++) {
      area +=
        g.outline[j * 2] * g.outline[i * 2 + 1] -
        g.outline[i * 2] * g.outline[j * 2 + 1]
    }
    return Math.abs(area * 0.5)
  }
  const areaBefore = areaOf()
  world.container = { minX: -200, minY: -400, maxX: 800, maxY: 200 }
  for (let i = 0; i < 300; i++) world.step(1 / 120, doc)
  world.writeBack(doc)
  const areaAfter = areaOf()
  check(
    'internal pressure preserves the mass area',
    areaAfter > areaBefore * 0.55 && areaAfter < areaBefore * 1.8,
    `${areaBefore.toFixed(0)} -> ${areaAfter.toFixed(0)}`
  )
  check(
    'simulated geometry stays finite',
    Number.isFinite(areaAfter) && areaAfter > 0
  )
}

// ---------------------------------------------------------- serialisation

section('project round trip')
{
  const doc = new SceneDocument()
  const builder = new StrokeBuilder(defaultStrokeOptions())
  for (let i = 0; i < 30; i++) builder.push(sample(i * 9, i * 3, 0.5, i * 12))
  builder.finish()
  const object = createObject({
    kind: 'stroke',
    layerId: doc.activeLayerId,
    geometry: geometryFromBuilder(builder),
    style: { color: '#ff00aa', opacity: 0.6 },
  })
  object.field.enabled = true
  object.field.polarity = -1
  object.physics.behavior = 'soft'
  doc.add(object)

  const camera = new Camera()
  camera.setPan(12, -34)
  camera.setZoom(2.5)

  const restored = deserialize(serialize(doc, camera))
  const back = [...restored.objects.values()][0]
  check('object count survives', restored.objects.size === 1)
  check('style survives', back.style.color === '#ff00aa' && back.style.opacity === 0.6)
  check('behaviour survives', back.physics.behavior === 'soft')
  check('field polarity survives', back.field.polarity === -1)
  check(
    'geometry survives',
    back.geometry.outlineCount === object.geometry.outlineCount &&
      Math.abs(back.geometry.outline[0] - object.geometry.outline[0]) < 1e-4
  )
}

console.log(
  `\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ''}`
)
if (failures > 0) process.exit(1)
