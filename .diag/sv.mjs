import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await p.goto('http://localhost:5180/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
// Cilindro + cubo + un cono que proyecta sombra sobre ellos; luz oblicua.
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'object', grid: { enabled: true, opacity: 0.6 }, shadow: { enabled: true, opacity: 0.55, softness: 0.3, color: '#000000', extent: 1200, resolution: 2048 } })
  ed.insertPrimitive('cylinder'); const cy = ed.state.selectedObject.id
  ed.doc.updateObject3D(cy, { color: '#7a9' }); ed.doc.setObjectTransform(cy, { position: { x: 120, y: 60, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1.2, z: 1 } })
  ed.insertPrimitive('box'); const bx = ed.state.selectedObject.id
  ed.doc.updateObject3D(bx, { color: '#89b' }); ed.doc.setObjectTransform(bx, { position: { x: -240, y: 300, z: -40 }, rotation: { x: 0, y: 0.3, z: 0 }, scale: { x: 1.6, y: 1.6, z: 1.6 } })
  const key = ed.doc.lights3d.find(l => l.kind !== 'ambient')
  if (key) ed.doc.updateLight3D(key.id, { x: 0.55, y: 0.7, z: 0.2, enabled: true })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0.5; ed.viewport3d.camera.pitch = 0.4; ed.viewport3d.camera.distance = 1200
  ed.selectObject3D(null); ed.touchSpace()
})
await new Promise(r => setTimeout(r, 600))
await p.screenshot({ path: '.diag/sv-objs.png' })
console.log('objetos: errs', errs.length)
// Suavidad: comparar borde a 0 vs 1
await p.evaluate(() => window.__drawiEditor.setScene3D({ shadow: { ...window.__drawiEditor.state.scene3dSettings.shadow, softness: 0 } }))
await new Promise(r => setTimeout(r, 500))
await p.screenshot({ path: '.diag/sv-hard.png' })
await p.evaluate(() => window.__drawiEditor.setScene3D({ shadow: { ...window.__drawiEditor.state.scene3dSettings.shadow, softness: 1 } }))
await new Promise(r => setTimeout(r, 500))
await p.screenshot({ path: '.diag/sv-soft.png' })
console.log('done')
await b.close()
