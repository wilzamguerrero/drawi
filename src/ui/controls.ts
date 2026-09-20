import { blurSoon, el, num, setClass } from "./dom";
import { icon } from "./icons";

export interface Control<T> {
  readonly el: HTMLElement;
  set(value: T): void;
}

// ------------------------------------------------------------------ boton

export interface ButtonOptions {
  label?: string;
  iconName?: string;
  title?: string;
  variant?: "ghost" | "solid" | "quiet" | "danger";
  onClick: () => void;
}

export function button(options: ButtonOptions): Control<boolean> & { setActive(on: boolean): void } {
  const node = el(
    "button",
    {
      class: `btn btn-${options.variant ?? "ghost"}${options.label ? "" : " btn-icon"}`,
      type: "button",
      title: options.title ?? options.label ?? "",
      on: {
        click: () => {
          options.onClick();
          blurSoon(node);
        },
      },
    },
    [
      options.iconName ? el("span", { class: "btn-glyph", html: icon(options.iconName) }) : null,
      options.label ? el("span", { class: "btn-label", text: options.label }) : null,
    ],
  );
  return {
    el: node,
    set(enabled: boolean) {
      node.disabled = !enabled;
    },
    setActive(on: boolean) {
      setClass(node, "is-active", on);
    },
  };
}

// ----------------------------------------------------------------- slider

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  decimals?: number;
  unit?: string;
  hint?: string;
  /** Curva de respuesta: >1 da mas resolucion en los valores bajos. */
  gamma?: number;
  onInput: (value: number) => void;
}

/**
 * Deslizador con lectura editable.
 *
 * El numero es un campo de texto de verdad: valores como un tamano de 7.5 o una
 * gravedad exacta se escriben, no se cazan arrastrando. La curva `gamma` reparte
 * el recorrido donde importa (tamanos pequenos, mezclas finas).
 */
export function slider(options: SliderOptions): Control<number> {
  const { min, max, gamma = 1 } = options;
  const decimals = options.decimals ?? (options.step && options.step < 1 ? 2 : 0);
  const RES = 1000;

  const toSlider = (v: number): number => {
    const t = (v - min) / (max - min || 1);
    return Math.round(Math.pow(Math.max(0, Math.min(1, t)), 1 / gamma) * RES);
  };
  const fromSlider = (s: number): number => {
    const t = Math.pow(s / RES, gamma);
    const v = min + t * (max - min);
    const step = options.step ?? 0;
    return step > 0 ? Math.round(v / step) * step : v;
  };

  const range = el("input", {
    class: "slider-range",
    type: "range",
    min: 0,
    max: RES,
    step: 1,
    value: String(toSlider(options.value)),
  });
  const field = el("input", {
    class: "slider-field",
    type: "text",
    value: num(options.value, decimals),
  });
  const labelNode = el("span", { class: "slider-label", text: options.label });

  const paint = (v: number): void => {
    const t = (toSlider(v) / RES) * 100;
    range.style.setProperty("--fill", `${t}%`);
  };

  // Mientras se arrastra el range, ignoramos los `set()` externos para que el
  // valor recalculado (toSlider(fromSlider(v))) no pelee contra el arrastre.
  let dragging = false;

  range.addEventListener("input", () => {
    const v = fromSlider(Number(range.value));
    field.value = num(v, decimals);
    paint(v);
    options.onInput(v);
  });
  range.addEventListener("pointerdown", () => { dragging = true; });
  const endDrag = (): void => { dragging = false; };
  range.addEventListener("pointerup", () => { endDrag(); blurSoon(range); });
  range.addEventListener("pointercancel", endDrag);

  const commitField = (): void => {
    const raw = Number.parseFloat(field.value.replace(",", "."));
    if (!Number.isFinite(raw)) {
      field.value = num(fromSlider(Number(range.value)), decimals);
      return;
    }
    const v = Math.max(min, Math.min(max, raw));
    range.value = String(toSlider(v));
    field.value = num(v, decimals);
    paint(v);
    options.onInput(v);
  };
  field.addEventListener("change", commitField);
  field.addEventListener("blur", commitField);
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commitField();
      field.blur();
    }
  });

  const node = el("div", { class: "ctrl ctrl-slider", title: options.hint ?? "" }, [
    el("div", { class: "ctrl-head" }, [
      labelNode,
      el("div", { class: "slider-value" }, [field, options.unit ? el("span", { class: "slider-unit", text: options.unit }) : null]),
    ]),
    range,
  ]);
  paint(options.value);

  return {
    el: node,
    set(value: number) {
      if (dragging || document.activeElement === field) return;
      range.value = String(toSlider(value));
      field.value = num(value, decimals);
      paint(value);
    },
  };
}

// ----------------------------------------------------------------- toggle

export interface ToggleOptions {
  label: string;
  value: boolean;
  hint?: string;
  onChange: (value: boolean) => void;
}

