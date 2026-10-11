import puppeteer from 'puppeteer'
const b = await puppeteer.launch({ headless:'new', args:['--use-gl=angle','--use-angle=swiftshader','--ignore-gpu-blocklist'] })
const p = await b.newPage()
await p.setViewport({ width:1100, height:760 })
const errs = []
p.on('console', m => { if (m.type()==='error') errs.push(m.text()) })
await p.goto('http://localhost:5176/', { waitUntil:'networkidle0' })
await p.evaluate(() => window.__drawiEditor.setMode3D(true))
await new Promise(r=>setTimeout(r,500))
await p.evaluate(() => {
  const ed = window.__drawiEditor
  ed.setScene3D({ tool:'object', grid:{ enabled:true, opacity:0.6 }, shadow:{ enabled:true, opacity:0.45, softness:0.4 } })
  // Tres cubos: mate, metalico, emisivo
  ed.insertPrimitive('box')
  const a = ed.state.selectedObject.id
  ed.doc.updateObject3D(a, { color:'#c86b4a', roughness:0.9, metalness:0 })
  ed.doc.setObjectTransform(a, { position:{x:-180,y:60,z:0}, rotation:{x:0,y:0.3,z:0}, scale:{x:1,y:1,z:1} })
  ed.insertPrimitive('sphere')
  const sp = ed.state.selectedObject.id
  ed.doc.updateObject3D(sp, { color:'#d8d8dc', roughness:0.15, metalness:1 })
  ed.doc.setObjectTransform(sp, { position:{x:60,y:60,z:0}, rotation:{x:0,y:0,z:0}, scale:{x:1,y:1,z:1} })
  ed.insertPrimitive('cylinder')
  const cy = ed.state.selectedObject.id
  ed.doc.updateObject3D(cy, { color:'#5a9', roughness:0.4, metalness:0 })
  ed.doc.setObjectTransform(cy, { position:{x:290,y:60,z:60}, rotation:{x:0,y:0,z:0}, scale:{x:1,y:1,z:1} })
  const key = ed.doc.lights3d.find(l=>l.kind!=='ambient')
  if (key) ed.doc.updateLight3D(key.id, { x:0.4,y:0.85,z:0.35, enabled:true })
  ed.viewport3d.camera.px=60;ed.viewport3d.camera.py=0;ed.viewport3d.camera.pz=0
  ed.viewport3d.camera.yaw=0.5; ed.viewport3d.camera.pitch=0.5; ed.viewport3d.camera.distance=1100
  ed.selectObject3D(null); ed.touchSpace()
})
await new Promise(r=>setTimeout(r,800))
await p.screenshot({ path:'.diag/pbr.png' })
console.log('errs', errs.length, errs.slice(0,3).join(' | '))
await b.close()
