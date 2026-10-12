import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await p.goto('http://localhost:5182/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
const cy = 380
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'brush', grid: { enabled: false } })
  ed.setBrush({ size: 24 })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0; ed.viewport3d.camera.pitch = 0.0; ed.viewport3d.camera.distance = 700
  ed.touchSpace()
})
await new Promise(r => setTimeout(r, 300))
// Un trazo horizontal largo
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'ribbon' }))
await new Promise(r => setTimeout(r, 100))
await p.mouse.move(250, cy); await p.mouse.down()
for (let x = 250; x <= 850; x += 12) await p.mouse.move(x, cy)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
const before = await p.evaluate(() => window.__drawiEditor.doc.strokes3d.length)
console.log('trazos antes de borrar:', before)
await p.screenshot({ path: '.diag/pe-before.png' })
// Goma: cruzar el trazo por el MEDIO en vertical (corte parcial -> debe partir en 2)
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'erase', size: 30 }))
await new Promise(r => setTimeout(r, 100))
await p.mouse.move(550, cy - 80); await p.mouse.down()
for (let y = cy - 80; y <= cy + 80; y += 8) await p.mouse.move(550, y)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
const after = await p.evaluate(() => window.__drawiEditor.doc.strokes3d.length)
console.log('trazos despues de cortar por el medio:', after, '(se espera 2)')
await p.screenshot({ path: '.diag/pe-after.png' })
console.log('errs', errs.length, errs.slice(0, 2).join(' | '))
await b.close()
