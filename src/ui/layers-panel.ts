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
  /** Arrastre armado pero aún no confirmado: hace falta superar el umbral para
   *  distinguir "he hecho clic para seleccionar" de "estoy moviendo la capa". */
  private pendingId: string | null = null;
  private pendingY = 0;
  private dropLine: HTMLElement;
  private dropGap = -1;
  /** Autodesplazamiento al arrastrar junto a los bordes de la lista. */
  private scrollRaf = 0;
  private scrollDir = 0;
  private lastPointerY = 0;

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
    const aqua = button({ iconName: "droplet", title: "Nueva capa de acuarela", onClick: () => ed.addAquaLayer() });
    const del = button({ iconName: "trash", variant: "danger", title: "Borrar capa (Supr)", onClick: () => this.deleteActive() });
    return el("div", { class: "layers-footer" }, [clip.el, mask.el, group.el, add.el, matter.el, aqua.el, del.el]);
  }

  private active(): SceneLayer | undefined {
    return this.editor.doc.activeLayer;
  }

  /**
   * La capa de una fila, leída del documento en el momento de actuar.
   *
   * Las filas no se reconstruyen en cada fotograma, así que un manejador que se
   * quedara con el objeto `SceneLayer` del momento en que se creó la fila
   * trabajaría con una copia congelada: `doc.restore` (deshacer, rehacer, abrir
   * un proyecto) sustituye TODAS las capas por clones con el mismo id. Eso era
   * lo que dejaba el ojo sin respuesta —el icono se veía bien porque se pinta
   * desde el documento, pero el clic calculaba `!visible` sobre el objeto viejo
   * y escribía el valor que ya tenía—. Por eso todo manejador pasa por aquí.
   */
  private layerOf(id: string): SceneLayer | undefined {
    return this.editor.doc.layerById(id);
  }

  /** Papelera / Supr sobre la capa activa. */
  private deleteActive(): void {
    const l = this.active();
    if (l) this.editor.removeLayer(l.id);
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
    } else {
      // La acuarela se mueve sola mientras el fluido sigue vivo, sin tocar
      // `inkRevision`. Su miniatura se refresca aparte y a ritmo lento: es un
      // sello de 40 px, no hace falta seguirlo fotograma a fotograma.
      const now = performance.now();
      if (now - this.aquaThumbAt > 250) {
        this.aquaThumbAt = now;
        for (const { layer } of items) if (layer.kind === "aqua") this.paintThumb(layer);
      }
    }
    this.syncHead(state);
  }

  /** Último refresco de las miniaturas de acuarela (ms de `performance.now`). */
  private aquaThumbAt = 0;

  /** Cabecera: refleja las propiedades de la capa activa. La materia usa
   * opacidad/fusión/bloqueo; el alfa bloqueado solo tiene sentido en la tinta,
   * pero la máscara se aplica a todo lo que el compositor compone (incluida la
   * acuarela). */
  private syncHead(state: EditorState): void {
    const l = this.editor.doc.activeLayer;
    setClass(this.head, "is-disabled", !l);
    if (!l) return;
    const composed = l.kind !== "matter";
    this.blendSel.set(l.blend);
    this.opacity.set(Math.round(l.opacity * 100));
    this.fill.set(Math.round(l.fill * 100));
    this.lockBtn.setActive(l.locked);
    this.alphaBtn.setActive(l.alphaLock);
    this.maskModeBtn.setActive(state.maskMode);
    // Los controles que no aplican se atenúan sin ocultarse.
    setClass(this.alphaBtn.el, "is-disabled", l.kind !== "ink");
    setClass(this.maskModeBtn.el, "is-disabled", !composed);
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

  /** Construye la fila de una capa. Ningún manejador se queda con `layer`: todos
   *  releen la capa por id (ver `layerOf`). */
  private buildRow(layer: SceneLayer, depth: number): Row {
    const ed = this.editor;
    const id = layer.id;
    const strip = el("span", { class: "layer-strip" });
    const eye = el("button", { class: "layer-eye", type: "button", title: "Mostrar/ocultar (Alt: aislar)" });
    eye.innerHTML = icon("eye");
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.altKey) {
        ed.toggleSolo(id);
        return;
      }
      const l = this.layerOf(id);
      if (l) ed.setLayer(id, { visible: !l.visible });
    });
    const thumb = el("canvas", { class: "layer-thumb" });
    thumb.width = 40; thumb.height = 40;
    const maskThumb = el("canvas", { class: "layer-mask-thumb" });
    maskThumb.width = 28; maskThumb.height = 28;
    maskThumb.title = "Máscara · doble clic para invertir (Ctrl+I)";
    maskThumb.setAttribute("aria-label", "Máscara de capa");
    maskThumb.addEventListener("dblclick", () => ed.invertLayerMask(id));
    const name = el("span", { class: "layer-name", text: layer.name });
    name.addEventListener("dblclick", () => {
      const l = this.layerOf(id);
      if (l) this.editName(l, name);
    });
    const grip = el("span", { class: "layer-grip", html: icon("grip"), title: "Arrastra la fila para reordenar" });
    const badges = el("span", { class: "layer-badges" });

    const kindIcon =
      layer.kind === "group" ? "folder" : layer.kind === "matter" ? "matter" : null;
    // La acuarela sí lleva miniatura: su mancha es lo que la identifica.
    const glyph = kindIcon ? el("span", { class: "layer-kind", html: icon(kindIcon) }) : thumb;

    const rowEl = el("div", { class: `layer-row depth-${Math.min(depth, 4)}` }, [
      strip, eye, glyph, name, maskThumb, badges, grip,
    ]);
    rowEl.dataset.id = id;
    // Toda la barra arrastra, como en Photoshop: el asa de la derecha se queda
    // solo como pista visual. La selección pasa a `pointerdown` (y no a `click`)
    // porque al soltar un arrastre no debe cambiar la capa activa.
    rowEl.addEventListener("pointerdown", (e) => this.onRowPointerDown(e, id));
    rowEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const l = this.layerOf(id);
      if (l) this.openMenu(l, e);
    });
    if (layer.kind === "group") {
      glyph.addEventListener("click", (e) => {
        e.stopPropagation();
        const l = this.layerOf(id);
        if (l) ed.setLayer(id, { collapsed: !l.collapsed });
      });
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
  private imageThumbCache = new Map<string, HTMLImageElement>();

  private paintThumb(layer: SceneLayer): void {
    const row = this.rows.get(layer.id);
    if (!row) return;
    if (layer.kind === "aqua") {
      this.paintAquaThumb(layer, row);
      return;
    }
    if (layer.kind === "image") {
      const ctx = row.thumb.getContext("2d");
      if (!ctx) return;
      const W = row.thumb.width, H = row.thumb.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, W, H);
      const src = layer.imageSrc ?? "";
      if (src) {
        let img = this.imageThumbCache.get(src);
        if (!img) {
          img = new Image();
          img.src = src;
          this.imageThumbCache.set(src, img);
          img.onload = () => this.paintThumb(layer);
        }
        if (img.complete && img.naturalWidth > 0) {
          const b = this.editor.doc.contentBounds();
          const pad = 4;
          const scale = b.w > 0 ? Math.min((W - pad) / b.w, (H - pad) / b.h) : 1;
          const ox = (W - (layer.imageW ?? img.naturalWidth) * scale) / 2 - (layer.imageX ?? 0 - (b.x ?? 0)) * scale;
          // Simple cover: center image in thumb (not world-accurate but gives preview)
          const iw = layer.imageW ?? img.naturalWidth;
          const ih = layer.imageH ?? img.naturalHeight;
          const s2 = Math.min(W / iw, H / ih) * 0.9;
          const dx = (W - iw * s2) / 2;
          const dy = (H - ih * s2) / 2;
          // Use world composition bounds for positioning would require camera; quick center.
          ctx.drawImage(img, dx, dy, iw * s2, ih * s2);
          void ox;
        }
      }
      if (layer.mask) this.paintMask(layer, row);
      return;
    }
    if (layer.kind !== "ink") {
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

  /**
   * Miniatura de una capa de acuarela: lo ya horneado (en mundo, encajado como
   * el resto de miniaturas) y encima el fluido vivo (en pantalla, encajado a la
   * miniatura entera). Es el mismo orden que usa el compositor.
   */
  private paintAquaThumb(layer: SceneLayer, row: Row): void {
    const ctx = row.thumb.getContext("2d");
    if (!ctx) return;
    const W = row.thumb.width, H = row.thumb.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const baked = layer.aquaBaked ? this.imageThumbCache.get(layer.aquaBaked) : undefined;
    if (layer.aquaBaked && !baked) {
      const img = new Image();
      img.src = layer.aquaBaked;
      this.imageThumbCache.set(layer.aquaBaked, img);
      img.onload = () => this.paintThumb(layer);
    }
    const rect = layer.aquaRect;
    if (baked?.complete && baked.naturalWidth > 0 && rect) {
      const b = this.editor.doc.contentBounds();
      if (b.w > 0 && b.h > 0) {
        const pad = 4;
        const scale = Math.min((W - pad) / b.w, (H - pad) / b.h);
        const ox = (W - b.w * scale) / 2 - b.x * scale;
        const oy = (H - b.h * scale) / 2 - b.y * scale;
        ctx.setTransform(scale, 0, 0, scale, ox, oy);
        ctx.drawImage(baked, rect.x, rect.y, rect.w, rect.h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    const live = this.editor.aquaCanvasFor(layer.id);
    if (live && live.width > 0) ctx.drawImage(live, 0, 0, W, H);
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

  /** Píxeles que hay que recorrer para que un clic pase a ser un arrastre. */
  private static readonly DRAG_THRESHOLD = 4;
  /** Franja junto a los bordes de la lista que activa el autodesplazamiento. */
  private static readonly EDGE = 26;

  /**
   * Botón primario sobre una fila: selecciona ya y arma un posible arrastre.
   *
   * No se arrastra desde los controles de la fila (ojo, máscara, carpeta de un
   * grupo, nombre en edición): ahí el gesto es un clic con significado propio.
   */
  private onRowPointerDown(e: PointerEvent, id: string): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(".layer-eye, .layer-mask-thumb, .layer-name-edit, .layer-kind")) return;
    this.editor.setActiveLayer(id);
    const l = this.layerOf(id);
    if (!l || l.locked) return; // una capa bloqueada no se mueve
    this.pendingId = id;
    this.pendingY = e.clientY;
    this.lastPointerY = e.clientY;
    // Captura en la fila: el puntero puede salirse de la lista sin perder el
    // gesto, que es justo lo que hace falta para arrastrar hasta los extremos.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Sin captura el arrastre sigue funcionando vía window; no es crítico.
    }
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
    window.addEventListener("pointercancel", this.onDragEnd);
  }

  private onDragMove = (e: PointerEvent): void => {
    this.lastPointerY = e.clientY;
    // Mientras no se supere el umbral, esto sigue siendo un clic.
    if (this.dragId === null) {
      if (this.pendingId === null) return;
      if (Math.abs(e.clientY - this.pendingY) < LayersPanel.DRAG_THRESHOLD) return;
      this.dragId = this.pendingId;
      this.list.classList.add("is-dragging");
      this.rows.get(this.dragId)?.el.classList.add("is-drag-source");
      this.startAutoScroll();
    }
    e.preventDefault();
    this.dropGap = this.gapAt(e.clientY);
    this.showDropLine(this.dropGap);
  };

  private onDragEnd = (): void => {
    const id = this.dragId;
    const gap = this.dropGap;
    if (id !== null) this.rows.get(id)?.el.classList.remove("is-drag-source");
    this.dragId = null;
    this.pendingId = null;
    this.dropGap = -1;
    this.stopAutoScroll();
    this.list.classList.remove("is-dragging");
    this.dropLine.style.display = "none";
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
    window.removeEventListener("pointercancel", this.onDragEnd);
    if (id !== null && gap >= 0) this.applyDrop(id, gap);
  };

  /** Desplaza la lista mientras el puntero se mantiene junto a un borde. */
  private startAutoScroll(): void {
    if (this.scrollRaf) return;
    const tick = (): void => {
      if (this.dragId === null) {
        this.scrollRaf = 0;
        return;
      }
      const r = this.list.getBoundingClientRect();
      const y = this.lastPointerY;
      this.scrollDir = y < r.top + LayersPanel.EDGE ? -1 : y > r.bottom - LayersPanel.EDGE ? 1 : 0;
      if (this.scrollDir !== 0) {
        this.list.scrollTop += this.scrollDir * 8;
        this.dropGap = this.gapAt(y);
        this.showDropLine(this.dropGap);
      }
      this.scrollRaf = requestAnimationFrame(tick);
    };
    this.scrollRaf = requestAnimationFrame(tick);
  }

  private stopAutoScroll(): void {
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.scrollRaf = 0;
    this.scrollDir = 0;
  }

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

  /**
   * Traduce el hueco visual a `moveLayerTo(id, parentId, index)`.
   *
   * Se razona con la lista VISIBLE, no con el array de capas: el destino sale de
   * quién queda justo encima del hueco (si es un grupo abierto, se entra en él)
   * y la posición, de cuántas hermanas quedan por debajo. Antes se traducía a un
   * índice absoluto del array y soltar junto a un grupo abierto no movía nada.
   */
  private applyDrop(id: string, gap: number): void {
    const doc = this.editor.doc;
    const dragged = doc.layerById(id);
    if (!dragged) return;
    const items = this.flatten();
    const above = gap > 0 ? items[gap - 1].layer : null;

    let parentId: string | null = null;
    if (above) {
      // Soltar justo debajo de la cabecera de un grupo abierto = entrar en él.
      parentId = above.kind === "group" && !above.collapsed ? above.id : above.parentId;
    }
    // Un grupo no puede caer dentro de sí mismo ni de sus descendientes.
    if (parentId && doc.isDescendantOf(parentId, id)) return;
    // Materia y acuarela son planos propios: siempre en la raíz.
    if (dragged.kind === "matter" || dragged.kind === "aqua") parentId = null;

    // Posición entre hermanas, de abajo arriba: las que quedan bajo el hueco.
    const sibIds = new Set(
      doc.childLayers(parentId).filter((l) => l.id !== id).map((l) => l.id),
    );
    let below = 0;
    for (let i = gap; i < items.length; i++) if (sibIds.has(items[i].layer.id)) below++;

    this.editor.moveLayerTo(id, parentId, below);
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
    const isAqua = layer.kind === "aqua";
    if (isMatter) {
      // La materia sí es una capa eliminable: vaciar sus cuerpos o borrar la capa.
      item("Vaciar materia", () => ed.clearMatterLayer(layer.id));
      item("Borrar capa", () => ed.removeLayer(layer.id));
      sep();
    } else if (isAqua) {
      // Hornear pasa el fluido a un ráster de mundo: deja de correr, acompaña al
      // paneo y al zoom, y es lo único que se guarda y se exporta.
      item("Hornear acuarela", () => ed.bakeAquaLayer(layer.id));
      item("Limpiar acuarela", () => ed.clearAquaLayer(layer.id));
      item("Borrar capa", () => ed.removeLayer(layer.id));
      sep();
      item(layer.mask ? "Quitar máscara" : "Añadir máscara", () => ed.toggleLayerMask(layer.id));
      if (layer.mask) item("Invertir máscara", () => ed.invertLayerMask(layer.id));
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

