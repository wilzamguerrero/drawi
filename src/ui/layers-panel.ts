import type { Editor, EditorState } from "../app/editor";
import {
  BLEND_LABELS,
  BLEND_ORDER,
  LAYER_COLOR_HEX,
  LAYER_COLOR_LABELS,
  LAYER_COLOR_ORDER,
  type BlendMode,
  type SceneLayer,
} from "../scene/layer";
import { transformCtx } from "../core/mat2d";
import { cssRgba, hexToRgb } from "../core/color";
import { polygonToPath2D } from "../stroke/outline";
import type { InkItem } from "../scene/types";
import { button, slider, select } from "./controls";
import { clear, el, setClass } from "./dom";
import { icon } from "./icons";

/** Referencias vivas de una fila del panel (para sincronizar sin reconstruir). */
interface Row {
  el: HTMLElement;
  thumb: HTMLCanvasElement;
  maskThumb: HTMLCanvasElement;
  name: HTMLElement;
  eye: HTMLButtonElement;
  strip: HTMLElement;
  depth: number;
}

/** Una entrada de la lista visual: capa + su nivel de anidamiento. */
interface DisplayItem {
  layer: SceneLayer;
  depth: number;
}

/**
 * Panel de capas (estilo Photoshop) para el dock lateral.
 *
 * No se reconstruye en cada fotograma: mantiene un mapa de filas por id y solo
 * rehace el DOM cuando cambia la "firma" (orden, anidamiento, plegado, presencia
 * de máscara). El resto —nombre, ojo, opacidad, miniaturas, capa activa— se
 * sincroniza in situ. Las miniaturas se repintan solo cuando cambia `inkRevision`.
 */
export class LayersPanel {
  readonly el: HTMLElement;

  private list: HTMLElement;
  private rows = new Map<string, Row>();
  private signature = "";
  private thumbRevision = -1;

  // Cabecera: propiedades de la capa activa.
  private blendSel!: ReturnType<typeof select<BlendMode>>;
  private opacity!: ReturnType<typeof slider>;
  private fill!: ReturnType<typeof slider>;
  private lockBtn!: ReturnType<typeof button>;
  private alphaBtn!: ReturnType<typeof button>;
  private maskModeBtn!: ReturnType<typeof button>;
  private head: HTMLElement;

  // Arrastre en curso.
  private dragId: string | null = null;
  private dropLine: HTMLElement;
  private dropGap = -1;

  constructor(private editor: Editor) {
    this.head = this.buildHead();
    this.list = el("div", { class: "layers-list" });
    this.dropLine = el("div", { class: "layers-drop-line" });
    this.list.appendChild(this.dropLine);
    const footer = this.buildFooter();
    this.el = el("div", { class: "layers-panel" }, [this.head, this.list, footer]);
  }

  // ----------------------------------------------------------- cabecera
  private buildHead(): HTMLElement {
    const ed = this.editor;
    this.blendSel = select<BlendMode>({
      label: "Fusión",
      options: BLEND_ORDER.map((b) => ({ value: b, label: BLEND_LABELS[b] })),
      value: "source-over",
      onChange: (v) => this.editActive((id) => ed.setLayer(id, { blend: v })),
    });
    this.opacity = slider({
      label: "Opacidad", min: 0, max: 100, step: 1, unit: "%", value: 100,
      onInput: (v) => this.editActive((id) => ed.setLayer(id, { opacity: v / 100 })),
    });
    this.fill = slider({
      label: "Relleno", min: 0, max: 100, step: 1, unit: "%", value: 100,
      onInput: (v) => this.editActive((id) => ed.setLayer(id, { fill: v / 100 })),
    });
    this.lockBtn = button({ iconName: "lock", title: "Bloquear capa", onClick: () => this.editActive((id) => ed.setLayer(id, { locked: !this.active()?.locked })) });
    this.alphaBtn = button({ iconName: "droplet", title: "Bloquear transparencia (alfa)", onClick: () => this.editActive((id) => ed.setLayer(id, { alphaLock: !this.active()?.alphaLock })) });
    this.maskModeBtn = button({ iconName: "mask", title: "Pintar la máscara de la capa (Esc para salir)", onClick: () => ed.toggleMaskMode() });
    const locks = el("div", { class: "layers-locks" }, [this.lockBtn.el, this.alphaBtn.el, this.maskModeBtn.el]);
    return el("div", { class: "layers-head" }, [this.blendSel.el, this.opacity.el, this.fill.el, locks]);
  }

