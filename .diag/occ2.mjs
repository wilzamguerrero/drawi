import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
await p.goto('http://localhost:5177/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
const cx = 550, cy = 380
const setup = () => p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'object', grid: { enabled: false } })
  ed.insertPrimitive('box')
  const id = ed.state.selectedObject.id
  ed.doc.updateObject3D(id, { color: '#4060c0', opacity: 1 })
  ed.doc.setObjectTransform(id, { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2.4, y: 2.4, z: 0.3 } })
  const key = ed.doc.lights3d.find(l => l.kind !== 'ambient')
  if (key) ed.doc.updateLight3D(key.id, { x: 0.3, y: 0.7, z: 0.6, enabled: true })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0; ed.viewport3d.camera.pitch = 0.1; ed.viewport3d.camera.distance = 700
  ed.selectObject3D(null); ed.touchSpace()
})
await setup()
await new Promise(r => setTimeout(r, 400))
await p.evaluate(() => { const ed = window.__drawiEditor; ed.setScene3D({ tool: 'brush' }); for (let i = 0; i < 40; i++) ed.viewport3d.adjustDepth(1) })
await new Promise(r => setTimeout(r, 200))
await p.mouse.move(cx - 220, cy)
await p.mouse.down()
for (let i = 1; i <= 24; i++) await p.mouse.move(cx - 220 + i * 18, cy)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
const sample = () => p.evaluate((args) => {
  const [cx, cy] = args
  return new Promise((res) => {
    const run = () => {
      const c = document.querySelector('canvas.layer-3d')
      const t = document.createElement('canvas'); t.width = c.width; t.height = c.height
      const x = t.getContext('2d'); x.drawImage(c, 0, 0)
      const dpr = c.width / 1100
      const i = (Math.round(cy * dpr) * t.width + Math.round(cx * dpr)) * 4
      const d = x.getImageData(0, 0, t.width, t.height).data
      res({ r: d[i], g: d[i + 1], b: d[i + 2] })
    }
    requestAnimationFrame(() => requestAnimationFrame(run))
  })
}, [cx, cy])
// Con oclusion ON (por defecto): el centro deberia ser AZUL (cubo tapa el trazo)
console.log('oclusion ON :', JSON.stringify(await sample()))
await p.screenshot({ path: '.diag/occ-on.png' })
// Apagar oclusion: el trazo deberia pasar por delante -> ROJO
await p.evaluate(() => window.__drawiEditor.setScene3D({ occludeStrokes: false }))
await new Promise(r => setTimeout(r, 300))
console.log('oclusion OFF:', JSON.stringify(await sample()))
await p.screenshot({ path: '.diag/occ-off.png' })
await b.close()
