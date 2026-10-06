/**
 * Banco de pruebas de la Fase 1 del motor de acuarela.
 *
 * Monta AquaField + AquaStroker en pantalla completa con un loop propio, para
 * validar look y rendimiento del motor ANTES de cablearlo a capas/paneles de la
 * app. No forma parte del build principal: se abre con `aqua-lab.html`.
 *
 * Controles:
 *  - Dibuja con raton/lapiz/dedo (presion real si el dispositivo la entrega).
 *  - B: alterna pluma (pigmento) / pincel de agua.
 *  - W: tinta blanca (gouache).  D: hornear (fijar).  C: limpiar.
 *  - Sliders abajo: tamaño, flujo, sangrado, secado, matiz, carga del pincel.
 */

import { AquaField, type AquaParams } from "./aqua-field";
import { AquaStroker } from "./aqua-stroker";

const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;display:block;touch-action:none;cursor:crosshair";
document.body.style.margin = "0";
document.body.appendChild(canvas);

const field = new AquaField(canvas);
const stroker = new AquaStroker(field);

// ------------------------------------------------------------------ entrada

const toUv = (e: PointerEvent): [number, number] => [e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight];
const pressureOf = (e: PointerEvent): number => (e.pressure > 0 && e.pointerType !== "mouse" ? e.pressure : 0.5);

let activeId: number | null = null;
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (activeId !== null) return;
  activeId = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = toUv(e);
  stroker.begin(x, y, pressureOf(e));
});
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerId !== activeId) return;
  const [x, y] = toUv(e);
  stroker.move(x, y, pressureOf(e));
});
const release = (e: PointerEvent): void => {
  if (e.pointerId !== activeId) return;
  activeId = null;
  stroker.end();
};
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "b") stroker.mode = stroker.mode === "pen" ? "brush" : "pen";
  else if (k === "w") field.setWhite(true);
  else if (k === "d") field.fix();
  else if (k === "c") field.clear();
});
window.addEventListener("keyup", (e) => {
  if (e.key.toLowerCase() === "w") field.setWhite(false);
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => field.resize(), 180);
});

// ------------------------------------------------------------------ sliders

const PARAMS: { key: keyof AquaParams; label: string }[] = [
  { key: "size", label: "Tamaño" },
  { key: "flow", label: "Flujo" },
  { key: "bleed", label: "Sangrado" },
  { key: "dry", label: "Secado" },
  { key: "color", label: "Matiz" },
  { key: "brushInk", label: "Carga" },
];

const bar = document.createElement("div");
bar.style.cssText =
  "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:16px;" +
  "padding:10px 16px;background:rgba(20,20,22,.72);backdrop-filter:blur(8px);border-radius:12px;" +
  "font:12px/1.3 system-ui,sans-serif;color:#eee;z-index:10";
for (const { key, label } of PARAMS) {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;align-items:center";
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "1";
  input.step = "0.01";
  input.value = String(field.params[key]);
  input.style.width = "80px";
  input.addEventListener("input", () => {
    field.params[key] = Number(input.value);
  });
  wrap.append(text, input);
  bar.appendChild(wrap);
}
const hint = document.createElement("span");
hint.textContent = "B pluma/pincel · W blanco · D hornear · C limpiar";
hint.style.cssText = "align-self:center;opacity:.65;margin-left:8px";
bar.appendChild(hint);
document.body.appendChild(bar);

// --------------------------------------------------------------------- loop

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stroker.update(dt);
  field.step(dt);
  field.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
