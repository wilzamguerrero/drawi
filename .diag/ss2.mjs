import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
await p.goto('http://localhost:5178/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
// Trazo grueso, elevado sobre el suelo; sin objetos, para ver solo su sombra
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'brush', grid: { enabled: true, opacity: 0.6 }, shadow: { enabled: true, opacity: 0.55, softness: 0.25 }, strokeShadow: true })
  ed.setBrush({ size: 90 })
  const key = ed.doc.lights3d.find(l => l.kind !== 'ambient')
  if (key) ed.doc.updateLight3D(key.id, { x: 0.2, y: 0.95, z: 0.2, enabled: true })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0.3; ed.viewport3d.camera.pitch = 0.8; ed.viewport3d.camera.distance = 900
  // Plano de dibujo elevado: pintar en alto para que la sombra caiga separada abajo
  ed.viewport3d.frameAll()
  for (let i = 0; i < 16; i++) ed.viewport3d.adjustDepth(-1)
  ed.touchSpace()
})
await new Promise(r => setTimeout(r, 300))
const cx = 550, cy = 300
await p.mouse.move(cx - 160, cy)
await p.mouse.down()
for (let i = 1; i <= 18; i++) await p.mouse.move(cx - 160 + i * 18, cy + Math.sin(i * 0.5) * 10)
await p.mouse.up()
await new Promise(r => setTimeout(r, 500))
await p.screenshot({ path: '.diag/ss2-on.png' })
await p.evaluate(() => window.__drawiEditor.setScene3D({ strokeShadow: false }))
await new Promise(r => setTimeout(r, 400))
await p.screenshot({ path: '.diag/ss2-off.png' })
console.log('done')
await b.close()
