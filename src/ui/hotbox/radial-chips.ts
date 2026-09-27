import type { Editor } from "../../app/editor";
import { TAU, clamp } from "../../core/math";
import { el } from "../dom";
import { MateriaFx, prefersReducedMotion } from "../fx/materia";
import { icon } from "../icons";
import { arcPathD, dialText, dialTFromValue, dialValueFromT, needlePathD } from "./arc-geometry";
import { buildRoot, type DialNode, type HotNode, type MenuHooks } from "./menu";
import type { TearOffDescriptor } from "./radial-menu";

const NS = "http://www.w3.org/2000/svg";

/**
 * Trozos arrancables ("tear-off") del menú radial.
 *
 * Al mantener pulsado un sector del menú ~3 s, éste emite un `TearOffDescriptor`
 * (ver radial-menu.ts) y aquí nace un `RadialChip`: la misma tajada anular, ahora
 * flotando sola en el viewport con dos punticos de materia (rotar y mover). Se cierra
 * con el mismo gesto que lo arrancó: manteniéndolo pulsado quieto ~3 s. Los trozos
 * siguen VIVOS (un dial-trozo controla el editor igual que en el menú), se PEGAN
 * reformando un anillo al acercarlos, y PERSISTEN en localStorage.
 *
 * `RadialChips` es el gestor (capa flotante + creación/pegado/persistencia);
 * `RadialChip` es un trozo suelto. La geometría se comparte con el menú vía
 * arc-geometry.ts, así ambos dibujan la misma tajada sin duplicar matemática.
 */

// Cada trozo CONSERVA los radios y el ángulo del sector del que salió: nace
// idéntico a como estaba en el menú (misma banda, mismo tamaño, misma
// inclinación), no normalizado. Los radios viajan por trozo (r0/r1); aquí solo
// quedan las constantes comunes al pegado.
/** Mismo hueco visual entre sectores que el menú (px). */
const CHIP_GAP_PX = 7;
/** Distancia (px) entre puntos medios de arco para que dos trozos se peguen. */
const SNAP_DIST = 78;
/** Cerrar un trozo: mantenerlo pulsado quieto este tiempo (mismo gesto y umbrales
    que el long-press que lo arrancó del menú, ver radial-menu.ts). */
const CLOSE_HOLD_MS = 3000;
const CLOSE_MOVE_TOL = 8;
const STORE_KEY = "zence.radialChips.v2";

/** Lo que se guarda de cada trozo en localStorage. */
interface ChipRecord {
  id: string;
  nodeId: string;
  path: number[];
  clusterId: string | null;
  cx: number;
  cy: number;
  r0: number;
  r1: number;
  a0: number;
  a1: number;
}

/** Puertos que el trozo usa para hablar con su gestor. */
interface ChipHost {
  scheduleSave(): void;
  detach(chip: RadialChip): void;
  trySnap(chip: RadialChip): void;
  remove(chip: RadialChip): void;
  reopenMenu(path: number[], x: number, y: number): void;
  /** Trozos del mismo cluster que `chip` (incluido él); solo él si está suelto. */
  cluster(chip: RadialChip): RadialChip[];
}

/**
 * Gestor de los trozos flotantes: una capa a pantalla completa (sin captura de
 * puntero salvo en los propios trozos) donde viven los `RadialChip`. Los crea al
 * arrancar del menú, los re-sincroniza con el editor, los pega al acercarlos y los
 * guarda/restaura de localStorage.
 */
export class RadialChips implements ChipHost {
  readonly el: HTMLElement;

  private editor: Editor;
  private hooks: MenuHooks;
  private chips = new Map<string, RadialChip>();
  private saveTimer = 0;
  private seq = 0;

  /** Reabrir el menú radial expandido en un submenú (lo cablea la app). */
  onReopenMenu: ((path: number[], x: number, y: number) => void) | null = null;