export function toggle(options: ToggleOptions): Control<boolean> {
  const input = el("input", { type: "checkbox", class: "switch-input", checked: options.value });
  input.addEventListener("change", () => options.onChange(input.checked));
  const node = el("label", { class: "ctrl ctrl-toggle", title: options.hint ?? "" }, [
    el("span", { class: "ctrl-label", text: options.label }),
    el("span", { class: "switch" }, [input, el("span", { class: "switch-track" }, [el("span", { class: "switch-knob" })])]),
  ]);
  return {
    el: node,
    set(value: boolean) {
      input.checked = value;
    },
  };
}

// -------------------------------------------------------------- segmentado

export interface SegmentOption<T extends string> {
  value: T;
  label?: string;
  iconName?: string;
  title?: string;
}

export interface SegmentedOptions<T extends string> {
  label?: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function segmented<T extends string>(options: SegmentedOptions<T>): Control<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const group = el("div", { class: "segmented", role: "radiogroup" });

  for (const opt of options.options) {
    const b = el(
      "button",
      {
        class: "segment",
        type: "button",
        title: opt.title ?? opt.label ?? opt.value,
        role: "radio",
        on: {
          click: () => {
            options.onChange(opt.value);
            blurSoon(b);
          },
        },
      },
      [
        opt.iconName ? el("span", { class: "btn-glyph", html: icon(opt.iconName) }) : null,
        opt.label ? el("span", { text: opt.label }) : null,
      ],
    );
    buttons.set(opt.value, b);
    group.appendChild(b);
  }

  const node = options.label
    ? el("div", { class: "ctrl ctrl-segmented" }, [
        el("span", { class: "ctrl-label", text: options.label }),
        group,
      ])
    : group;

  const apply = (value: T): void => {
    for (const [v, b] of buttons) {
      const on = v === value;
      setClass(b, "is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    }
  };
  apply(options.value);

  return { el: node, set: apply };
}

// ------------------------------------------------------------------ select

export interface SelectOptions<T extends string> {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  hint?: string;
  onChange: (value: T) => void;
}

export function select<T extends string>(options: SelectOptions<T>): Control<T> {
  const sel = el("select", { class: "select-input" });
  for (const o of options.options) {
    sel.appendChild(el("option", { value: o.value, text: o.label }));
  }
  sel.value = options.value;
  sel.addEventListener("change", () => {
    options.onChange(sel.value as T);
    blurSoon(sel);
  });

  const node = el("div", { class: "ctrl ctrl-select", title: options.hint ?? "" }, [
    el("span", { class: "ctrl-label", text: options.label }),
    el("div", { class: "select" }, [sel, el("span", { class: "select-arrow", html: icon("chevron") })]),
  ]);

  return {
    el: node,
    set(value: T) {
      sel.value = value;
    },
  };
}

// ------------------------------------------------------------------ colores

export interface SwatchesOptions {
  colors: readonly string[];
  value: string;
  onPick: (hex: string) => void;
}

export function swatches(options: SwatchesOptions): Control<{ colors: readonly string[]; value: string }> {
  const node = el("div", { class: "swatches" });
  let current = options.value;

  const build = (colors: readonly string[]): void => {
    node.textContent = "";
    for (const hex of colors) {
      const b = el("button", {
        class: "swatch",
        type: "button",
        title: hex,
        style: { background: hex },
        on: {
          click: () => {
            options.onPick(hex);
            blurSoon(b);
          },
        },
      });
      b.dataset.color = hex.toLowerCase();
      setClass(b, "is-active", hex.toLowerCase() === current.toLowerCase());
      node.appendChild(b);
    }
  };
  build(options.colors);

  return {
    el: node,
    set({ colors, value }) {
      current = value;
      const existing = [...node.children] as HTMLElement[];
      const same =
        existing.length === colors.length &&
        existing.every((b, i) => b.dataset.color === colors[i].toLowerCase());
      if (!same) build(colors);
      for (const b of [...node.children] as HTMLElement[]) {
        setClass(b, "is-active", b.dataset.color === value.toLowerCase());
      }
    },
  };
}

// ------------------------------------------------------------------ seccion

export function section(title: string, children: HTMLElement[], collapsed = false): HTMLElement {
  const body = el("div", { class: "section-body" }, children);
  const head = el("button", { class: "section-head", type: "button" }, [
    el("span", { class: "section-title", text: title }),
    el("span", { class: "section-chevron", html: icon("chevron") }),
  ]);
  const node = el("section", { class: `panel-section${collapsed ? " is-collapsed" : ""}` }, [head, body]);
  head.addEventListener("click", () => {
    node.classList.toggle("is-collapsed");
    blurSoon(head);
  });
  return node;
}

export function row(children: HTMLElement[]): HTMLElement {
  return el("div", { class: "ctrl-row" }, children);
}

export function fieldLabel(text: string): HTMLElement {
  return el("p", { class: "field-note", text });
}
