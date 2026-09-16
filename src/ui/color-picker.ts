import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv, type Hsv } from "../core/color";
import { clamp01 } from "../core/math";
import { el } from "./dom";

/**
 * Selector HSV compacto.
 *
 * Cuadro de saturacion/valor con gradientes CSS en vez de un canvas: no consume
 * contexto 2D (los del lienzo son los que importan), escala solo con el DPR y
 * el arrastre usa captura de puntero, asi que el lapiz no pierde el control al
 * salirse del cuadro.
 */
export class ColorPicker {
  readonly el: HTMLElement;

  private area: HTMLElement;
  private areaKnob: HTMLElement;
  private hue: HTMLInputElement;
  private hex: HTMLInputElement;
  private preview: HTMLElement;
  private hsv: Hsv = { h: 0, s: 0, v: 0 };
  private onChange: (hex: string) => void;

  constructor(value: string, onChange: (hex: string) => void) {
    this.onChange = onChange;
    this.hsv = rgbToHsv(hexToRgb(value));

    this.areaKnob = el("span", { class: "picker-knob" });
    this.area = el("div", { class: "picker-area" }, [this.areaKnob]);
    this.hue = el("input", { class: "picker-hue", type: "range", min: 0, max: 360, step: 1 });
    this.hex = el("input", { class: "picker-hex", type: "text", placeholder: "#000000" });
    this.preview = el("span", { class: "picker-preview" });

    this.el = el("div", { class: "picker" }, [
      this.area,
      el("div", { class: "picker-row" }, [
        this.preview,
        el("div", { class: "picker-stack" }, [this.hue, this.hex]),
      ]),
    ]);

    this.bindArea();
    this.hue.addEventListener("input", () => {
      this.hsv.h = Number(this.hue.value);
      this.emit();
    });
    const commit = (): void => {
      const text = this.hex.value.trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(text)) {
        this.hsv = rgbToHsv(hexToRgb(text.startsWith("#") ? text : `#${text}`));
        this.emit();
      } else {
        this.sync();
      }
    };
    this.hex.addEventListener("change", commit);
    this.hex.addEventListener("blur", commit);

    this.sync();
  }

  private bindArea(): void {
    const pick = (e: PointerEvent): void => {
      const r = this.area.getBoundingClientRect();
      this.hsv.s = clamp01((e.clientX - r.left) / Math.max(1, r.width));
      this.hsv.v = 1 - clamp01((e.clientY - r.top) / Math.max(1, r.height));
      this.emit();
    };
    this.area.addEventListener("pointerdown", (e) => {
      this.area.setPointerCapture(e.pointerId);
      pick(e);
    });
    this.area.addEventListener("pointermove", (e) => {
      if (this.area.hasPointerCapture(e.pointerId)) pick(e);
    });
    this.area.addEventListener("pointerup", (e) => this.area.releasePointerCapture(e.pointerId));
  }

  private emit(): void {
    this.sync();
    this.onChange(this.value);
  }

  get value(): string {
    return rgbToHex(hsvToRgb(this.hsv));
  }

  /** Actualiza desde fuera (cuentagotas, paleta) sin reemitir. */
  set(hex: string): void {
    const next = rgbToHsv(hexToRgb(hex));
    // Con saturacion o valor a cero el tono es indefinido: se conserva el que
    // habia para que el cuadro no salte de color al pasar por negro o blanco.
    this.hsv = {
      h: next.s > 0.001 && next.v > 0.001 ? next.h : this.hsv.h,
      s: next.s,
      v: next.v,
    };
    this.sync();
  }

  private sync(): void {
    const pure = rgbToHex(hsvToRgb({ h: this.hsv.h, s: 1, v: 1 }));
    this.area.style.setProperty("--hue", pure);
    this.areaKnob.style.left = `${this.hsv.s * 100}%`;
    this.areaKnob.style.top = `${(1 - this.hsv.v) * 100}%`;
    const hex = this.value;
    this.areaKnob.style.background = hex;
    this.preview.style.background = hex;
    this.hue.value = String(Math.round(this.hsv.h));
    if (document.activeElement !== this.hex) this.hex.value = hex;
  }
}
