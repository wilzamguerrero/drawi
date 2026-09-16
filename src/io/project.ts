import { seedIdCounter, type Id } from '@/core/id'
import { objectMatrix } from '@/scene/object'
import { SceneDocument } from '@/scene/document'
import { createObject, geometryFromRing } from '@/scene/object'
import {
  defaultField,
  defaultPhysics,
  defaultStyle,
  defaultTransform,
  type Layer,
  type SceneObject,
} from '@/scene/types'
import { boundsHeight, boundsWidth, type Bounds } from '@/stroke/types'
import { Camera } from '@/render/camera'
import { SceneRenderer } from '@/render/scene-renderer'

/**
 * Document I/O.
 *
 * The project format is the document's own structures with typed arrays turned
 * into plain number arrays — no separate schema to drift out of sync. SVG and
 * PNG are derived views: a stroke exports as the outline it already is, so the
 * vector export is the same geometry the app draws rather than a trace of a
 * bitmap.
 */

const FORMAT = 'drawi/1'

interface SerializedObject {
  id: Id
  kind: SceneObject['kind']
  name: string
  layerId: Id
  outline: number[]
  spine: number[]
  closed: boolean
  transform: SceneObject['transform']
  style: SceneObject['style']
  physics: SceneObject['physics']
  field: SceneObject['field']
  seed: number
  visible: boolean
  locked: boolean
}

interface SerializedDocument {
  format: string
  layers: Layer[]
  order: Id[]
  objects: SerializedObject[]
  camera: { x: number; y: number; zoom: number; tiltX: number; tiltY: number }
}

export const serialize = (doc: SceneDocument, camera: Camera): string => {
  const objects: SerializedObject[] = []
  for (const id of doc.order) {
    const o = doc.get(id)
    if (!o) continue
    objects.push({
      id: o.id,
      kind: o.kind,
      name: o.name,
      layerId: o.layerId,
      outline: Array.from(o.geometry.outline.subarray(0, o.geometry.outlineCount * 2)),
      spine: Array.from(o.geometry.spine.subarray(0, o.geometry.spineCount * 4)),
      closed: o.geometry.closed,
      transform: { ...o.transform },
      style: { ...o.style },
      physics: { ...o.physics, pinned: [...o.physics.pinned] },
      field: { ...o.field },
      seed: o.seed,
      visible: o.visible,
      locked: o.locked,
    })
  }

  const payload: SerializedDocument = {
    format: FORMAT,
    layers: doc.layers.map((l) => ({ ...l })),
    order: [...doc.order],
    objects,
    camera: {
      x: camera.x,
      y: camera.y,
      zoom: camera.zoom,
      tiltX: camera.tiltX,
      tiltY: camera.tiltY,
    },
  }
  return JSON.stringify(payload)
}

export const deserialize = (
  json: string,
  camera?: Camera
): SceneDocument => {
  const payload = JSON.parse(json) as SerializedDocument
  if (!payload || payload.format !== FORMAT) {
    throw new Error('Unrecognised project file')
  }

  const doc = new SceneDocument()
  doc.layers.length = 0
  for (const layer of payload.layers) doc.layers.push({ ...layer })
  if (doc.layers.length === 0) doc.addLayer('Layer 1')

  let highestCounter = 0
  for (const s of payload.objects) {
    const outline = new Float32Array(s.outline)
    const geometry = geometryFromRing(
      outline,
      outline.length / 2,
      new Float32Array(s.spine),
      s.spine.length / 4,
      s.closed
    )
    const object = createObject({
      kind: s.kind,
      layerId: s.layerId,
      geometry,
      seed: s.seed,
      name: s.name,
    })
    object.id = s.id
    object.transform = { ...defaultTransform(), ...s.transform }
    object.style = { ...defaultStyle(), ...s.style }
    object.physics = { ...defaultPhysics(), ...s.physics }
    object.field = { ...defaultField(), ...s.field }
    object.visible = s.visible
    object.locked = s.locked
    object.revision += 1
    doc.add(object)

    const match = /_([0-9a-z]+)_/.exec(s.id)
    if (match) highestCounter = Math.max(highestCounter, parseInt(match[1], 36))
  }
  seedIdCounter(highestCounter + 1)

  // Restore the authored paint order.
  doc.order.length = 0
  for (const id of payload.order) {
    if (doc.objects.has(id)) doc.order.push(id)
  }
  for (const id of doc.objects.keys()) {
    if (!doc.order.includes(id)) doc.order.push(id)
  }
  doc.revision += 1

  if (camera && payload.camera) {
    camera.setPan(payload.camera.x, payload.camera.y)
    camera.setZoom(payload.camera.zoom)
    camera.setTilt(payload.camera.tiltX, payload.camera.tiltY)
  }
  return doc
}

