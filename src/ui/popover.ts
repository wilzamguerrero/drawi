import { el } from "./dom";

export type PopoverSide = "right" | "bottom" | "left" | "top";

/**
 * Menu flotante anclado a un boton.
 *
 * Se posiciona en coordenadas de viewport y se reencaja si no cabe: en una
 * tablet en vertical, los paneles de paleta o exportacion se salian por el
 * borde y quedaban inalcanzables justo con el dedo, que es el caso en el que
 * mas se usan.
 */
export class Popover {
  readonly el: HTMLElement;
  private open = false;
  private anchor: HTMLElement | null = null;
  private side: PopoverSide = "right";
  private onDoc: (e: PointerEvent) => void;
  private onKey: (e: KeyboardEvent) => void;
  private onScroll: () => void;

  constructor(content: HTMLElement, className = "") {
    this.el = el("div", { class: `popover ${className}`.trim() }, [content]);
    this.el.hidden = true;
    document.body.appendChild(this.el);

    this.onDoc = (e: PointerEvent) => {
      if (!this.open) return;
      const t = e.target as Node;
      if (this.el.contains(t) || this.anchor?.contains(t)) return;
      this.hide();
    };
    this.onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.open) {
        e.stopPropagation();
        this.hide();
      }
    };
    this.onScroll = () => {
      if (this.open) this.place();
    };
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(anchor: HTMLElement, side: PopoverSide = "right"): void {
    if (this.open && this.anchor === anchor) this.hide();
    else this.show(anchor, side);
  }

  show(anchor: HTMLElement, side: PopoverSide = "right"): void {
    this.anchor = anchor;
    this.side = side;
    this.el.hidden = false;
    this.open = true;
    anchor.classList.add("is-open");
    this.place();
    document.addEventListener("pointerdown", this.onDoc, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onScroll);
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    this.anchor?.classList.remove("is-open");
    document.removeEventListener("pointerdown", this.onDoc, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onScroll);
  }

  private place(): void {
    const a = this.anchor;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const box = this.el.getBoundingClientRect();
    const gap = 10;
    const pad = 8;
    let x: number;
    let y: number;

    if (this.side === "right") {
      x = r.right + gap;
      y = r.top;
    } else if (this.side === "left") {
      x = r.left - box.width - gap;
      y = r.top;
    } else if (this.side === "top") {
      x = r.left;
      y = r.top - box.height - gap;
    } else {
      x = r.left;
      y = r.bottom + gap;
    }

    // Si no cabe hacia un lado, se vuelca al contrario antes de recortar.
    if (x + box.width > window.innerWidth - pad) {
      x = this.side === "right" ? r.left - box.width - gap : window.innerWidth - box.width - pad;
    }
    if (y + box.height > window.innerHeight - pad) {
      y = this.side === "bottom" ? r.top - box.height - gap : window.innerHeight - box.height - pad;
    }
    this.el.style.left = `${Math.max(pad, x)}px`;
    this.el.style.top = `${Math.max(pad, y)}px`;
  }

  dispose(): void {
    this.hide();
    this.el.remove();
  }
}