  // ------------------------------------------------------------ pie
  private buildFooter(): HTMLElement {
    const ed = this.editor;
    const clip = button({ iconName: "clip", title: "Recortar a la capa inferior (Ctrl+G)", onClick: () => this.editActive((id) => ed.setLayer(id, { clip: !this.active()?.clip })) });
    const mask = button({ iconName: "mask", title: "Añadir máscara", onClick: () => this.editActive((id) => ed.toggleLayerMask(id)) });
    const group = button({ iconName: "folder", title: "Nuevo grupo (Ctrl+Shift+G)", onClick: () => ed.addGroup() });
    const add = button({ iconName: "plus", title: "Nueva capa (Ctrl+Shift+N)", onClick: () => ed.addLayer() });
    const matter = button({ iconName: "matter", title: "Nueva capa de materia", onClick: () => ed.addMatterLayer() });
    const del = button({ iconName: "trash", variant: "danger", title: "Borrar capa (Supr)", onClick: () => this.deleteActive() });
    return el("div", { class: "layers-footer" }, [clip.el, mask.el, group.el, add.el, matter.el, del.el]);
  }

  private active(): SceneLayer | undefined {
    return this.editor.doc.activeLayer;
  }

  /** Papelera / Supr sobre la capa activa. Materia sí es una capa eliminable. */
  private deleteActive(): void {
    const l = this.active();
    if (!l) return;
    if (l.kind === "matter") this.editor.removeLayer(l.id);
    else this.editor.removeLayer(l.id);
  }

  /** Ejecuta una acción sobre la capa activa. La materia acepta opacidad, fusión
   * y bloqueo; los ajustes que no le aplican (recorte, alfa, máscara) los ignora
   * el compositor de materia. */
  private editActive(run: (id: string) => void): void {
    const l = this.active();
    if (l) run(l.id);
  }
  // METHODS_PLACEHOLDER