const pathData = (o: SceneObject, precision = 2): string => {
  const g = o.geometry
  if (g.outlineCount < 2) return ''
  const parts: string[] = []
  for (let i = 0; i < g.outlineCount; i++) {
    const x = g.outline[i * 2].toFixed(precision)
    const y = g.outline[i * 2 + 1].toFixed(precision)
    parts.push(`${i === 0 ? 'M' : 'L'}${x} ${y}`)
  }
  parts.push('Z')
  return parts.join('')
}

const matrixAttr = (o: SceneObject): string => {
  const m = objectMatrix(o)
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0) {
    return ''
  }
  return ` transform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})"`
}

export const toSVG = (
  doc: SceneDocument,
  bounds: Bounds,
  background?: string
): string => {
  const pad = 16
  const width = Math.max(1, boundsWidth(bounds) + pad * 2)
  const height = Math.max(1, boundsHeight(bounds) + pad * 2)
  const minX = bounds.minX - pad
  const minY = bounds.minY - pad

  const body: string[] = []
  if (background) {
    body.push(
      `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${background}"/>`
    )
  }

  for (const o of doc.renderList()) {
    if (!o.visible) continue
    const layer = doc.layers.find((l) => l.id === o.layerId)
    if (layer && !layer.visible) continue
    const d = pathData(o)
    if (!d) continue
    const alpha = o.style.opacity * (layer?.opacity ?? 1)
    const opacity = alpha < 1 ? ` fill-opacity="${alpha.toFixed(3)}"` : ''
    const stroke =
      o.style.outlineWidth > 0
        ? ` stroke="${o.style.outlineColor}" stroke-width="${o.style.outlineWidth}"`
        : ''
    body.push(
      `<path d="${d}" fill="${o.style.color}"${opacity}${stroke}${matrixAttr(o)}/>`
    )
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}">`,
    ...body,
    '</svg>',
  ].join('\n')
}

/**
 * Renders the document to an offscreen canvas framed on `bounds`.
 * Reuses the real renderer, so the export matches the screen exactly.
 */
export const renderToCanvas = (
  doc: SceneDocument,
  bounds: Bounds,
  scale: number,
  background: string,
  showGrid = false
): HTMLCanvasElement => {
  const pad = 16
  const width = Math.max(1, Math.round((boundsWidth(bounds) + pad * 2) * scale))
  const height = Math.max(1, Math.round((boundsHeight(bounds) + pad * 2) * scale))

  const canvas = document.createElement('canvas')
  const renderer = new SceneRenderer(canvas)
  renderer.background = background
  renderer.showGrid = showGrid

  const camera = new Camera()
  camera.resize(width, height, 1)
  camera.setZoom(scale)
  camera.setPan(
    (bounds.minX + bounds.maxX) * 0.5,
    (bounds.minY + bounds.maxY) * 0.5
  )
  renderer.resize(width, height, 1)
  renderer.render(doc, camera, null)
  return canvas
}

export const download = (filename: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const downloadText = (
  filename: string,
  text: string,
  type: string
): void => {
  download(filename, new Blob([text], { type }))
}
