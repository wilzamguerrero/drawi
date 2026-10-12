import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await p.goto('http://localhost:5180/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'object', grid: { enabled: true, opacity: 0.6 }, shadow: { enabled: true, opacity: 0.55, softness: 0.3, color: '#000000', extent: 1200, resolution: 2048 } })
  ed.insertPrimitive('box'); const id = ed.state.selectedObject.id
  ed.doc.updateObject3D(id, { color: '#89b' }); ed.doc.setObjectTransform(id, { position: { x: 0, y: 120, z: 0 }, rotation: { x: 0, y: 0.3, z: 0 }, scale: { x: 1.4, y: 1.4, z: 1.4 } })
  const key = ed.doc.lights3d.find(l => l.kind !== 'ambient')
  if (key) ed.doc.updateLight3D(key.id, { x: 0.5, y: 0.75, z: 0.25, enabled: true })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0.4; ed.viewport3d.camera.pitch = 0.55; ed.viewport3d.camera.distance = 1000
  ed.selectObject3D(null); ed.touchSpace()
})
// Contar pixeles de sombra en el suelo (gris medio), para cada resolucion
const darkFloor = () => p.evaluate(() => new Promise((res) => {
  const run = () => {
    const c = document.querySelector('canvas.layer-3d'); const t = document.createElement('canvas'); t.width = c.width; t.height = c.height
    const x = t.getContext('2d'); x.drawImage(c, 0, 0); const W = t.width; const d = x.getImageData(0, 0, t.width, t.height).data
    let dark = 0
    for (let y = (t.height * 0.4) | 0; y < t.height; y++) for (let xx = 0; xx < W; xx++) { const i = (y * W + xx) * 4; if (d[i + 3] > 8) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; if (l > 90 && l < 215) dark++ } }
    res(dark)
  }
  requestAnimationFrame(() => requestAnimationFrame(run))
}))
for (const r of [1024, 2048, 4096]) {
  await p.evaluate((res) => window.__drawiEditor.setScene3D({ shadow: { ...window.__drawiEditor.state.scene3dSettings.shadow, resolution: res } }), r)
  await new Promise(t => setTimeout(t, 600))
  console.log('resolucion', r, '-> pixeles de sombra en suelo:', await darkFloor())
  await p.screenshot({ path: `.diag/res-${r}.png` })
}
console.log('errs', errs.length, errs.slice(0,2).join(' | '))
await b.close()