  constructor(editor: Editor, hooks: MenuHooks) {
    this.editor = editor;
    this.hooks = hooks;
    this.el = el("div", { class: "rm-chips" });
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  /** Árbol declarativo actual (mismo que dibuja el menú), para resolver nodos. */
  private tree(): HotNode[] {
    return buildRoot(this.editor, this.editor.state, this.hooks);
  }

  /** Crea un trozo a partir del descriptor que emite el menú al arrancar un sector. */
  spawn(desc: TearOffDescriptor): void {
    const id = `chip-${desc.node.id}-${++this.seq}-${Date.now().toString(36)}`;
    const width = desc.angleWidth;
    // Nace IDÉNTICO al sector: mismos radios, mismo ángulo (misma inclinación) y
    // en el mismo sitio. `desc.viewport` es el punto medio del arco; el centro
    // virtual se deduce restando el vector radio medio en ese ángulo original.
    const amid = desc.angleMid;
    const mid = (desc.innerR + desc.outerR) / 2;
    const rec: ChipRecord = {
      id,
      nodeId: desc.node.id,
      path: desc.path,
      clusterId: null,
      cx: desc.viewport.x - Math.cos(amid) * mid,
      cy: desc.viewport.y - Math.sin(amid) * mid,
      r0: desc.innerR,
      r1: desc.outerR,
      a0: amid - width / 2,
      a1: amid + width / 2,
    };
    const chip = this.createChip(rec, desc.node);
    chip.enter();
    this.scheduleSave();
  }

  private createChip(rec: ChipRecord, node: HotNode): RadialChip {
    const chip = new RadialChip(rec, node, this);
    this.chips.set(rec.id, chip);
    this.el.appendChild(chip.el);
    this.el.appendChild(chip.fx.el);
    chip.render();
    return chip;
  }

  // ------------------------------------------------------------- ChipHost

  scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 400);
  }

  /** Al empezar a mover un trozo se desengancha de su cluster (se recalcula al soltar). */
  detach(chip: RadialChip): void {
    chip.clusterId = null;
    this.refreshHandles();
  }

  /** Al soltar un trozo movido: si su arco cae cerca de otro, reforma anillo. */
  trySnap(chip: RadialChip): void {
    const mid = chip.arcMidPoint();
    let best: RadialChip | null = null;
    let bestDist = SNAP_DIST;
    for (const other of this.chips.values()) {
      if (other === chip) continue;
      const om = other.arcMidPoint();
      const d = Math.hypot(mid.x - om.x, mid.y - om.y);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    if (best) this.attach(chip, best);
    this.refreshHandles();
    this.scheduleSave();
  }

  /**
   * Pega `chip` al cluster de `anchor`: adopta su centro virtual Y su banda
   * (radios) y se coloca en un extremo libre del anillo, borde con borde
   * (a0 = extremo + hueco), conservando su ancho. Al reformar el anillo todos
   * comparten centro y banda y ocupan ángulos contiguos, así que se ven como
   * sectores del menú radial; un cluster inclinado impone su inclinación.
   */
  private attach(chip: RadialChip, anchor: RadialChip): void {
    const clusterId = anchor.clusterId ?? anchor.id;
    anchor.clusterId = clusterId;

    // Rango angular ya ocupado por el cluster (sin contar al recién llegado).
    const members = [...this.chips.values()].filter(
      (c) => c !== chip && (c === anchor || c.clusterId === clusterId),
    );
    let minA = Infinity;
    let maxA = -Infinity;
    for (const m of members) {
      minA = Math.min(minA, m.a0);
      maxA = Math.max(maxA, m.a1);
    }

    const width = chip.a1 - chip.a0;
    const gapAngle = CHIP_GAP_PX / anchor.mid;

    // ¿Por qué extremo entra? El más cercano al ángulo donde se soltó (respecto al
    // centro adoptado).
    const mid = chip.arcMidPoint();
    const dropAngle = Math.atan2(mid.y - anchor.cy, mid.x - anchor.cx);

    chip.adoptCenter(anchor.cx, anchor.cy);
    // Al unirse a un anillo adopta su banda para que los sectores queden
    // alineados; suelto, cada trozo conserva la suya (la del menú).
    chip.adoptBand(anchor.r0, anchor.r1);
    chip.clusterId = clusterId;
    if (angDist(dropAngle, maxA) <= angDist(dropAngle, minA)) {
      chip.setAngles(maxA + gapAngle, maxA + gapAngle + width);
    } else {
      chip.setAngles(minA - gapAngle - width, minA - gapAngle);
    }
    chip.render();
  }

  remove(chip: RadialChip): void {
    chip.destroy();
    this.chips.delete(chip.id);
    this.refreshHandles();
    this.scheduleSave();
  }

  reopenMenu(path: number[], x: number, y: number): void {
    this.onReopenMenu?.(path, x, y);
  }

  /** Trozos del mismo cluster que `chip` (incluido él). Si está suelto (sin
      clusterId), solo él. Comparten `cx,cy` y banda, así que rotan/se mueven juntos. */
  cluster(chip: RadialChip): RadialChip[] {
    if (!chip.clusterId) return [chip];
    return [...this.chips.values()].filter((c) => c.clusterId === chip.clusterId);
  }

  /**
   * Refresca qué punticos enseña cada trozo. La regla imita al menú/anillo: los
   * controles solo viven en los EXTREMOS del conjunto. Suelto, un trozo es su propio
   * extremo (rotar a un lado, mover al otro). Conectados, solo el trozo del extremo
   * inicial (menor a0) enseña rotar y solo el del extremo final (mayor a1) enseña
   * mover; los de en medio no llevan ninguno. Rotar/mover operan sobre todo el
   * cluster (comparten centro), así que basta un control por extremo.
   */
  private refreshHandles(): void {
    const byCluster = new Map<string, RadialChip[]>();
    for (const chip of this.chips.values()) {
      const key = chip.clusterId ?? chip.id; // suelto = su propio "cluster" de 1
      const arr = byCluster.get(key) ?? [];
      arr.push(chip);
      byCluster.set(key, arr);
    }
    for (const arr of byCluster.values()) {
      let start = arr[0];
      let end = arr[0];
      for (const c of arr) {
        if (c.a0 < start.a0) start = c;
        if (c.a1 > end.a1) end = c;
      }
      for (const c of arr) c.updateHandles(c === start, c === end);
    }
  }

  // -------------------------------------------------------- sync / persistencia

  /**
   * Re-resuelve cada trozo contra el árbol fresco del editor y repinta su valor:
   * así un cambio hecho en otro sitio (panel lateral, atajo) se refleja en el
   * trozo. Se salta el trozo que se está arrastrando ahora mismo, para no pelear
   * con su propio ajuste (bandera como en controls.ts).
   */
  syncFromEditor(): void {
    if (this.chips.size === 0) return;
    const tree = this.tree();
    for (const chip of this.chips.values()) {
      if (chip.isDragging) continue;
      const node = resolveNode(tree, chip.path, chip.nodeId);
      if (node) chip.rebind(node);
    }
  }

  /** Restaura los trozos guardados: re-resuelve cada nodo por path/id y crea los que
      resuelvan, descartando el resto en silencio. Los clusters reaparecen porque el
      centro y los ángulos contiguos van guardados. */
  restore(): void {
    let recs: ChipRecord[];
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      recs = JSON.parse(raw) as ChipRecord[];
    } catch {
      return;
    }
    if (!Array.isArray(recs)) return;

    const tree = this.tree();
    for (const rec of recs) {
      if (!rec || !Array.isArray(rec.path)) continue;
      // Descarta registros sin banda válida (formato viejo o corrupto).
      if (!Number.isFinite(rec.r0) || !Number.isFinite(rec.r1)) continue;
      const node = resolveNode(tree, rec.path, rec.nodeId);
      if (!node) continue;
      const chip = this.createChip(rec, node);
      chip.reveal(); // ya estaba: aparece sin la animación de nacimiento
    }
    this.refreshHandles();
  }

  private save(): void {
    try {
      const recs = [...this.chips.values()].map((c) => c.toRecord());
      window.localStorage.setItem(STORE_KEY, JSON.stringify(recs));
    } catch {
      // Sin almacenamiento (modo privado): los trozos siguen en la sesión.
    }
  }

  dispose(): void {
    window.clearTimeout(this.saveTimer);
    for (const chip of this.chips.values()) chip.destroy();
    this.chips.clear();
    this.el.remove();
  }
}

