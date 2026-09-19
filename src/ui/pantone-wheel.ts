import { el } from "./dom";
import { icon } from "./icons";
import { createPaletteFromColors, getPalette, PANTONE_PALETTES, type Palette, type Swatch } from "./pantone-palettes";
import { extractColorsFromImage, parseACO, parseASE } from "./pantone-importers";

/**
 * Rueda de color Pantone flotante.
 *
 * Portado del `PantoneWheelOverlay` (React) del estudio de referencia a la base
 * sin framework de drawi. Es un sistema de color aparte del selector normal: un
 * disco flotante de sectores que se arrastra para girar (con inercia), un nucleo
 * central que muestra el color activo y hace de tirador para mover la rueda, y un
 * anillo de degradado con matices y grises del color activo.
 *
 * En vez de un SVG por muestra (como la version React) se dibuja todo en un solo
 * SVG con un grupo que rota: el arrastre solo toca un `transform`, no reconstruye
 * el DOM, asi que gira fluido aunque haya un par de cientos de sectores.
 *
 * El color se emite por `onColorSelect`; el resto (posicion, rotacion, paleta) se
 * guarda en localStorage para reencontrar la rueda donde se dejo.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_THICKNESS = 48;
const GAP = 2;
const GRAD_RADIUS = 60;
const GRAD_THICKNESS = 26;
const GRAD_SEGMENTS = 16;
const VIEW = 460; // medio lado del viewBox del SVG de anillos
const POS_KEY = "drawi.pantone.pos";
const ROT_KEY = "drawi.pantone.rot";
const PAL_KEY = "drawi.pantone.palette";

// --------------------------------------------------------------- geometria

interface Pt {
  x: number;
  y: number;
}

/** Polar a cartesiano con 0 grados arriba (las 12 en punto) y giro horario. */
const polar = (r: number, deg: number): Pt => {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
};

/** Gira la etiqueta para que se lea derecha en la mitad izquierda de la rueda. */
const textRotation = (deg: number): number => {
  let n = deg % 360;
  if (n < 0) n += 360;
  return n > 90 && n < 270 ? n + 180 : n;
};

/** Path SVG de un sector de corona (donut slice) con separacion `gap`. */
const annularSector = (
  inner: number,
  outer: number,
  start: number,
  end: number,
  gap: number,
): string => {
  const ag = (gap / inner) * (180 / Math.PI);
  const s = start + ag / 2;
  const e = end - ag / 2;
  const ir = inner + gap / 2;
  const or = outer - gap / 2;
  const so = polar(or, e);
  const eo = polar(or, s);
  const si = polar(ir, e);
  const ei = polar(ir, s);
  const large = e - s <= 180 ? "0" : "1";
  return [
    "M", so.x, so.y,
    "A", or, or, 0, large, 0, eo.x, eo.y,
    "L", ei.x, ei.y,
    "A", ir, ir, 0, large, 1, si.x, si.y,
    "Z",
  ].join(" ");
};

const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

// --------------------------------------------------------------- color util

const contrastText = (hex: string): string => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? "#171a20" : "#ffffff";
};

const lerpHex = (a: string, b: string, t: number): string => {
  const pa = a.replace("#", "");
  const pb = b.replace("#", "");
  const mix = (i: number): string => {
    const va = parseInt(pa.slice(i, i + 2), 16);
    const vb = parseInt(pb.slice(i, i + 2), 16);
    return Math.round(va + (vb - va) * t).toString(16).padStart(2, "0");
  };
  return `#${mix(0)}${mix(2)}${mix(4)}`.toUpperCase();
};

