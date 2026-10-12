import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
await p.goto('http://localhost:5182/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
const cy = 380
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'brush', grid: { enabled: false } })
  ed.setBrush({ size: 24, mode: 'ribbon' })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0; ed.viewport3d.camera.pitch = 0.0; ed.viewport3d.camera.distance = 700
  ed.touchSpace()
})
await new Promise(r => setTimeout(r, 300))
await p.mouse.move(250, cy); await p.mouse.down()
for (let x = 250; x <= 850; x += 12) await p.mouse.move(x, cy)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
console.log('antes:', await p.evaluate(() => window.__drawiEditor.doc.strokes3d.map(s => s.count)))
// Diagnostico: proyectar los puntos del trazo y ver su rango en pantalla
const diag = await p.evaluate(() => {
  const ed = window.__drawiEditor
  const vp = ed.viewport3d
  const rect = vp.canvas.getBoundingClientRect()
  const s = ed.doc.strokes3d[0]
  // usa la API interna de proyeccion si existe; si no, aproxima con backend
  return { count: s.count, rectW: rect.width, rectH: rect.height, left: rect.left, top: rect.top }
})
console.log('diag:', JSON.stringify(diag))
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'erase', size: 40 }))
await new Promise(r => setTimeout(r, 100))
await p.mouse.move(550, cy - 90); await p.mouse.down()
for (let y = cy - 90; y <= cy + 90; y += 6) await p.mouse.move(550, y)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
console.log('despues:', await p.evaluate(() => window.__drawiEditor.doc.strokes3d.map(s => s.count)))
await b.close()
