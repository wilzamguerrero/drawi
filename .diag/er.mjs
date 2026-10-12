import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await p.goto('http://localhost:5181/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
const cx = 550, cy = 360
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'brush', grid: { enabled: false } })
  ed.viewport3d.camera.px=0;ed.viewport3d.camera.py=0;ed.viewport3d.camera.pz=0
  ed.viewport3d.camera.yaw=0.0; ed.viewport3d.camera.pitch=0.2; ed.viewport3d.camera.distance=700
  ed.touchSpace()
})
await new Promise(r => setTimeout(r, 300))
// Dibujar un RELLENO: contorno cerrado
const drawFill = async () => {
  await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'fill' }))
  await new Promise(r => setTimeout(r, 100))
  const pts = [[cx-120,cy-90],[cx+120,cy-90],[cx+120,cy+90],[cx-120,cy+90],[cx-120,cy-90]]
  await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down()
  for (const [x,y] of pts.slice(1)) { for (let k=1;k<=6;k++) await p.mouse.move(x, y) }
  await p.mouse.up()
}
await drawFill()
await new Promise(r => setTimeout(r, 400))
const before = await p.evaluate(() => ({ fills: window.__drawiEditor.doc.fills3d.length, strokes: window.__drawiEditor.doc.strokes3d.length }))
console.log('tras dibujar relleno:', JSON.stringify(before))
await p.screenshot({ path: '.diag/er-fill.png' })
// Activar borrador y pasar por el centro del relleno
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'erase' }))
await new Promise(r => setTimeout(r, 100))
await p.mouse.move(cx-60, cy); await p.mouse.down()
for (let i=1;i<=12;i++) await p.mouse.move(cx-60 + i*10, cy)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
const after = await p.evaluate(() => ({ fills: window.__drawiEditor.doc.fills3d.length, strokes: window.__drawiEditor.doc.strokes3d.length }))
console.log('tras borrar con goma:', JSON.stringify(after))
await p.screenshot({ path: '.diag/er-after.png' })
console.log('errs', errs.length, errs.slice(0,2).join(' | '))
await b.close()
