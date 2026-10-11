import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await p.goto('http://localhost:5179/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'object', grid: { enabled: true, opacity: 0.6 }, shadow: { enabled: true, opacity: 0.6, softness: 0.3, color: '#1a2340', extent: 1200, resolution: 2048 } })
  ed.insertPrimitive('box')
  const id = ed.state.selectedObject.id
  ed.doc.updateObject3D(id, { color: '#8090b0' })
  ed.doc.setObjectTransform(id, { position: { x: 150, y: 100, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 } })
  const key = ed.doc.lights3d.find(l => l.kind !== 'ambient')
  if (key) ed.doc.updateLight3D(key.id, { x: 0.4, y: 0.85, z: 0.3, enabled: true })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0.4; ed.viewport3d.camera.pitch = 0.8; ed.viewport3d.camera.distance = 950
  ed.selectObject3D(null); ed.touchSpace()
})
await new Promise(r => setTimeout(r, 500))
await p.screenshot({ path: '.diag/col.png' })
// Medir color de la sombra (franja inferior, pixeles oscurecidos no-grises puros)
const tint = await p.evaluate(() => new Promise((res) => {
  const run = () => {
    const c = document.querySelector('canvas.layer-3d')
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height
    const x = t.getContext('2d'); x.drawImage(c, 0, 0); const W = t.width
    const d = x.getImageData(0, 0, t.width, t.height).data
    let rs = 0, gs = 0, bs = 0, n = 0
    for (let y = (t.height * 0.5) | 0; y < t.height; y++) for (let xx = 0; xx < W; xx++) {
      const i = (y * W + xx) * 4
      if (d[i + 3] > 8) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; if (l > 120 && l < 215) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; n++ } }
    }
    res(n ? { r: Math.round(rs / n), g: Math.round(gs / n), b: Math.round(bs / n), n } : { n: 0 })
  }
  requestAnimationFrame(() => requestAnimationFrame(run))
}))
console.log('tinte medio de sombra (azulada esperada b>r):', JSON.stringify(tint), 'errs', errs.length)
await b.close()
