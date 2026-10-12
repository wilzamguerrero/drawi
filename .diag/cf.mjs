import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless: 'new', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width: 1100, height: 760 })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await p.goto('http://localhost:5183/', { waitUntil: 'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r => setTimeout(r, 500))
const cx = 550, cy = 360
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool: 'brush', grid: { enabled: false } })
  ed.viewport3d.camera.px = 0; ed.viewport3d.camera.py = 0; ed.viewport3d.camera.pz = 0
  ed.viewport3d.camera.yaw = 0.0; ed.viewport3d.camera.pitch = 0.1; ed.viewport3d.camera.distance = 700
  ed.touchSpace()
})
await new Promise(r => setTimeout(r, 300))
// Rectangulo relleno grande
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'fill' }))
await new Promise(r => setTimeout(r, 100))
const corners = [[cx-200,cy-120],[cx+200,cy-120],[cx+200,cy+120],[cx-200,cy+120],[cx-200,cy-120]]
await p.mouse.move(corners[0][0], corners[0][1]); await p.mouse.down()
for (const [x,y] of corners.slice(1)) for (let k=1;k<=8;k++) await p.mouse.move(x,y)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
const read = () => p.evaluate(() => window.__drawiEditor.doc.fills3d.map(f => ({ c: f.count, holes: f.holes ? f.holes.length : 0 })))
console.log('relleno creado:', JSON.stringify(await read()))
await p.screenshot({ path: '.diag/cf-0.png' })

// 1) Mordisco en el BORDE (de fuera hacia dentro por la izquierda): debe recortar, 1 pieza
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'erase', size: 60 }))
await new Promise(r => setTimeout(r, 100))
await p.mouse.move(cx-260, cy); await p.mouse.down()
for (let x = cx-260; x <= cx-120; x += 8) await p.mouse.move(x, cy)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
console.log('tras mordisco de borde:', JSON.stringify(await read()))
await p.screenshot({ path: '.diag/cf-1.png' })

// 2) Agujero en el CENTRO: pequeno circulo-ish con la goma sin salir del relleno
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'erase', size: 40 }))
await new Promise(r => setTimeout(r, 100))
// pequeno bucle cerrado en el centro
const loop = []
for (let a = 0; a <= 360; a += 30) { const rad = 28; loop.push([cx + Math.cos(a*Math.PI/180)*rad, cy + Math.sin(a*Math.PI/180)*rad]) }
await p.mouse.move(loop[0][0], loop[0][1]); await p.mouse.down()
for (const [x,y] of loop.slice(1)) await p.mouse.move(x,y)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
console.log('tras morder el centro:', JSON.stringify(await read()))
await p.screenshot({ path: '.diag/cf-2.png' })

// 3) Cortar de lado a lado (vertical, atravesando): debe partir en 2
await p.evaluate(() => window.__drawiEditor.setBrush({ mode: 'erase', size: 36 }))
await new Promise(r => setTimeout(r, 100))
await p.mouse.move(cx+120, cy-200); await p.mouse.down()
for (let y = cy-200; y <= cy+200; y += 8) await p.mouse.move(cx+120, y)
await p.mouse.up()
await new Promise(r => setTimeout(r, 400))
console.log('tras cortar de lado a lado:', JSON.stringify(await read()))
await p.screenshot({ path: '.diag/cf-3.png' })
console.log('errs', errs.length, errs.slice(0,3).join(' | '))
await b.close()
