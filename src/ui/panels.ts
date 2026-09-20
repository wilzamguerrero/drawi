import { el, setClass } from "./dom";
import { MateriaFx, prefersReducedMotion } from "./fx/materia";
import { icon } from "./icons";

/**
 * Definicion de un panel flotante.
 *
 * `build` recibe el cuerpo y devuelve una limpieza opcional. La app registra
 * definiciones por id; anadir un panel nuevo (efectos, capas, historia...) es
 * registrar una definicion mas, sin tocar el gestor.
 */
export interface PanelDef {
  id: string;
  title: string;
  build: (host: HTMLElement) => (() => void) | void;
}

/**
 * Gestor de paneles flotantes con anclaje (pin).
 *
 * Un panel se abre bajo el gesto y, por defecto, se cierra al tocar fuera —lo
 * justo para un vistazo rapido—. Si lo anclas, se queda: lo arrastras a una
 * esquina y lo tienes a mano, como la rueda de color. Cada panel es unico por
 * id; volver a abrirlo lo trae al frente en vez de duplicarlo.
 */
export class Panels {
  readonly el: HTMLElement;
  private cards = new Map<string, Card>();
  private onDocDown: (e: PointerEvent) => void;

  constructor() {
    this.el = el("div", { class: "dock" });
    this.onDocDown = (e: PointerEvent) => {
      const t = e.target as Node;
      for (const c of [...this.cards.values()]) {
        if (!c.pinned && !c.el.contains(t)) c.destroy();
      }
    };
    document.addEventListener("pointerdown", this.onDocDown, true);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  /** Abre (o trae al frente) el panel; si ya esta abierto y sin anclar, lo cierra. */
  toggle(def: PanelDef, x: number, y: number): void {
    const existing = this.cards.get(def.id);
    if (existing) {
      if (existing.pinned) existing.raise();
      else existing.destroy();
      return;
    }
    this.open(def, x, y);
  }

  open(def: PanelDef, x: number, y: number): void {
    const existing = this.cards.get(def.id);
    if (existing) {
      existing.raise();
      return;
    }
    const card = new Card(def, () => this.cards.delete(def.id));
    this.cards.set(def.id, card);
    this.el.appendChild(card.el);
    this.el.appendChild(card.fx.el); // capa de partículas, en el dock
    card.place(x, y);
    card.enter(); // aparición con partículas (materia)
  }

  dispose(): void {
    document.removeEventListener("pointerdown", this.onDocDown, true);
    for (const c of [...this.cards.values()]) c.destroy();
  }
}

class Card {
  readonly el: HTMLElement;
  /** Partículas (metaball) que forman/deshacen el panel. Sistema compartido. */
  readonly fx: MateriaFx;
  pinned = false;

  private cleanup: (() => void) | void;
  private onClose: () => void;
  private pinBtn: HTMLButtonElement;
  private closing = false;

  constructor(def: PanelDef, onClose: () => void) {
    this.onClose = onClose;
    this.fx = new MateriaFx({ coreSize: 140, reach: 108, gatherMs: 380, scatterMs: 300 });

    this.pinBtn = el("button", {
      class: "panel-pin",
      type: "button",
      title: "Anclar a la vista",
      html: icon("pin"),
    });
    this.pinBtn.addEventListener("click", () => this.togglePin());

    const closeBtn = el("button", { class: "panel-x", type: "button", title: "Cerrar", html: icon("close") });
    closeBtn.addEventListener("click", () => this.destroy());

    const head = el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title", text: def.title }),
      this.pinBtn,
      closeBtn,
    ]);
    const body = el("div", { class: "panel-body" });
    this.cleanup = def.build(body);

    // Nace oculto (materia-hidden): las partículas lo forman antes de que entre.
    this.el = el("div", { class: "panel-card materia-hidden" }, [head, body]);
    this.dragBy(head);
  }

  place(x: number, y: number): void {
    // Se coloca centrado sobre el punto y se reencaja dentro de la ventana.
    // offsetWidth/Height (no getBoundingClientRect) para no medir la escala de
    // materia-hidden: el transform no afecta al tamaño de maquetación.
    const w = this.el.offsetWidth || 280;
    const h = this.el.offsetHeight || 200;
    const left = clamppx(x - w / 2, 8, window.innerWidth - w - 8);
    const top = clamppx(y - h / 2, 8, window.innerHeight - h - 8);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  /** Centro del panel en coordenadas del dock (para colocar las partículas). */
  private centerPoint(): { x: number; y: number } {
    return {
      x: this.el.offsetLeft + this.el.offsetWidth / 2,
      y: this.el.offsetTop + this.el.offsetHeight / 2,
    };
  }

  /** Aparición: las partículas se juntan y el panel se funde desde el centro. */
  enter(): void {
    if (prefersReducedMotion()) {
      this.el.classList.remove("materia-hidden");
      return;
    }
    const c = this.centerPoint();
    this.fx.center(c.x, c.y);
    this.fx.gather();
    window.setTimeout(() => {
      this.el.classList.remove("materia-hidden");
      this.fx.fadeOut();
    }, this.fx.gatherMs);
  }

  raise(): void {
    this.el.parentElement?.appendChild(this.el);
    this.el.classList.remove("is-flash");
    void this.el.offsetWidth;
    this.el.classList.add("is-flash");
  }

  private togglePin(): void {
    this.pinned = !this.pinned;
    setClass(this.el, "is-pinned", this.pinned);
    setClass(this.pinBtn, "is-on", this.pinned);
    this.pinBtn.title = this.pinned ? "Soltar" : "Anclar a la vista";
  }

  private dragBy(handle: HTMLElement): void {
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    const move = (e: PointerEvent): void => {
      const nx = clamppx(ox + e.clientX - sx, 8, window.innerWidth - this.el.offsetWidth - 8);
      const ny = clamppx(oy + e.clientY - sy, 8, window.innerHeight - this.el.offsetHeight - 8);
      this.el.style.left = `${nx}px`;
      this.el.style.top = `${ny}px`;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      sx = e.clientX;
      sy = e.clientY;
      const r = this.el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      this.raise();
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  destroy(): void {
    if (this.closing) return;
    this.closing = true;

    const finish = (): void => {
      if (this.cleanup) this.cleanup();
      this.el.remove();
      this.fx.el.remove();
      this.onClose();
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    // Desaparición: el panel se desintegra en partículas que salen despedidas.
    const c = this.centerPoint();
    this.fx.center(c.x, c.y);
    this.fx.scatter();
    this.el.classList.add("materia-hiding");
    window.setTimeout(finish, this.fx.scatterMs);
  }
}

function clamppx(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