/**
 * Un trozo suelto: la MISMA tajada anular del menú (conserva sus radios r0..r1 y
 * su ángulo) más sus dos punticos de materia (rotar / mover) y, si es un dial,
 * el relleno + la aguja que lo hacen un slider con forma de arco. Guarda su
 * centro virtual (`cx,cy`), su banda (`r0,r1`) y ángulos (`a0,a1`) en coordenadas
 * de viewport. Al pegarse a un anillo adopta la banda del cluster.
 */
class RadialChip {
  readonly id: string;
  readonly nodeId: string;
  readonly path: number[];
  clusterId: string | null;
  cx: number;
  cy: number;
  r0: number;
  r1: number;
  a0: number;
  a1: number;

  /** Radio medio (donde va la etiqueta y el punto de pegado). */
  get mid(): number {
    return (this.r0 + this.r1) / 2;
  }

  readonly el: HTMLElement;
  /** Partículas (metaball) que forman/deshacen el trozo. Sistema compartido. */
  readonly fx: MateriaFx;
  /** true mientras se arrastra (mover o ajustar dial): el gestor se salta su sync. */
  isDragging = false;

  private node: HotNode;
  private host: ChipHost;
  private svg: SVGSVGElement;
  private sectorPath: SVGPathElement;
  private label: HTMLElement;
  private rotateDot: HTMLElement;
  private moveDot: HTMLElement;
  private dial: { fill: SVGPathElement; thumb: SVGPathElement } | null = null;
  private closing = false;
  /** Timer del "mantener pulsado para cerrar" (mismo gesto que arrancó el trozo). */
  private closeTimer = 0;

