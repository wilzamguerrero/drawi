/**
 * Ayudantes de DOM.
 *
 * La UI se construye a mano, sin framework, porque durante un trazo el hilo
 * principal esta ocupado en filtrar puntos y generar contornos: un ciclo de
 * re-render virtual por cada movimiento del lapiz es exactamente el coste que
 * se nota como retraso en la punta.
 */

export type Child = Node | string | null | undefined | false;

export interface ElOptions {
  class?: string;
  id?: string;
  title?: string;
  html?: string;
  text?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  checked?: boolean;
  disabled?: boolean;
  role?: string;
  tabIndex?: number;
  dataset?: Record<string, string>;
  aria?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: never) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.id) node.id = options.id;
  if (options.title) node.title = options.title;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.role) node.setAttribute("role", options.role);
  if (options.tabIndex !== undefined) node.tabIndex = options.tabIndex;

  const input = node as unknown as HTMLInputElement;
  if (options.type) input.type = options.type;
  if (options.value !== undefined) input.value = options.value;
  if (options.placeholder !== undefined) input.placeholder = options.placeholder;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.step !== undefined) input.step = String(options.step);
  if (options.checked !== undefined) input.checked = options.checked;
  if (options.disabled !== undefined) input.disabled = options.disabled;

  if (options.dataset) {
    for (const [k, v] of Object.entries(options.dataset)) node.dataset[k] = v;
  }
  if (options.aria) {
    for (const [k, v] of Object.entries(options.aria)) node.setAttribute(`aria-${k}`, v);
  }
  if (options.style) Object.assign(node.style, options.style);
  if (options.on) {
    for (const [k, fn] of Object.entries(options.on)) {
      if (fn) node.addEventListener(k, fn as EventListener);
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setClass(node: Element, name: string, on: boolean): void {
  node.classList.toggle(name, on);
}

/** Texto numerico compacto para etiquetas de la UI. */
export function num(value: number, decimals = 0): string {
  const f = value.toFixed(decimals);
  return decimals > 0 ? f.replace(/\.?0+$/, "") || "0" : f;
}

/**
 * Enfoca sin robar el gesto en curso.
 *
 * Los controles de la barra no deben quedarse con el foco despues de un clic:
 * si lo hacen, la siguiente tecla de atajo va al boton y no al lienzo.
 */
export function blurSoon(node: HTMLElement): void {
  requestAnimationFrame(() => node.blur());
}
