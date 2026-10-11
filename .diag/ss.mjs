import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await p.goto('http://localhost:5178/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
const cx = 620, cy = 300
// Escena: un cubo bajo, luz cenital-oblicua, sombra on + trazos proyectan
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'object', grid: { enabled: true, opacity: 0.6 }, shadow: { enabled: true, opacity: 0.5, softness: 0.3 }, strokeShadow: true })
  ed.insertPrimitive('box')
  const id = ed.state.selectedObject.id
  ed.doc.updateObject3D(id, { color: '#8090b0' })
  ed.doc.setObjectTransform(id, { position: { x: 220, y: 90, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.4, y: 1.4, z: 1.4 } })
  const key = ed.doc.lights3d.find(l => l.kind !== 'ambient')
  if (key) ed.doc.updateLight3D(key.id, { x: 0.3, y: 0.9, z: 0.25, enabled: true })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0.4; ed.viewport3d.camera.pitch = 0.75; ed.viewport3d.camera.distance = 1000
  ed.selectObject3D(null); ed.touchSpace()
})
await new Promise(r => setTimeout(r, 400))
// Trazo vertical elevado para que su sombra caiga en el suelo
await p.evaluate(() => { const ed = window.__drawiEditor; ed.setScene3D({ tool: 'brush' }) })
await new Promise(r => setTimeout(r, 150))
await p.mouse.move(cx - 150, cy)
await p.mouse.down()
for (let i = 1; i <= 20; i++) await p.mouse.move(cx - 150, cy + i * 10)
await p.mouse.up()
await new Promise(r => setTimeout(r, 500))
await p.screenshot({ path: '.diag/ss-on.png' })
await p.evaluate(() => window.__drawiEditor.setScene3D({ strokeShadow: false }))
await new Promise(r => setTimeout(r, 400))
await p.screenshot({ path: '.diag/ss-off.png' })
console.log('errs', errs.length, errs.slice(0, 3).join(' | '))
await b.close()