  constructor(rec: ChipRecord, node: HotNode, host: ChipHost) {
    this.id = rec.id;
    this.nodeId = rec.nodeId;
    this.path = [...rec.path];
    this.clusterId = rec.clusterId;
    this.cx = rec.cx;
    this.cy = rec.cy;
    this.r0 = rec.r0;
    this.r1 = rec.r1;
    this.a0 = rec.a0;
    this.a1 = rec.a1;
    this.node = node;
    this.host = host;

    this.fx = new MateriaFx({ coreSize: 96, reach: 80, gatherMs: 380, scatterMs: 300 });

    this.svg = document.createElementNS(NS, "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "rm-chip-svg");
    this.applySvgSize();

    this.sectorPath = document.createElementNS(NS, "path") as SVGPathElement;
    this.sectorPath.setAttribute("class", "rm-chip-sector");
    this.svg.appendChild(this.sectorPath);

    if (node.kind === "dial") {
      const fill = document.createElementNS(NS, "path") as SVGPathElement;
      fill.setAttribute("class", "rm-chip-fill");
      const thumb = document.createElementNS(NS, "path") as SVGPathElement;
      thumb.setAttribute("class", "rm-chip-thumb");
      this.svg.appendChild(fill);
      this.svg.appendChild(thumb);
      this.dial = { fill, thumb };
    }

    this.label = el("div", { class: "rm-chip-label" });
    // Dos punticos de materia en los bordes rectos del sector: rotar (borde a0,
    // "izquierda") y mover (borde a1, "derecha"). Rotar y mover operan sobre todo el
    // cluster cuando está conectado; suelto, sobre el trozo. No hay botón de cerrar:
    // se cierra manteniéndolo pulsado quieto ~3 s, el mismo gesto con que se arrancó.
    this.rotateDot = el("button", { class: "rm-chip-dot rm-chip-rotate materia-blob", type: "button", title: "Rotar", html: icon("rotate") });
    this.moveDot = el("button", { class: "rm-chip-dot rm-chip-move materia-blob", type: "button", title: "Mover", html: icon("grip") });

    // Nace oculto (materia-hidden): las partículas lo forman antes de que entre.
    this.el = el("div", { class: "rm-chip materia-hidden" }, [
      this.svg as unknown as HTMLElement,
      this.label,
      this.rotateDot,
      this.moveDot,
    ]);

    this.fillLabel();
    this.wireEvents();
  }

  /** Contenido del centro del arco: valor (dial), icono, muestra de color o texto. */
  private fillLabel(): void {
    const node = this.node;
    this.label.className = "rm-chip-label";
    this.label.textContent = "";
    this.label.style.background = "";
    if (node.kind === "dial") {
      this.label.classList.add("rm-chip-value");
      this.label.textContent = dialText(node, false);
    } else if (node.accent && node.id.startsWith("swatch-")) {
      this.label.classList.add("rm-chip-swatch");
      this.label.style.background = node.accent;
    } else if (node.icon) {
      this.label.classList.add("rm-chip-icon");
      this.label.innerHTML = icon(node.icon);
    } else if (node.accent) {
      this.label.classList.add("rm-chip-color");
      this.label.style.background = node.accent;
    } else {
      this.label.classList.add("rm-chip-text");
      this.label.textContent = shortLabel(node.label);
    }
  }

  private wireEvents(): void {
    this.rotateDot.addEventListener("pointerdown", (e) => this.beginRotate(e));
    this.moveDot.addEventListener("pointerdown", (e) => this.beginMove(e));

    // El sector: además de su gesto propio (arrastrar dial / tocar acción / reabrir
    // submenú), arma el "mantener pulsado quieto ~3 s para cerrar" —el mismo gesto con
    // que se arrancó del menú—. Si el cierre dispara, se anula el tap/valor siguiente.
    this.sectorPath.addEventListener("pointerdown", (e) => this.onSectorDown(e));

    if (this.node.kind === "action") {
      this.sectorPath.addEventListener("click", () => {
        if (this.closing) return;
        if (this.node.kind === "action" && !this.node.disabled) this.node.run();
      });
    } else if (this.node.kind === "submenu") {
      // Submenú: el trozo es una etiqueta-arco que reabre el menú expandido aquí.
      this.sectorPath.addEventListener("click", () => {
        if (this.closing) return;
        const m = this.arcMidPoint();
        this.host.reopenMenu(this.path, m.x, m.y);
      });
    }
  }

  /** Pulsación sobre el sector: arma el cierre por pulsación larga y, si es un dial,
      empieza también el arrastre del slider. Tocar (acción/submenú) va por `click`. */
  private onSectorDown(e: PointerEvent): void {
    this.armClose(e);
    if (this.node.kind === "dial") this.beginDialDrag(e);
  }

  /** Mantener pulsado quieto ~3 s cierra el trozo (con `.is-arming` de realimentación,
      igual que el sector del menú al arrancarlo). Cualquier desplazamiento > tolerancia
      o soltar antes cancela el armado. */
  private armClose(e: PointerEvent): void {
    window.clearTimeout(this.closeTimer);
    const sx = e.clientX;
    const sy = e.clientY;
    this.el.classList.add("is-arming");
    const cancel = (): void => {
      window.clearTimeout(this.closeTimer);
      this.el.classList.remove("is-arming");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
    const onMove = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > CLOSE_MOVE_TOL) cancel();
    };
    this.closeTimer = window.setTimeout(() => {
      cancel();
      this.host.remove(this);
    }, CLOSE_HOLD_MS);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
  }