  /** Lista visual (arriba = frente): recorre la raíz de mayor a menor z. */
  private flatten(): DisplayItem[] {
    const out: DisplayItem[] = [];
    const walk = (parentId: string | null, depth: number): void => {
      const kids = this.editor.doc.layers.filter((l) => l.parentId === parentId);
      for (let i = kids.length - 1; i >= 0; i--) {
        const l = kids[i];
        out.push({ layer: l, depth });
        if (l.kind === "group" && !l.collapsed) walk(l.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  /** Firma estructural: si cambia, se reconstruyen las filas. */
  private sigOf(items: DisplayItem[]): string {
    return items
      .map((d) => `${d.layer.id}:${d.depth}:${d.layer.kind}:${d.layer.collapsed}:${d.layer.mask ? 1 : 0}`)
      .join("|");
  }

  update(state: EditorState): void {
    const items = this.flatten();
    const sig = this.sigOf(items);
    if (sig !== this.signature) {
      this.rebuild(items);
      this.signature = sig;
    }
    // Sincronía viva de cada fila.
    for (const { layer } of items) this.syncRow(layer, state);
    // Miniaturas: solo si cambió la tinta.
    if (this.editor.doc.inkRevision !== this.thumbRevision) {
      for (const { layer } of items) this.paintThumb(layer);
      this.thumbRevision = this.editor.doc.inkRevision;
    }
    this.syncHead(state);
  }

  /** Cabecera: refleja las propiedades de la capa activa. La materia usa
   * opacidad/fusión/bloqueo; alfa, recorte y máscara solo aplican a la tinta. */
  private syncHead(state: EditorState): void {
    const l = this.editor.doc.activeLayer;
    setClass(this.head, "is-disabled", !l);
    if (!l) return;
    const inkLike = l.kind !== "matter";
    this.blendSel.set(l.blend);
    this.opacity.set(Math.round(l.opacity * 100));
    this.fill.set(Math.round(l.fill * 100));
    this.lockBtn.setActive(l.locked);
    this.alphaBtn.setActive(l.alphaLock);
    this.maskModeBtn.setActive(state.maskMode);
    // Los controles que no aplican a la materia se atenúan sin ocultarse.
    setClass(this.alphaBtn.el, "is-disabled", !inkLike);
    setClass(this.maskModeBtn.el, "is-disabled", !inkLike);
  }

  /** Rehace la lista de filas conservando el mapa por id. */
  private rebuild(items: DisplayItem[]): void {
    clear(this.list);
    this.list.appendChild(this.dropLine);
    const seen = new Set<string>();
    for (const { layer, depth } of items) {
      seen.add(layer.id);
      let row = this.rows.get(layer.id);
      if (!row || row.depth !== depth) {
        row = this.buildRow(layer, depth);
        this.rows.set(layer.id, row);
      }
      this.list.appendChild(row.el);
    }
    for (const id of [...this.rows.keys()]) if (!seen.has(id)) this.rows.delete(id);
  }

  /** Construye la fila de una capa. */
  private buildRow(layer: SceneLayer, depth: number): Row {
    const ed = this.editor;
    const strip = el("span", { class: "layer-strip" });
    const eye = el("button", { class: "layer-eye", type: "button", title: "Mostrar/ocultar (Alt: aislar)" });
    eye.innerHTML = icon("eye");
    eye.addEventListener("click", (e) => {
      if (e.altKey) ed.toggleSolo(layer.id);
      else ed.setLayer(layer.id, { visible: !layer.visible });
    });
    const thumb = el("canvas", { class: "layer-thumb" });
    thumb.width = 40; thumb.height = 40;
    const maskThumb = el("canvas", { class: "layer-mask-thumb" });
    maskThumb.width = 28; maskThumb.height = 28;
    maskThumb.title = "Máscara · doble clic para invertir (Ctrl+I)";
    maskThumb.setAttribute("aria-label", "Máscara de capa");
    maskThumb.addEventListener("dblclick", () => ed.invertLayerMask(layer.id));
    const name = el("span", { class: "layer-name", text: layer.name });
    name.addEventListener("dblclick", () => this.editName(layer, name));
    const grip = el("span", { class: "layer-grip", html: icon("grip"), title: "Arrastrar para reordenar" });
    grip.addEventListener("pointerdown", (e) => this.onDragStart(e, layer.id));
    const badges = el("span", { class: "layer-badges" });

    const kindIcon = layer.kind === "group" ? "folder" : layer.kind === "matter" ? "matter" : null;
    const glyph = kindIcon ? el("span", { class: "layer-kind", html: icon(kindIcon) }) : thumb;

    const rowEl = el("div", { class: `layer-row depth-${Math.min(depth, 4)}` }, [
      strip, eye, glyph, name, maskThumb, badges, grip,
    ]);
    rowEl.dataset.id = layer.id;
    rowEl.addEventListener("click", () => ed.setActiveLayer(layer.id));
    rowEl.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openMenu(layer, e); });
    if (layer.kind === "group") {
      glyph.addEventListener("click", (e) => { e.stopPropagation(); ed.setLayer(layer.id, { collapsed: !layer.collapsed }); });
    }
    return { el: rowEl, thumb, maskThumb, name, eye, strip, depth };
  }

  /** Sincroniza los bits vivos de una fila (ojo, activa, bloqueos, color, máscara). */
  private syncRow(layer: SceneLayer, state: EditorState): void {
    const row = this.rows.get(layer.id);
    if (!row) return;
    const solo = state.soloLayerId;
    const dimmed = solo !== null && solo !== layer.id && !this.inSolo(layer, solo);
    setClass(row.el, "is-active", layer.id === state.activeLayerId);
    setClass(row.el, "is-hidden-layer", !layer.visible);
    setClass(row.el, "is-solo-dim", dimmed);
    setClass(row.el, "is-locked", layer.locked);
    setClass(row.el, "is-clip", layer.clip);
    setClass(row.el, "is-alpha", layer.alphaLock);
    setClass(row.el, "is-mask-active", state.maskMode && layer.id === state.activeLayerId);
    row.eye.innerHTML = icon(layer.visible ? "eye" : "eyeOff");
    setClass(row.eye, "is-solo", solo === layer.id);
    if (row.name.textContent !== layer.name && document.activeElement !== row.name) {
      row.name.textContent = layer.name;
    }
    row.strip.style.background = LAYER_COLOR_HEX[layer.color];
    setClass(row.strip, "has-color", layer.color !== "none");
    setClass(row.maskThumb, "is-hidden", !layer.mask);
    setClass(row.maskThumb, "is-inverted", !!layer.mask?.inverted);
    if (layer.mask) {
      row.maskThumb.title = layer.mask.inverted
        ? "Máscara invertida · doble clic para volver a invertir (Ctrl+I)"
        : "Máscara normal · doble clic para invertir (Ctrl+I)";
      row.maskThumb.setAttribute("aria-label", layer.mask.inverted ? "Máscara invertida" : "Máscara normal");
    }
  }

  /** ¿La capa está dentro del ámbito de la aislada (su grupo o descendiente)? */
  private inSolo(layer: SceneLayer, soloId: string): boolean {
    let p = layer.parentId;
    while (p) {
      if (p === soloId) return true;
      p = this.editor.doc.layerById(p)?.parentId ?? null;
    }
    let q: string | null = soloId;
    while (q) {
      const l = this.editor.doc.layerById(q);
      if (!l) break;
      if (l.parentId === layer.id) return true;
      q = l.parentId;
    }
    return false;
  }

  /** Renombra una capa in situ (doble clic). */
  private editName(layer: SceneLayer, node: HTMLElement): void {
    const input = el("input", { class: "layer-name-edit", type: "text", value: layer.name });
    node.replaceWith(input);
    input.focus();
    input.select();
    const commit = (): void => {
      const v = input.value.trim() || layer.name;
      this.editor.setLayer(layer.id, { name: v });
      input.replaceWith(node);
      node.textContent = v;
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") { input.value = layer.name; input.blur(); }
    });
  }

  // --------------------------------------------------------- miniaturas
  private paintThumb(layer: SceneLayer): void {
    const row = this.rows.get(layer.id);
    if (!row || layer.kind !== "ink") {
      if (row && layer.mask) this.paintMask(layer, row);
      return;
    }
    const ctx = row.thumb.getContext("2d");
    if (!ctx) return;
    const W = row.thumb.width, H = row.thumb.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const items = this.editor.doc.layerItems(layer.id);
    this.fitAndFill(ctx, W, H, items, false);
    if (layer.mask) this.paintMask(layer, row);
  }

  private paintMask(layer: SceneLayer, row: Row): void {
    const ctx = row.maskThumb.getContext("2d");
    if (!ctx || !layer.mask) return;
    const W = row.maskThumb.width, H = row.maskThumb.height;
    const inverted = layer.mask.inverted;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // La miniatura usa la misma convención que el compositor: el fondo
    // representa el estado por defecto y cada trazo cambia oculto/revelado.
    ctx.fillStyle = inverted ? "#000" : "#fff";
    ctx.fillRect(0, 0, W, H);
    this.fitAndFill(ctx, W, H, layer.mask.items, true, inverted);
  }

  /** Encaja los items en el lienzo (según la caja del documento) y los rellena. */
  private fitAndFill(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    items: readonly InkItem[],
    mask: boolean,
    inverted = false,
  ): void {
    const b = this.editor.doc.contentBounds();
    if (b.w <= 0 || b.h <= 0) return;
    const pad = 4;
    const scale = Math.min((W - pad) / b.w, (H - pad) / b.h);
    const ox = (W - b.w * scale) / 2 - b.x * scale;
    const oy = (H - b.h * scale) / 2 - b.y * scale;
    for (const item of items) {
      // En una máscara, erase representa un trazo de revelado. Al invertir,
      // los papeles de ocultar y revelar se intercambian visualmente.
      if (!mask && item.erase) continue;
      const paths = item.polys.filter((p) => p.length >= 3).map((p) => polygonToPath2D(p, item.smooth));
      if (paths.length === 0) continue;
      if (mask) {
        const reveal = item.erase !== inverted;
        ctx.fillStyle = reveal
          ? `rgba(255,255,255,${item.opacity})`
          : `rgba(0,0,0,${item.opacity})`;
      } else {
        ctx.fillStyle = cssRgba(hexToRgb(item.color), item.opacity);
      }
      for (const m of item.transforms) {
        ctx.setTransform(scale, 0, 0, scale, ox, oy);
        transformCtx(ctx, m);
        for (const path of paths) ctx.fill(path, "nonzero");
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ----------------------------------------------------------- arrastre
  private onDragStart(e: PointerEvent, id: string): void {
    e.preventDefault();
    e.stopPropagation();
    this.dragId = id;
    this.list.classList.add("is-dragging");
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
    window.addEventListener("pointercancel", this.onDragEnd);
  }

  private onDragMove = (e: PointerEvent): void => {
    if (this.dragId === null) return;
    const gap = this.gapAt(e.clientY);
    this.dropGap = gap;
    this.showDropLine(gap);
  };

  private onDragEnd = (): void => {
    if (this.dragId === null) return;
    const id = this.dragId;
    const gap = this.dropGap;
    this.dragId = null;
    this.dropGap = -1;
    this.list.classList.remove("is-dragging");
    this.dropLine.style.display = "none";
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
    window.removeEventListener("pointercancel", this.onDragEnd);
    if (gap >= 0) this.applyDrop(id, gap);
  };

  /** Índice de hueco (0 = arriba del todo) según la Y del puntero. */
  private gapAt(clientY: number): number {
    const items = this.flatten();
    for (let i = 0; i < items.length; i++) {
      const row = this.rows.get(items[i].layer.id);
      if (!row) continue;
      const r = row.el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return items.length;
  }

  private showDropLine(gap: number): void {
    const items = this.flatten();
    const listRect = this.list.getBoundingClientRect();
    let y: number;
    if (gap >= items.length) {
      const last = this.rows.get(items[items.length - 1]?.layer.id ?? "");
      y = last ? last.el.getBoundingClientRect().bottom - listRect.top : 0;
    } else {
      const row = this.rows.get(items[gap].layer.id);
      y = row ? row.el.getBoundingClientRect().top - listRect.top : 0;
    }
    this.dropLine.style.display = "block";
    this.dropLine.style.top = `${y + this.list.scrollTop}px`;
  }

  /** Traduce el hueco visual a `moveLayer(id, beforeId, parentId)`. */
  private applyDrop(id: string, gap: number): void {
    const items = this.flatten();
    // La capa que quedará visualmente ENCIMA del hueco marca el destino en z.
    const above = gap > 0 ? items[gap - 1].layer : null;
    // No soltar un grupo dentro de sí mismo.
    if (above && this.isDescendant(above.id, id)) return;
    const beforeId = above ? above.id : null;
    const parentId = above ? above.parentId : null;
    this.editor.moveLayer(id, beforeId, parentId);
  }

  /** ¿`maybeChild` está dentro de `ancestorId` (o es él mismo)? */
  private isDescendant(maybeChild: string, ancestorId: string): boolean {
    let p: string | null = maybeChild;
    while (p) {
      if (p === ancestorId) return true;
      p = this.editor.doc.layerById(p)?.parentId ?? null;
    }
    return false;
  }

  // ------------------------------------------------------- menú contextual
  /** Menú de clic derecho sobre una capa: duplicar, combinar, aplanar, color. */
  private openMenu(layer: SceneLayer, e: MouseEvent): void {
    const ed = this.editor;
    document.querySelector(".layers-menu")?.remove();
    const menu = el("div", { class: "layers-menu" });
    const item = (label: string, run: () => void, disabled = false): void => {
      const b = el("button", { class: "layers-menu-item", type: "button", text: label });
      if (disabled) b.classList.add("is-disabled");
      else b.addEventListener("click", () => { run(); close(); });
      menu.appendChild(b);
    };
    const sep = (): void => { menu.appendChild(el("div", { class: "layers-menu-sep" })); };

    const isInk = layer.kind === "ink";
    const isMatter = layer.kind === "matter";
    if (isMatter) {
      // La materia sí es una capa eliminable: vaciar sus cuerpos o borrar la capa.
      item("Vaciar materia", () => ed.clearMatterLayer(layer.id));
      item("Borrar capa", () => ed.removeLayer(layer.id));
      sep();
    } else {
      item("Duplicar", () => ed.duplicateLayer(layer.id), !isInk);
      item("Combinar hacia abajo", () => ed.mergeLayerDown(layer.id), !isInk);
      item("Aplanar imagen", () => ed.flattenLayers());
      sep();
      item(layer.mask ? "Quitar máscara" : "Añadir máscara", () => ed.toggleLayerMask(layer.id));
      if (layer.mask) item("Invertir máscara", () => ed.invertLayerMask(layer.id));
      sep();
    }

    // Submenú de etiquetas de color.
    const colors = el("div", { class: "layers-menu-colors" });
    for (const c of LAYER_COLOR_ORDER) {
      const dot = el("button", {
        class: "layers-menu-color",
        type: "button",
        title: LAYER_COLOR_LABELS[c],
      });
      dot.style.background = c === "none" ? "transparent" : LAYER_COLOR_HEX[c];
      setClass(dot, "is-none", c === "none");
      setClass(dot, "is-active", layer.color === c);
      dot.addEventListener("click", () => { ed.setLayerColor(layer.id, c); close(); });
      colors.appendChild(dot);
    }
    menu.appendChild(colors);

    const close = (): void => {
      menu.remove();
      window.removeEventListener("pointerdown", onOutside, true);
    };
    const onOutside = (ev: PointerEvent): void => {
      if (!menu.contains(ev.target as Node)) close();
    };

    document.body.appendChild(menu);
    // Situar junto al puntero sin desbordar la ventana.
    const rect = menu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
    window.addEventListener("pointerdown", onOutside, true);
  }
}

