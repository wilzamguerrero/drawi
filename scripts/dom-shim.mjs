/**
 * DOM minimo para ejecutar la aplicacion en Node.
 *
 * No existe un navegador sin cabeza instalado y no se quiere anadir uno como
 * dependencia solo para la CI: lo unico que hace falta es que el arbol de
 * componentes se construya y que los eventos de puntero lleguen a las
 * herramientas. Este fichero implementa exactamente esa superficie y nada mas.
 *
 * Dos decisiones importantes:
 *  - getContext("webgl2") devuelve null a proposito, para que las pruebas
 *    recorran el camino de respaldo por CPU (marching squares) que es el que
 *    mas facilmente se rompe sin que nadie lo note.
 *  - getContext("2d") devuelve un proxy que traga cualquier llamada, porque el
 *    editor trata un contexto nulo como error fatal y aqui no se pinta nada.
 */
const listeners = [];

class ClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach((x) => this.set.add(x)); }
  remove(...n) { n.forEach((x) => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, on) { const v = on === undefined ? !this.set.has(n) : on; v ? this.set.add(n) : this.set.delete(n); return v; }
  get value() { return [...this.set].join(" "); }
  set value(v) { this.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
}

const ctx2d = () => new Proxy({
  canvas: null, measureText: () => ({ width: 10 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  createPattern: () => null, getLineDash: () => [],
  isPointInPath: () => false, setTransform() {}, save() {}, restore() {},
}, {
  get: (t, p) => (p in t ? t[p] : typeof p === "string" ? (t[p] = () => undefined) : undefined),
  set: (t, p, v) => ((t[p] = v), true),
});

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    // classList primero: className es un accesor que escribe sobre el.
    this.classList = new ClassList();
    this.id = ""; this.title = "";
    this.textContent = ""; this.innerHTML = "";
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this.dataset = {};
    this.childNodes = []; this.attributes = {};
    this.hidden = false; this.disabled = false; this.checked = false;
    this.value = ""; this.width = 800; this.height = 600;
    this.parentNode = null;
  }
  get className() { return this.classList.value; }
  set className(v) { this.classList.value = v; }
  get children() { return this.childNodes.filter((c) => c instanceof El); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get parentElement() { return this.parentNode; }
  appendChild(c) { this.childNodes.push(c); if (c instanceof El) c.parentNode = this; return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  insertBefore(c, ref) { const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c); if (c instanceof El) c.parentNode = this; return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); if (c instanceof El) c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...cs) { this.childNodes = []; cs.forEach((c) => this.appendChild(c)); }
  contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn) { listeners.push([this, t, fn]); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }; }
  focus() {} blur() {} select() {} click() {}
  setPointerCapture() {} releasePointerCapture() {}
  scrollIntoView() {}
  getContext(kind) { if (kind === "2d") { const c = ctx2d(); c.canvas = this; return c; } return null; }
  toDataURL() { return "data:image/png;base64,"; }
  toBlob(cb) { cb(null); }
}

class TextNode { constructor(t) { this.textContent = String(t); } }

globalThis.document = {
  title: "", body: new El("body"), documentElement: new El("html"), activeElement: null,
  createElement: (t) => new El(t),
  createTextNode: (t) => new TextNode(t),
  getElementById: () => null,
  addEventListener: (t, fn) => listeners.push([globalThis.document, t, fn]),
  removeEventListener() {},
};
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = Object.assign(globalThis, {
  devicePixelRatio: 2, innerWidth: 1280, innerHeight: 800,
  addEventListener: (t, fn) => listeners.push([globalThis.window, t, fn]),
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
});
globalThis.__listeners = listeners;
globalThis.__El = El;

/* Path2D: la app lo usa para cachear contornos; aqui solo necesita existir. */
globalThis.Path2D = class Path2D {
  constructor() { this.ops = 0; }
  moveTo() { this.ops++; } lineTo() { this.ops++; }
  quadraticCurveTo() { this.ops++; } bezierCurveTo() { this.ops++; }
  arc() { this.ops++; } arcTo() { this.ops++; } ellipse() { this.ops++; }
  rect() { this.ops++; } roundRect() { this.ops++; } closePath() { this.ops++; }
  addPath() { this.ops++; }
};
globalThis.Blob = globalThis.Blob ?? class Blob { constructor(p) { this.parts = p; } };
globalThis.URL = globalThis.URL ?? {};
globalThis.URL.createObjectURL = () => "blob:tmp";
globalThis.URL.revokeObjectURL = () => {};
globalThis.PointerEvent = class PointerEvent {
  constructor(type, init = {}) {
    Object.assign(this, {
      type, pointerId: 1, pointerType: "pen", pressure: 0.5, tiltX: 0, tiltY: 0,
      twist: 0, buttons: 1, button: 0, clientX: 0, clientY: 0, isPrimary: true,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      timeStamp: performance.now(), target: null,
    }, init);
  }
  preventDefault() {} stopPropagation() {}
  getCoalescedEvents() { return [this]; }
  getPredictedEvents() { return []; }
};
globalThis.FileReader = class FileReader {
  readAsText() { this.onload?.({ target: { result: "{}" } }); }
  readAsDataURL() { this.onload?.({ target: { result: "data:," } }); }
};

globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.prompt = () => null;