  /** Ajusta el `<svg>` al tamaño de la banda actual (lado = 2·r1, centro en r1). */
  private applySvgSize(): void {
    const size = 2 * this.r1;
    this.svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    this.svg.setAttribute("width", String(size));
    this.svg.setAttribute("height", String(size));
  }

  /** Repinta el trozo: posición del elemento, tajada, dial (si lo es), punticos y
      etiqueta, según `cx,cy,r0,r1,a0,a1` y el valor actual. */
  render(): void {
    this.applySvgSize();
    this.el.style.left = `${this.cx - this.r1}px`;
    this.el.style.top = `${this.cy - this.r1}px`;

    const spec = {
      cx: this.r1,
      cy: this.r1,
      innerR: this.r0,
      outerR: this.r1,
      a0: this.a0,
      a1: this.a1,
      gapPx: CHIP_GAP_PX,
    };
    this.sectorPath.setAttribute("d", arcPathD(spec));

    if (this.dial && this.node.kind === "dial") {
      const node = this.node;
      const t = dialTFromValue(node);
      const aVal = this.a0 + t * (this.a1 - this.a0);
      this.dial.fill.setAttribute("d", t <= 0.002 ? "" : arcPathD({ ...spec, a1: aVal }));
      this.dial.thumb.setAttribute("d", needlePathD(this.r1, this.r1, this.r0, this.r1, aVal));
      this.label.textContent = dialText(node, false);
    }

    this.positionHandles();
    this.positionLabel();
  }