const loadPos = (): Pt => {
  try {
    const s = localStorage.getItem(POS_KEY);
    if (s) return JSON.parse(s);
  } catch {
    /* valor por defecto abajo */
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
};

// -------------------------------------------------------------------- clase

export class PantoneWheel {
  readonly el: HTMLElement;

  private container: HTMLElement;
  private ringsSvg: SVGSVGElement;
  private rotGroup: SVGGElement;
  private gradientSvg: SVGSVGElement;
  private hubBtn: HTMLButtonElement;
  private hubName: HTMLElement;
  private hubHex: HTMLElement;
  private pinDot: HTMLElement;
  private library: HTMLElement;

  private onColorSelect: (hex: string) => void;

  private visible = false;
  private expanded = false;
  private pinned = false;
  private position: Pt = loadPos();
  private rotation = Number(localStorage.getItem(ROT_KEY)) || 0;
  private paletteId = localStorage.getItem(PAL_KEY) || "universal";
  private palette: Palette;
  private customPalettes: Palette[] = [];
  private collapseTimer = 0;
  private hideTimer = 0;

  private active: Swatch | null = null;

  // Inercia del giro.
  private velocity = 0;
  private lastAngle = 0;
  private rotating = false;
  private raf = 0;

  private onDocDown: (e: PointerEvent) => void;

  constructor(onColorSelect: (hex: string) => void) {
    this.onColorSelect = onColorSelect;
    this.palette = this.resolvePalette(this.paletteId);

    this.rotGroup = svgEl("g");
    this.ringsSvg = svgEl("svg", {
      class: "pw-rings",
      viewBox: `${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`,
    });
    this.ringsSvg.appendChild(this.rotGroup);

    this.gradientSvg = svgEl("svg", { class: "pw-gradient", viewBox: "-100 -100 200 200" });

    this.hubName = el("span", { class: "pw-hub-name" });
    this.hubHex = el("span", { class: "pw-hub-hex" });
    this.pinDot = el("span", { class: "pw-pin", title: "Fijar (que no se cierre al hacer clic fuera)" });
    this.hubBtn = el("button", { class: "pw-hub", type: "button", title: "Arrastra para mover · clic para abrir/cerrar · Ctrl+clic: paletas" }, [
      el("span", { class: "pw-hub-label" }, [this.hubName, this.hubHex]),
      this.pinDot,
    ]);

    this.library = el("div", { class: "pw-library", role: "menu" });
    this.library.hidden = true;

    this.container = el("div", { class: "pw-wheel" }, [this.gradientSvg, this.ringsSvg, this.hubBtn]);
    this.el = el("div", { class: "pw-overlay" }, [this.container, this.library]);
    this.el.hidden = true;
    document.body.appendChild(this.el);

    this.buildRings();
    this.buildLibrary();
    this.bindHub();
    this.bindPin();

    // Al abrir sin muestra activa, arranca en la primera del primer anillo.
    for (const ring of this.palette.rings) {
      if (ring.items.length) {
        this.active = ring.items[0];
        break;
      }
    }

    this.onDocDown = (e: PointerEvent) => {
      if (!this.visible || this.pinned) return;
      const t = e.target as Node;
      if (this.container.contains(t) || this.library.contains(t)) return;
      // Solo se cierra si esta plegada; expandida se queda (como el original).
      if (!this.expanded) this.hide();
    };

    this.applyPosition();
    this.applyRotation();
    this.renderGradient();
    this.updateHub();
    this.setExpanded(false);
  }

  // ------------------------------------------------------------- construccion

  private buildRings(): void {
    while (this.rotGroup.firstChild) this.rotGroup.removeChild(this.rotGroup.firstChild);

    for (const ring of this.palette.rings) {
      const outer = ring.radius + RING_THICKNESS;
      for (const item of ring.items) {
        const mid = (item.startAngle + item.endAngle) / 2;
        const cen = polar(ring.radius + RING_THICKNESS / 2, mid);

        const path = svgEl("path", {
          class: "pw-swatch",
          d: annularSector(ring.radius, outer, item.startAngle, item.endAngle, GAP),
          fill: item.hex,
          stroke: item.hex,
          "stroke-width": 4,
          "stroke-linejoin": "round",
        });
        path.addEventListener("pointerdown", (e) => this.onSwatchDown(e, item));
        path.addEventListener("pointerenter", () => this.updateHub(item));
        path.addEventListener("pointerleave", () => this.updateHub());
        this.rotGroup.appendChild(path);

        // Etiqueta en el centro del sector.
        const label = svgEl("text", {
          class: "pw-label",
          x: cen.x,
          y: cen.y,
          transform: `rotate(${textRotation(mid)} ${cen.x} ${cen.y})`,
          "text-anchor": "middle",
          "dominant-baseline": "central",
        });
        label.textContent = item.name;
        this.rotGroup.appendChild(label);
      }
    }
  }

  private renderGradient(): void {
    while (this.gradientSvg.firstChild) this.gradientSvg.removeChild(this.gradientSvg.firstChild);
    const activeHex = this.active?.hex ?? "#888888";
    const seg = 180 / GRAD_SEGMENTS;
    const outer = GRAD_RADIUS + GRAD_THICKNESS;

    const add = (hex: string, start: number, end: number): void => {
      const path = svgEl("path", {
        class: "pw-grad",
        d: annularSector(GRAD_RADIUS, outer, start, end, 2),
        fill: hex,
        stroke: hex,
        "stroke-width": 4,
        "stroke-linejoin": "round",
      });
      path.addEventListener("click", () => this.selectColor(hex));
      this.gradientSvg.appendChild(path);
    };

    // Mitad izquierda: escala de grises de blanco a negro.
    for (let i = 0; i < GRAD_SEGMENTS; i++) {
      const g = Math.round(255 * (1 - i / (GRAD_SEGMENTS - 1)));
      const h = g.toString(16).padStart(2, "0");
      add(`#${h}${h}${h}`, 180 + i * seg, 180 + (i + 1) * seg);
    }
    // Primer cuarto: negro al color activo.
    for (let i = 0; i < GRAD_SEGMENTS / 2; i++) {
      add(lerpHex("#000000", activeHex, i / (GRAD_SEGMENTS / 2 - 1)), i * seg, (i + 1) * seg);
    }
    // Segundo cuarto: color activo a blanco.
    for (let i = 0; i < GRAD_SEGMENTS / 2; i++) {
      add(lerpHex(activeHex, "#FFFFFF", i / (GRAD_SEGMENTS / 2 - 1)), 90 + i * seg, 90 + (i + 1) * seg);
    }
  }

  private buildLibrary(): void {
    this.library.textContent = "";
    this.library.appendChild(el("div", { class: "pw-lib-title", text: "Presets de color" }));

    const grid = el("div", { class: "pw-lib-grid" });
    for (const pal of [...PANTONE_PALETTES, ...this.customPalettes]) {
      const preview = [...pal.preview];
      while (preview.length < 4) preview.push(preview[preview.length - 1] ?? "#333");
      const swatches = el("span", { class: "pw-lib-preview" }, preview.slice(0, 4).map((c) => el("i", { style: { background: c } })));
      const btn = el("button", {
        class: "pw-lib-item",
        type: "button",
        title: pal.name,
        on: { click: () => this.setPalette(pal.id) },
      }, [swatches]);
      btn.dataset.pal = pal.id;
      grid.appendChild(btn);
    }

    // Cargar Pantones (.ase / .aco) y extraer paleta de una imagen.
    grid.appendChild(this.importButton("upload", "ASE / ACO", ".ase,.aco", (f) => this.importSwatchFile(f)));
    grid.appendChild(this.importButton("wheel", "Imagen", "image/*", (f) => this.importImage(f)));

    this.library.appendChild(grid);
    this.markLibrary();
  }

  private importButton(iconName: string, label: string, accept: string, onFile: (f: File) => void): HTMLElement {
    const input = el("input", { class: "pw-lib-file", type: "file" }) as HTMLInputElement;
    input.accept = accept;
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) onFile(f);
      input.value = "";
    });
    const btn = el("button", {
      class: "pw-lib-item pw-lib-import",
      type: "button",
      title: `Cargar ${label}`,
      on: { click: () => input.click() },
    }, [
      el("span", { class: "pw-lib-icon", html: icon(iconName) }),
      el("span", { class: "pw-lib-tag", text: label }),
      input,
    ]);
    return btn;
  }

  private addCustomPalette(pal: Palette): void {
    this.customPalettes.push(pal);
    this.paletteId = pal.id;
    this.palette = pal;
    localStorage.setItem(PAL_KEY, pal.id);
    this.buildLibrary();
    this.buildRings();
    this.library.hidden = true;
  }

  private importSwatchFile(file: File): void {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buffer = e.target?.result as ArrayBuffer;
      try {
        const lower = file.name.toLowerCase();
        const colors = lower.endsWith(".ase") ? parseASE(buffer) : lower.endsWith(".aco") ? parseACO(buffer) : [];
        if (colors.length === 0) {
          alert("No se encontraron colores compatibles en el archivo.");
          return;
        }
        this.addCustomPalette(createPaletteFromColors(file.name.replace(/\.[^/.]+$/, ""), colors));
      } catch {
        alert("No se pudo leer el archivo. Debe ser un .ase o .aco valido.");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  private async importImage(file: File): Promise<void> {
    try {
      const colors = await extractColorsFromImage(file, 72);
      if (colors.length === 0) {
        alert("No se pudieron extraer colores de la imagen.");
        return;
      }
      this.addCustomPalette(createPaletteFromColors(file.name.replace(/\.[^/.]+$/, ""), colors));
    } catch {
      alert("Error al extraer colores. Prueba con otra imagen.");
    }
  }

  private markLibrary(): void {
    for (const b of Array.from(this.library.querySelectorAll(".pw-lib-item")) as HTMLElement[]) {
      if (b.dataset.pal) b.classList.toggle("is-active", b.dataset.pal === this.paletteId);
    }
  }

  private resolvePalette(id: string): Palette {
    return this.customPalettes.find((p) => p.id === id) ?? getPalette(id);
  }

  // --------------------------------------------------------------- seleccion

  private selectColor(hex: string): void {
    this.onColorSelect(hex);
  }

  private onSwatchDown(e: PointerEvent, item: Swatch): void {
    e.preventDefault();
    // Selecciona ya, en el pointerdown, para poder pintar sin esperar.
    this.active = item;
    this.selectColor(item.hex);
    this.updateHub(item);
    this.renderGradient();
    this.beginRotate(e);
  }

  private updateHub(hover?: Swatch): void {
    const s = hover ?? this.active;
    const hex = s?.hex ?? "#262626";
    this.hubBtn.style.background = hex;
    this.hubBtn.style.color = contrastText(hex);
    this.hubName.textContent = s?.name ?? "";
    this.hubHex.textContent = hex.toUpperCase();
  }

  // ----------------------------------------------------------------- rotacion

  private angleFromCenter(clientX: number, clientY: number): number {
    const r = this.ringsSvg.getBoundingClientRect();
    return (Math.atan2(clientY - (r.top + r.height / 2), clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  }

  private beginRotate(e: PointerEvent): void {
    this.stopMomentum();
    this.rotating = true;
    this.velocity = 0;
    this.lastAngle = this.angleFromCenter(e.clientX, e.clientY);

    const move = (ev: PointerEvent): void => {
      if (!this.rotating) return;
      const a = this.angleFromCenter(ev.clientX, ev.clientY);
      let d = a - this.lastAngle;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this.velocity = d * 0.6 + this.velocity * 0.4;
      this.lastAngle = a;
      this.rotation += d;
      this.applyRotation();
    };
    const up = (): void => {
      this.rotating = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (Math.abs(this.velocity) > 0.5) this.momentum();
      else this.saveRotation();
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", up);
  }

  private momentum = (): void => {
    // Friccion con un punto de resorte, como el original: frena con un rebote.
    this.velocity = (this.velocity - this.velocity * 0.15) * 0.92;
    if (Math.abs(this.velocity) > 0.05) {
      this.rotation += this.velocity;
      this.applyRotation();
      this.raf = requestAnimationFrame(this.momentum);
    } else {
      this.velocity = 0;
      this.raf = 0;
      this.saveRotation();
    }
  };

  private stopMomentum(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.velocity = 0;
  }

  private applyRotation(): void {
    this.rotGroup.setAttribute("transform", `rotate(${this.rotation})`);
  }

  private saveRotation(): void {
    localStorage.setItem(ROT_KEY, String(this.rotation));
  }

  // ------------------------------------------------------------------- nucleo

  private bindHub(): void {
    let startX = 0;
    let startY = 0;
    let moved = false;

    this.hubBtn.addEventListener("pointerdown", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.toggleLibrary();
        return;
      }
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      const start = { ...this.position };

      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
        this.position = { x: start.x + dx, y: start.y + dy };
        this.applyPosition();
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (moved) this.savePosition();
        else this.setExpanded(!this.expanded); // clic simple: abrir/cerrar
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private bindPin(): void {
    this.pinDot.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.pinDot.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pinned = !this.pinned;
      this.pinDot.classList.toggle("is-pinned", this.pinned);
      this.pinDot.title = this.pinned ? "Fijada (clic para soltar)" : "Fijar (que no se cierre al hacer clic fuera)";
    });
  }

  private applyPosition(): void {
    this.container.style.left = `${this.position.x}px`;
    this.container.style.top = `${this.position.y}px`;
  }

  private savePosition(): void {
    localStorage.setItem(POS_KEY, JSON.stringify(this.position));
  }

  private setExpanded(on: boolean): void {
    this.expanded = on;
    window.clearTimeout(this.collapseTimer);
    // SVGSVGElement no tipa `hidden`; el atributo cae bajo [hidden] en el CSS.
    if (on) {
      this.ringsSvg.classList.remove("is-leaving");
      this.gradientSvg.classList.remove("is-leaving");
      // Quitar `hidden` (display: none -> visible) reinicia la animacion -in.
      this.ringsSvg.toggleAttribute("hidden", false);
      this.gradientSvg.toggleAttribute("hidden", false);
      this.buildRings();
      this.container.classList.add("is-expanded");
    } else {
      // Deja correr la animacion de salida antes de esconder los anillos.
      this.ringsSvg.classList.add("is-leaving");
      this.gradientSvg.classList.add("is-leaving");
      this.container.classList.remove("is-expanded");
      this.collapseTimer = window.setTimeout(() => {
        this.ringsSvg.toggleAttribute("hidden", true);
        this.gradientSvg.toggleAttribute("hidden", true);
        this.ringsSvg.classList.remove("is-leaving");
        this.gradientSvg.classList.remove("is-leaving");
      }, 160);
    }
  }

  private setPalette(id: string): void {
    this.paletteId = id;
    this.palette = this.resolvePalette(id);
    localStorage.setItem(PAL_KEY, id);
    this.buildRings();
    this.markLibrary();
    this.library.hidden = true;
  }

  private toggleLibrary(): void {
    this.library.hidden = !this.library.hidden;
  }

  // -------------------------------------------------------------------- api

  get isVisible(): boolean {
    return this.visible;
  }

  show(): void {
    if (this.visible) return;
    window.clearTimeout(this.hideTimer);
    this.visible = true;
    this.el.hidden = false;
    // Si quedo fuera de pantalla (cambio de resolucion), recentrar.
    if (
      this.position.x < 40 || this.position.y < 40 ||
      this.position.x > window.innerWidth - 40 || this.position.y > window.innerHeight - 40
    ) {
      this.position = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      this.applyPosition();
    }
    // Reinicia la animacion de entrada del nucleo (quitar/forzar reflow/poner).
    this.hubBtn.classList.remove("is-leaving");
    this.hubBtn.classList.remove("is-entering");
    void this.hubBtn.offsetWidth;
    this.hubBtn.classList.add("is-entering");
    this.setExpanded(true);
    document.addEventListener("pointerdown", this.onDocDown, true);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.library.hidden = true;
    this.stopMomentum();
    document.removeEventListener("pointerdown", this.onDocDown, true);
    // Anima la salida (muestras y nucleo) y esconde al terminar.
    this.setExpanded(false);
    this.hubBtn.classList.remove("is-entering");
    this.hubBtn.classList.add("is-leaving");
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.el.hidden = true;
      this.hubBtn.classList.remove("is-leaving");
    }, 260);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  dispose(): void {
    this.stopMomentum();
    window.clearTimeout(this.collapseTimer);
    window.clearTimeout(this.hideTimer);
    document.removeEventListener("pointerdown", this.onDocDown, true);
    this.el.remove();
  }
}