  /** Coloca los dos punticos en los bordes RECTOS del sector: rotar en el borde
      inicial (a0) y mover en el final (a1), a media banda y empujados un poco hacia
      afuera del sector (perpendicular al borde). Así, al reformar un anillo, quedan
      en los extremos libres del conjunto. Coordenadas locales del elemento. */
  private positionHandles(): void {
    const off = 20;
    // Borde a0: la perpendicular que sale del sector apunta a (sin a0, −cos a0).
    const rx = this.r1 + Math.cos(this.a0) * this.mid + Math.sin(this.a0) * off;
    const ry = this.r1 + Math.sin(this.a0) * this.mid - Math.cos(this.a0) * off;
    this.rotateDot.style.left = `${rx}px`;
    this.rotateDot.style.top = `${ry}px`;
    // Borde a1: la perpendicular que sale del sector apunta a (−sin a1, cos a1).
    const mx = this.r1 + Math.cos(this.a1) * this.mid - Math.sin(this.a1) * off;
    const my = this.r1 + Math.sin(this.a1) * this.mid + Math.cos(this.a1) * off;
    this.moveDot.style.left = `${mx}px`;
    this.moveDot.style.top = `${my}px`;
  }

  /** Enseña rotar/mover solo en los extremos del conjunto: suelto, el trozo es sus
      dos extremos (enseña ambos); conectado, solo el del extremo inicial enseña rotar
      y solo el del final enseña mover. Lo llama el gestor tras cualquier cambio. */
  updateHandles(showRotate: boolean, showMove: boolean): void {
    this.rotateDot.classList.toggle("is-hidden", !showRotate);
    this.moveDot.classList.toggle("is-hidden", !showMove);
  }

  /** Coloca la etiqueta (valor/icono) en el medio del arco (coords locales). */
  private positionLabel(): void {
    const amid = (this.a0 + this.a1) / 2;
    this.label.style.left = `${this.r1 + Math.cos(amid) * this.mid}px`;
    this.label.style.top = `${this.r1 + Math.sin(amid) * this.mid}px`;
  }

  /** Punto medio del arco en coordenadas de viewport (para pegado y partículas). */
  arcMidPoint(): { x: number; y: number } {
    const amid = (this.a0 + this.a1) / 2;
    return {
      x: this.cx + Math.cos(amid) * this.mid,
      y: this.cy + Math.sin(amid) * this.mid,
    };
  }

  // ------------------------------------------------------------ interacción

  /** Arrastre del dial sobre su propio arco (mapea el ángulo del cursor a t∈[0,1]). */
  private beginDialDrag(e: PointerEvent): void {
    if (this.node.kind !== "dial") return;
    e.preventDefault();
    this.isDragging = true;
    this.el.classList.add("is-active");
    this.applyDialDrag(e);
    const move = (ev: PointerEvent): void => this.applyDialDrag(ev);
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.isDragging = false;
      this.el.classList.remove("is-active");
      this.host.scheduleSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private applyDialDrag(e: PointerEvent): void {
    const node = this.node as DialNode;
    let a = Math.atan2(e.clientY - this.cy, e.clientX - this.cx);
    // Lleva el ángulo del cursor al rango continuo del arco [a0, a1].
    while (a < this.a0 - Math.PI) a += TAU;
    while (a > this.a0 + Math.PI) a -= TAU;
    const t = clamp((a - this.a0) / (this.a1 - this.a0 || 1), 0, 1);
    const v = dialValueFromT(node, t);
    if (v !== node.value) {
      node.value = v;
      node.onInput(v);
    }
    this.render();
  }

  /** Arrastre por el puntico de mover. Si el trozo está CONECTADO, arrastra todo el
      cluster junto (mismo offset a cada centro, sin desengancharlo). Si está suelto,
      se desengancha, se mueve solo e intenta pegarse al soltar. */
  private beginMove(e: PointerEvent): void {
    e.preventDefault();
    const members = this.host.cluster(this);
    const solo = members.length <= 1;
    if (solo) this.host.detach(this);
    const sx = e.clientX;
    const sy = e.clientY;
    const start = members.map((m) => ({ m, cx: m.cx, cy: m.cy }));
    for (const m of members) m.isDragging = true;
    this.el.classList.add("is-moving");
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      for (const s of start) {
        s.m.adoptCenter(s.cx + dx, s.cy + dy);
        s.m.render();
      }
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      for (const m of members) m.isDragging = false;
      this.el.classList.remove("is-moving");
      if (solo) this.host.trySnap(this);
      else this.host.scheduleSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Rota el trozo en su círculo (gira `a0,a1` alrededor de `cx,cy`). Si está
      conectado, gira TODO el cluster el mismo delta: como comparten centro, basta
      sumar el mismo ángulo a cada miembro. Así el usuario coloca la pieza —o el
      anillo entero— arriba, a un lado o donde le sea cómodo. */
  private beginRotate(e: PointerEvent): void {
    e.preventDefault();
    const members = this.host.cluster(this);
    const start = members.map((m) => ({ m, a0: m.a0, a1: m.a1 }));
    for (const m of members) m.isDragging = true;
    this.el.classList.add("is-rotating");
    // Ángulo inicial del cursor respecto al centro (compartido por el cluster).
    const a0 = Math.atan2(e.clientY - this.cy, e.clientX - this.cx);
    const move = (ev: PointerEvent): void => {
      const a = Math.atan2(ev.clientY - this.cy, ev.clientX - this.cx);
      const d = a - a0;
      for (const s of start) {
        s.m.setAngles(s.a0 + d, s.a1 + d);
        s.m.render();
      }
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      for (const m of members) m.isDragging = false;
      this.el.classList.remove("is-rotating");
      this.host.scheduleSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  adoptCenter(cx: number, cy: number): void {
    this.cx = cx;
    this.cy = cy;
  }

  /** Adopta la banda (radios) de un anillo al pegarse a él. */
  adoptBand(r0: number, r1: number): void {
    this.r0 = r0;
    this.r1 = r1;
  }

  setAngles(a0: number, a1: number): void {
    this.a0 = a0;
    this.a1 = a1;
  }

  /** Re-liga el trozo al nodo fresco del editor (valor y onInput actuales). */
  rebind(node: HotNode): void {
    this.node = node;
    if (node.kind === "dial") this.render();
  }

  // ------------------------------------------------------ nacimiento / muerte

  /** Aparición: las partículas se juntan en el arco y el trozo se funde desde ahí. */
  enter(): void {
    if (prefersReducedMotion()) {
      this.el.classList.remove("materia-hidden");
      return;
    }
    const c = this.arcMidPoint();
    this.fx.center(c.x, c.y);
    this.fx.gather();
    window.setTimeout(() => {
      this.el.classList.remove("materia-hidden");
      this.fx.fadeOut();
    }, this.fx.gatherMs);
  }

  /** Muestra el trozo sin animación de nacimiento (restaurado de localStorage). */
  reveal(): void {
    this.el.classList.remove("materia-hidden");
  }

  /** Desaparición: el trozo se desintegra en partículas que salen despedidas. */
  destroy(): void {
    if (this.closing) return;
    this.closing = true;
    window.clearTimeout(this.closeTimer);
    const finish = (): void => {
      this.el.remove();
      this.fx.el.remove();
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    const c = this.arcMidPoint();
    this.fx.center(c.x, c.y);
    this.fx.scatter();
    this.el.classList.add("materia-hiding");
    window.setTimeout(finish, this.fx.scatterMs);
  }

  toRecord(): ChipRecord {
    return {
      id: this.id,
      nodeId: this.nodeId,
      path: [...this.path],
      clusterId: this.clusterId,
      cx: this.cx,
      cy: this.cy,
      r0: this.r0,
      r1: this.r1,
      a0: this.a0,
      a1: this.a1,
    };
  }
}

/** Etiqueta corta para el centro de un trozo sin icono ni color (fallback). */
function shortLabel(label: string): string {
  if (/^\d+$/.test(label) && label.length <= 3) return label;
  const words = label.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return label.slice(0, 3);
}

/**
 * Re-resuelve un nodo por su camino de índices y comprueba que el `id` coincide.
 * Devuelve el nodo fresco (con su `onInput`/`value` actuales) o null si el árbol
 * cambió y ese camino ya no lleva al mismo nodo.
 */
function resolveNode(tree: HotNode[], path: number[], id: string): HotNode | null {
  let nodes = tree;
  let node: HotNode | null = null;
  for (const idx of path) {
    node = nodes[idx] ?? null;
    if (!node) return null;
    nodes = node.kind === "submenu" ? node.children : [];
  }
  return node && node.id === id ? node : null;
}

/** Menor diferencia angular (0..π) entre dos ángulos, tolerante al envolvimiento. */
function angDist(a: number, b: number): number {
  let d = Math.abs(a - b) % TAU;
  if (d > Math.PI) d = TAU - d;
  return d;
}






