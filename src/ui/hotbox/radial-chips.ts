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

// Los trozos son MODULARES: todos nacen de la misma medida (banda y ancho angular)
// y compactos, para que sean baldosas acoplables. La banda no viaja por trozo: se
// DERIVA del nivel concéntrico dentro de su grupo (ver `RadialChip.r0/r1`).
/** Radio interior del nivel 0 (el aro más interno de un grupo), px. */
const CHIP_R0_BASE = 72;
/** Grosor de cada aro (r1 − r0), px. Igual en todos los niveles. */
const CHIP_BAND = 46;
/** Hueco radial entre niveles concéntricos, px. Igualado al hueco visual que queda
    entre chips contiguos a los lados (≈ CHIP_GAP_PX de colocación + los medios huecos
    que arcPathD mete en cada borde), para que la separación se sienta la misma. */
const LEVEL_GAP = 14;
/** Ancho angular uniforme de cada trozo (radianes ≈ 47°). */
const CHIP_ANGLE = 0.82;
/** Mismo hueco visual entre sectores que el menú (px). */
const CHIP_GAP_PX = 7;
/** Margen (px) sobre el radio externo del grupo para que un aro se anide en él (centro a centro). */
const GROUP_SNAP = 40;
/** Cerrar un trozo: mantenerlo pulsado quieto este tiempo (mismo gesto y umbrales
    que el long-press que lo arrancó del menú, ver radial-menu.ts). */
const CLOSE_HOLD_MS = 3000;
const CLOSE_MOVE_TOL = 8;
const STORE_KEY = "zence.radialChips.v3";

/** Radio interior de un nivel concéntrico. */
function levelR0(level: number): number {
  return CHIP_R0_BASE + level * (CHIP_BAND + LEVEL_GAP);
}

/** Lo que se guarda de cada trozo en localStorage. */
interface ChipRecord {
  id: string;
  nodeId: string;
  path: number[];
  /** Grupo (ensamblaje) al que pertenece: comparten centro virtual `cx,cy`. */
  groupId: string;
  /** Anillo concéntrico dentro del grupo (0 = el más interior). La banda se deriva. */
  level: number;
  cx: number;
  cy: number;
  a0: number;
  a1: number;
}

/** Puertos que el trozo usa para hablar con su gestor. */
interface ChipHost {
  scheduleSave(): void;
  trySnap(chip: RadialChip): void;
  remove(chip: RadialChip): void;
  reopenMenu(path: number[], x: number, y: number): void;
  /** Trozos del mismo aro que `chip` (mismo grupo Y nivel; incluido él). */
  ring(chip: RadialChip): RadialChip[];
  /** Trozos del mismo grupo que `chip` (todos los niveles; incluido él). */
  group(chip: RadialChip): RadialChip[];
}

/** Puertos que el núcleo (hub) usa para operar sobre todo su grupo. */
interface HubHost {
  groupMembers(groupId: string): RadialChip[];
  repositionHub(groupId: string, cx: number, cy: number): void;
  scheduleSave(): void;
  /** Alterna el "modo limpio" del grupo: oculta los controles por-nivel (rotar/mover
      de cada aro) y desactiva el cierre por pulsación de cada chip; volver a alternarlo
      los reactiva. Lo dispara un long-press sobre el botón MOVER del hub. */
  toggleGroupLock(groupId: string): void;
}

/**
 * Gestor de los trozos flotantes: una capa a pantalla completa (sin captura de
 * puntero salvo en los propios trozos) donde viven los `RadialChip`. Los crea al
 * arrancar del menú, los re-sincroniza con el editor, los pega al acercarlos y los
 * guarda/restaura de localStorage.
 */
export class RadialChips implements ChipHost, HubHost {
  readonly el: HTMLElement;

  private editor: Editor;
  private hooks: MenuHooks;
  private chips = new Map<string, RadialChip>();
  /** Núcleos de grupo (uno por grupo multinivel), indexados por groupId. */
  private hubs = new Map<string, RingHub>();
  /** Grupos en "modo limpio": sin controles por-nivel ni cierre por chip (ver
      `toggleGroupLock`). Es estado de sesión (no se persiste). */
  private lockedGroups = new Set<string>();
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
    // Nace MODULAR: banda del nivel 0 y ancho uniforme (`CHIP_ANGLE`), no el del
    // sector de origen. Se centra donde estaba (desc.angleMid) y el centro virtual
    // se deduce restando el vector radio-medio del nivel 0 en ese ángulo.
    const amid = desc.angleMid;
    const mid = levelR0(0) + CHIP_BAND / 2;
    const rec: ChipRecord = {
      id,
      nodeId: desc.node.id,
      path: desc.path,
      groupId: id, // suelto: su propio grupo de uno
      level: 0,
      cx: desc.viewport.x - Math.cos(amid) * mid,
      cy: desc.viewport.y - Math.sin(amid) * mid,
      a0: amid - CHIP_ANGLE / 2,
      a1: amid + CHIP_ANGLE / 2,
    };
    this.createChip(rec, desc.node);
    this.refreshHandles();
    // enter() tras crear para que las partículas se junten en el arco ya normalizado.
    this.chips.get(id)?.enter();
    this.scheduleSave();
  }

  private createChip(rec: ChipRecord, node: HotNode): RadialChip {
    const chip = new RadialChip(rec, node, this);
    this.chips.set(rec.id, chip);
    this.el.appendChild(chip.el);
    this.el.appendChild(chip.fx.el);
    this.el.appendChild(chip.rotateFx.el);
    this.el.appendChild(chip.moveFx.el);
    chip.render();
    return chip;
  }

  // ------------------------------------------------------------- ChipHost

  scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 400);
  }

  /** Un id de grupo nuevo (para desenganchar un aro y dejarlo como grupo propio). */
  private newGroupId(): string {
    return `grp-${++this.seq}-${Date.now().toString(36)}`;
  }

  /**
   * Al soltar un ARO movido (mismo grupo+nivel): primero lo DESENGANCHA de su grupo
   * (nuevo groupId, el grupo viejo se recompacta) —así, si venía de un grupo multinivel,
   * moverlo por su botón SACA ese nivel para dejarlo fuera—. Luego, si su centro cae
   * cerca de otro grupo, se anida en él como un nivel concéntrico (interior/mismo/exterior
   * según el radio de caída); si no, queda como grupo propio. Tras cualquier cambio se
   * renormalizan los niveles del grupo destino a 0..k.
   */
  trySnap(chip: RadialChip): void {
    const dragged = this.ring(chip);

    // Desenganche: si el aro era parte de un grupo mayor, se separa como grupo propio y
    // el grupo viejo se renormaliza (sus niveles restantes se recompactan sin huecos).
    const oldGroup = chip.groupId;
    if (dragged.length < this.groupMembers(oldGroup).length) {
      const gid = this.newGroupId();
      for (const c of dragged) c.groupId = gid;
      this.renormalizeLevels(oldGroup);
    }
    const draggedIds = new Set(dragged.map((c) => c.id));

    // Grupo destino: el chip más cercano (por su centro) que NO sea del aro arrastrado
    // y quede dentro del alcance de anidado.
    let target: RadialChip | null = null;
    let bestDist = Infinity;
    for (const other of this.chips.values()) {
      if (draggedIds.has(other.id)) continue;
      const d = Math.hypot(chip.cx - other.cx, chip.cy - other.cy);
      const reach = other.r1 + GROUP_SNAP;
      if (d < reach && d < bestDist) {
        bestDist = d;
        target = other;
      }
    }

    if (target) {
      this.nest(dragged, target, chip.arcMidPoint());
    } else {
      // Suelto: grupo propio; renormaliza (queda en nivel 0).
      this.renormalizeLevels(chip.groupId);
    }
    this.refreshHandles();
    this.scheduleSave();
  }

  /**
   * Anida `dragged` (un aro: chips de un mismo grupo+nivel) en el grupo de `target`.
   * El nivel destino lo decide `dropPoint`: si su radio cae en la banda de un nivel
   * existente, se une a ese aro (contiguo, borde con borde); si es más interior o más
   * exterior que los niveles actuales, entra como un nivel nuevo. Todos adoptan el
   * centro y el groupId del destino; luego se renormalizan los niveles.
   */
  private nest(dragged: RadialChip[], target: RadialChip, dropPoint: { x: number; y: number }): void {
    const gcx = target.cx;
    const gcy = target.cy;
    const gid = target.groupId;
    const groupChips = this.group(target);
    let maxL = 0;
    for (const c of groupChips) maxL = Math.max(maxL, c.level);

    const levelPitch = CHIP_BAND + LEVEL_GAP;
    const dR = Math.hypot(dropPoint.x - gcx, dropPoint.y - gcy);
    const approx = Math.round((dR - CHIP_R0_BASE - CHIP_BAND / 2) / levelPitch);

    let newLevel: number;
    let joinExisting: boolean;
    if (approx < 0) {
      newLevel = -1; // interior: se renormaliza a 0 empujando el resto hacia afuera
      joinExisting = false;
    } else if (approx > maxL) {
      newLevel = maxL + 1; // exterior
      joinExisting = false;
    } else {
      newLevel = approx; // nivel existente (los niveles son contiguos 0..maxL)
      joinExisting = true;
    }

    if (joinExisting) {
      // Extremo angular libre del aro destino en ese nivel.
      const ring = groupChips.filter((c) => c.level === newLevel);
      let minA = Infinity;
      let maxA = -Infinity;
      for (const c of ring) {
        minA = Math.min(minA, c.a0);
        maxA = Math.max(maxA, c.a1);
      }
      const gapAngle = CHIP_GAP_PX / (levelR0(newLevel) + CHIP_BAND / 2);
      // Coloca el bloque arrastrado contiguo al extremo más cercano a la caída,
      // conservando su reparto angular interno.
      const blockMin = Math.min(...dragged.map((c) => c.a0));
      const dropAngle = Math.atan2(dropPoint.y - gcy, dropPoint.x - gcx);
      const offset = angDist(dropAngle, maxA) <= angDist(dropAngle, minA)
        ? maxA + gapAngle - blockMin
        : minA - gapAngle - Math.max(...dragged.map((c) => c.a1));
      for (const c of dragged) {
        c.groupId = gid;
        c.setLevel(newLevel);
        c.adoptCenter(gcx, gcy);
        c.setAngles(c.a0 + offset, c.a1 + offset);
      }
    } else {
      // Nivel nuevo (interior/exterior): adopta centro y nivel, conserva ángulos.
      for (const c of dragged) {
        c.groupId = gid;
        c.setLevel(newLevel);
        c.adoptCenter(gcx, gcy);
      }
    }

    this.renormalizeLevels(gid);
  }

  /** Compacta los niveles de un grupo a 0..k (sin huecos) y repinta. Mantiene las
      bandas positivas y juntas tras insertar niveles interiores/exteriores. */
  private renormalizeLevels(groupId: string): void {
    const members = [...this.chips.values()].filter((c) => c.groupId === groupId);
    if (members.length === 0) return;
    const levels = [...new Set(members.map((c) => c.level))].sort((a, b) => a - b);
    const remap = new Map<number, number>();
    levels.forEach((lv, i) => remap.set(lv, i));
    for (const c of members) {
      c.setLevel(remap.get(c.level) ?? 0);
      c.render();
    }
  }

  remove(chip: RadialChip): void {
    const gid = chip.groupId;
    chip.destroy();
    this.chips.delete(chip.id);
    this.renormalizeLevels(gid);
    this.refreshHandles();
    this.scheduleSave();
  }

  reopenMenu(path: number[], x: number, y: number): void {
    this.onReopenMenu?.(path, x, y);
  }

  /** Trozos del mismo ARO que `chip`: mismo grupo Y nivel (incluido él). Comparten
      centro y banda y ocupan ángulos contiguos; rotan/se mueven como una unidad. */
  ring(chip: RadialChip): RadialChip[] {
    return [...this.chips.values()].filter(
      (c) => c.groupId === chip.groupId && c.level === chip.level,
    );
  }

  /** Trozos del mismo GRUPO que `chip` (todos los niveles). Comparten centro. */
  group(chip: RadialChip): RadialChip[] {
    return [...this.chips.values()].filter((c) => c.groupId === chip.groupId);
  }

  /** Miembros de un grupo por id (para el hub). */
  groupMembers(groupId: string): RadialChip[] {
    return [...this.chips.values()].filter((c) => c.groupId === groupId);
  }

  /**
   * Refresca los controles. Regla:
   * - Por cada ARO (grupo+nivel): rotar en el extremo inicial (menor a0) y mover en el
   *   extremo final (mayor a1). El mover se mantiene SIEMPRE, también en grupos
   *   multinivel: usarlo saca ese nivel del grupo para dejarlo fuera (ver `trySnap`).
   * - Si el grupo tiene VARIOS niveles: aparece un núcleo (hub) central que mueve/rota
   *   TODO el grupo a la vez.
   */
  private refreshHandles(): void {
    const byGroup = new Map<string, RadialChip[]>();
    for (const chip of this.chips.values()) {
      const arr = byGroup.get(chip.groupId) ?? [];
      arr.push(chip);
      byGroup.set(chip.groupId, arr);
    }

    const liveGroups = new Set<string>();
    for (const [gid, arr] of byGroup) {
      liveGroups.add(gid);
      const levels = new Set(arr.map((c) => c.level));
      const multiLevel = levels.size > 1;
      // "Modo limpio": solo tiene sentido en grupos multinivel (donde hay hub para
      // volver a alternarlo). Oculta los controles por-nivel y bloquea el cierre.
      const locked = multiLevel && this.lockedGroups.has(gid);

      // Extremos por nivel.
      const startByLevel = new Map<number, RadialChip>();
      const endByLevel = new Map<number, RadialChip>();
      for (const c of arr) {
        const s = startByLevel.get(c.level);
        if (!s || c.a0 < s.a0) startByLevel.set(c.level, c);
        const e = endByLevel.get(c.level);
        if (!e || c.a1 > e.a1) endByLevel.set(c.level, c);
      }
      for (const c of arr) {
        c.setLocked(locked);
        const showRotate = !locked && startByLevel.get(c.level) === c;
        const showMove = !locked && endByLevel.get(c.level) === c;
        c.updateHandles(showRotate, showMove);
      }

      // Hub del grupo: solo con ≥2 niveles. Se posiciona en el centro compartido.
      if (multiLevel) {
        let hub = this.hubs.get(gid);
        if (!hub) {
          hub = new RingHub(gid, this);
          this.hubs.set(gid, hub);
          this.el.appendChild(hub.el);
        }
        hub.position(arr[0].cx, arr[0].cy);
        hub.setLocked(locked);
      } else {
        this.hubs.get(gid)?.destroy();
        this.hubs.delete(gid);
        // Sin hub no habría forma de desbloquearlo: un grupo que deja de ser
        // multinivel se desbloquea siempre.
        this.lockedGroups.delete(gid);
      }
    }

    // Quita hubs (y candados) de grupos que ya no existen.
    for (const [gid, hub] of this.hubs) {
      if (!liveGroups.has(gid)) {
        hub.destroy();
        this.hubs.delete(gid);
      }
    }
    for (const gid of [...this.lockedGroups]) {
      if (!liveGroups.has(gid)) this.lockedGroups.delete(gid);
    }
  }

  /** Reposiciona el hub de un grupo (lo llama el propio grupo al moverse por el hub). */
  repositionHub(groupId: string, cx: number, cy: number): void {
    this.hubs.get(groupId)?.position(cx, cy);
  }

  /** Alterna el "modo limpio" de un grupo y repinta sus controles. */
  toggleGroupLock(groupId: string): void {
    if (this.lockedGroups.has(groupId)) this.lockedGroups.delete(groupId);
    else this.lockedGroups.add(groupId);
    this.refreshHandles();
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
      resuelvan, descartando el resto en silencio. Los grupos y niveles reaparecen
      porque `groupId`, `level` y los ángulos contiguos van guardados; los hubs los
      recrea `refreshHandles`. */
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
      // Descarta registros sin grupo/nivel válidos (formato viejo o corrupto).
      if (typeof rec.groupId !== "string" || !Number.isFinite(rec.level)) continue;
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
    for (const hub of this.hubs.values()) hub.destroy();
    this.hubs.clear();
    this.el.remove();
  }
}

/**
 * Un trozo suelto: la MISMA tajada anular del menú, pero MODULAR — su banda ya no
 * viaja por trozo, se DERIVA de su nivel concéntrico dentro del grupo (`r0`/`r1` son
 * getters de `level`), así todos los trozos miden lo mismo. Guarda su grupo
 * (`groupId`, comparte centro), su nivel (`level`), su centro virtual (`cx,cy`) y sus
 * ángulos (`a0,a1`) en coordenadas de viewport. Lleva dos punticos de materia
 * (rotar / mover) y, si es un dial, el relleno + la aguja que lo hacen un slider.
 */
class RadialChip {
  readonly id: string;
  readonly nodeId: string;
  readonly path: number[];
  /** Grupo (ensamblaje) al que pertenece: sus miembros comparten `cx,cy`. */
  groupId: string;
  /** Anillo concéntrico dentro del grupo (0 = más interior). La banda se deriva. */
  level: number;
  cx: number;
  cy: number;
  a0: number;
  a1: number;

  /** Radio interior, derivado del nivel (baldosas idénticas por nivel). */
  get r0(): number {
    return levelR0(this.level);
  }

  /** Radio exterior, derivado del nivel. */
  get r1(): number {
    return this.r0 + CHIP_BAND;
  }

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
  /** Partículas propias de cada puntico: al ocultarse/mostrarse (modo limpio, o al
      reformar el aro) se juntan/dispersan como en el menú radial, no de golpe. */
  readonly rotateFx: MateriaFx;
  readonly moveFx: MateriaFx;
  /** Estado visible actual de cada puntico y si ya hubo un primer `updateHandles`
      (el primero fija el estado sin animar: el chip nace/restaura con su propia
      materia, animar los punticos encima sería un doble parpadeo). */
  private rotateShown = true;
  private moveShown = true;
  private handlesInit = false;
  private rotateAnimTimer = 0;
  private moveAnimTimer = 0;
  private dial: { fill: SVGPathElement; thumb: SVGPathElement } | null = null;
  private closing = false;
  /** En "modo limpio" (grupo bloqueado desde el hub): sin cierre por pulsación. */
  private locked = false;
  /** Timer del "mantener pulsado para cerrar" (mismo gesto que arrancó el trozo). */
  private closeTimer = 0;

  constructor(rec: ChipRecord, node: HotNode, host: ChipHost) {
    this.id = rec.id;
    this.nodeId = rec.nodeId;
    this.path = [...rec.path];
    this.groupId = rec.groupId;
    this.level = rec.level;
    this.cx = rec.cx;
    this.cy = rec.cy;
    this.a0 = rec.a0;
    this.a1 = rec.a1;
    this.node = node;
    this.host = host;

    this.fx = new MateriaFx({ coreSize: 96, reach: 80, gatherMs: 380, scatterMs: 300 });
    // Punticos: partículas pequeñas del tamaño del propio dot (30px), tiempos más
    // cortos que el chip para que el aparecer/desaparecer sea ágil.
    this.rotateFx = new MateriaFx({ coreSize: 30, reach: 26, dots: 6, gatherMs: 300, scatterMs: 260 });
    this.moveFx = new MateriaFx({ coreSize: 30, reach: 26, dots: 6, gatherMs: 300, scatterMs: 260 });

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
    // ARO (mismo grupo+nivel). No hay botón de cerrar: se cierra manteniéndolo pulsado
    // quieto ~3 s, el mismo gesto con que se arrancó.
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
    // En modo limpio el cierre por pulsación está desactivado (el dial sigue vivo).
    if (this.locked) return;
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
    // El primer `updateHandles` (nacimiento/restauración) fija el estado sin animar:
    // el chip ya llega con su propia materia y animar los punticos encima parpadearía.
    // Después, cada cambio (bloqueo del grupo, reformar el aro) juega las partículas.
    const animate =
      this.handlesInit &&
      !this.el.classList.contains("materia-hidden") &&
      !prefersReducedMotion();
    this.setHandle("rotate", showRotate, animate);
    this.setHandle("move", showMove, animate);
    this.handlesInit = true;
  }

  /** Muestra u oculta un puntico. Sin cambio real, no hace nada. Con `animate`, las
      partículas se juntan (mostrar) o se dispersan (ocultar) como en el menú radial;
      sin él, alterna `is-hidden` al instante. */
  private setHandle(which: "rotate" | "move", show: boolean, animate: boolean): void {
    const isRotate = which === "rotate";
    const dot = isRotate ? this.rotateDot : this.moveDot;
    const fx = isRotate ? this.rotateFx : this.moveFx;
    const prev = isRotate ? this.rotateShown : this.moveShown;
    if (this.handlesInit && show === prev) return;
    if (isRotate) this.rotateShown = show;
    else this.moveShown = show;
    window.clearTimeout(isRotate ? this.rotateAnimTimer : this.moveAnimTimer);

    if (!animate) {
      dot.classList.remove("is-appearing", "is-vanishing");
      dot.classList.toggle("is-hidden", !show);
      fx.clear();
      return;
    }

    const p = this.handlePoint(which);
    fx.center(p.x, p.y);
    let timer: number;
    if (show) {
      // Aparecer: las gotas convergen en el sitio del dot y este se funde desde ahí.
      dot.classList.remove("is-hidden", "is-vanishing");
      dot.classList.add("is-appearing");
      fx.gather();
      timer = window.setTimeout(() => {
        dot.classList.remove("is-appearing");
        fx.fadeOut();
      }, fx.gatherMs);
    } else {
      // Desaparecer: el dot se deshace en gotas que salen despedidas.
      dot.classList.remove("is-appearing");
      dot.classList.add("is-vanishing");
      fx.scatter();
      timer = window.setTimeout(() => {
        dot.classList.add("is-hidden");
        dot.classList.remove("is-vanishing");
        fx.clear();
      }, fx.scatterMs);
    }
    if (isRotate) this.rotateAnimTimer = timer;
    else this.moveAnimTimer = timer;
  }

  /** Centro de un puntico en coordenadas de viewport (para posicionar sus partículas,
      que viven en la capa a pantalla completa). Deriva de `positionHandles` sumando el
      origen del chip (`cx − r1`, `cy − r1`). */
  private handlePoint(which: "rotate" | "move"): { x: number; y: number } {
    const off = 20;
    if (which === "rotate") {
      return {
        x: this.cx + Math.cos(this.a0) * this.mid + Math.sin(this.a0) * off,
        y: this.cy + Math.sin(this.a0) * this.mid - Math.cos(this.a0) * off,
      };
    }
    return {
      x: this.cx + Math.cos(this.a1) * this.mid - Math.sin(this.a1) * off,
      y: this.cy + Math.sin(this.a1) * this.mid + Math.cos(this.a1) * off,
    };
  }

  /** Modo limpio: desactiva el cierre por pulsación de este chip (lo fija el gestor
      cuando su grupo se bloquea desde el hub). Los controles por-nivel se ocultan
      aparte vía `updateHandles`. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.el.classList.toggle("is-locked", locked);
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

  /** Arrastre por el puntico de mover. Mueve todo el ARO (mismo grupo+nivel) como una
      unidad. Al soltar, `trySnap` lo desengancha de su grupo y decide si se anida en otro
      (o vuelve a este) o queda suelto: así, mover un aro de un grupo multinivel SACA ese
      nivel para dejarlo fuera. */
  private beginMove(e: PointerEvent): void {
    e.preventDefault();
    const members = this.host.ring(this);
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
      this.host.trySnap(this);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Rota el ARO (mismo grupo+nivel) en su círculo: gira `a0,a1` alrededor del centro
      compartido sumando el mismo delta a cada miembro. En un grupo multinivel cada aro
      conserva su rotar, así se gira ese aro por separado dentro del grupo; el hub, en
      cambio, gira todos los niveles a la vez. */
  private beginRotate(e: PointerEvent): void {
    e.preventDefault();
    const members = this.host.ring(this);
    const start = members.map((m) => ({ m, a0: m.a0, a1: m.a1 }));
    for (const m of members) m.isDragging = true;
    this.el.classList.add("is-rotating");
    // Ángulo inicial del cursor respecto al centro (compartido por el aro).
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

  /** Fija el nivel concéntrico (la banda `r0/r1` se deriva de él). */
  setLevel(level: number): void {
    this.level = level;
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
    window.clearTimeout(this.rotateAnimTimer);
    window.clearTimeout(this.moveAnimTimer);
    const finish = (): void => {
      this.el.remove();
      this.fx.el.remove();
      this.rotateFx.el.remove();
      this.moveFx.el.remove();
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
      groupId: this.groupId,
      level: this.level,
      cx: this.cx,
      cy: this.cy,
      a0: this.a0,
      a1: this.a1,
    };
  }
}

/**
 * Núcleo (hub) de un grupo MULTINIVEL: en el centro compartido (`cx,cy`, la zona
 * interior vacía por debajo del nivel 0) va UN solo círculo de materia viva (mismo
 * ondulado `.materia-blob` que el hub de la rueda de color) que aloja dos botones
 * apilados —arriba MOVER, abajo ROTAR— sin corte ni división visible entre ellos.
 * Ambos operan sobre TODOS los niveles a la vez. Lo crea/posiciona/retira el gestor
 * en `refreshHandles`.
 */
class RingHub {
  readonly el: HTMLElement;
  private moveHalf: HTMLElement;
  private rotateHalf: HTMLElement;
  private groupId: string;
  private host: HubHost;
  /** Timer del long-press sobre MOVER que alterna el modo limpio del grupo. */
  private lockTimer = 0;

  constructor(groupId: string, host: HubHost) {
    this.groupId = groupId;
    this.host = host;
    // Un solo círculo de materia (como el hub de la rueda); dentro, mover arriba y
    // rotar abajo, sin corte ni división. El ondulado lo pone el CSS de .rm-hub con su
    // propio patrón de deformación para que el borde no mute idéntico al hub de la rueda.
    this.moveHalf = el("button", { class: "rm-hub-half rm-hub-move", type: "button", title: "Mover grupo", html: icon("grip") });
    this.rotateHalf = el("button", { class: "rm-hub-half rm-hub-rotate", type: "button", title: "Rotar grupo", html: icon("rotate") });
    this.el = el("div", { class: "rm-hub" }, [this.moveHalf, this.rotateHalf]);
    this.moveHalf.addEventListener("pointerdown", (e) => this.beginMove(e));
    this.rotateHalf.addEventListener("pointerdown", (e) => this.beginRotate(e));
  }

  /** Coloca el hub en el centro compartido del grupo (coords de viewport). */
  position(cx: number, cy: number): void {
    this.el.style.left = `${cx}px`;
    this.el.style.top = `${cy}px`;
  }

  /** Refleja si el grupo está en modo limpio (marca el hub para el usuario). */
  setLocked(locked: boolean): void {
    this.el.classList.toggle("is-locked", locked);
  }

  destroy(): void {
    window.clearTimeout(this.lockTimer);
    this.el.remove();
  }

  /** Mitad de arriba (MOVER). Dos gestos en el mismo botón:
      - Mantenerlo pulsado QUIETO ~3 s alterna el "modo limpio" del grupo (oculta los
        controles por-nivel y desactiva el cierre de cada chip), el mismo gesto y umbral
        que crea/cierra un chip. `.is-arming` da la realimentación creciente.
      - Arrastrarlo traslada el centro de TODOS los miembros del grupo el mismo offset;
        cualquier desplazamiento cancela el armado del modo limpio. */
  private beginMove(e: PointerEvent): void {
    e.preventDefault();
    const members = this.host.groupMembers(this.groupId);
    if (members.length === 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const start = members.map((m) => ({ m, cx: m.cx, cy: m.cy }));
    let moved = false;

    // Armado del long-press: mientras no haya arrastre, cuenta hacia el modo limpio.
    this.el.classList.add("is-arming");
    const disarm = (): void => {
      window.clearTimeout(this.lockTimer);
      this.el.classList.remove("is-arming");
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      for (const m of members) m.isDragging = false;
      this.el.classList.remove("is-moving");
    };
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) > CLOSE_MOVE_TOL) {
        moved = true;
        disarm();
        this.el.classList.add("is-moving");
      }
      if (!moved) return;
      for (const s of start) {
        s.m.adoptCenter(s.cx + dx, s.cy + dy);
        s.m.render();
      }
      this.position(start[0].cx + dx, start[0].cy + dy);
    };
    const up = (): void => {
      disarm();
      cleanup();
      if (moved) this.host.scheduleSave();
    };
    this.lockTimer = window.setTimeout(() => {
      disarm();
      cleanup();
      this.host.toggleGroupLock(this.groupId);
    }, CLOSE_HOLD_MS);

    for (const m of members) m.isDragging = true;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Mitad de abajo: suma el mismo delta angular a TODOS los miembros (todos los niveles).
      Como comparten centro, un mismo delta gira el grupo entero rígidamente. */
  private beginRotate(e: PointerEvent): void {
    e.preventDefault();
    const members = this.host.groupMembers(this.groupId);
    if (members.length === 0) return;
    const cx = members[0].cx;
    const cy = members[0].cy;
    const start = members.map((m) => ({ m, a0: m.a0, a1: m.a1 }));
    for (const m of members) m.isDragging = true;
    this.el.classList.add("is-rotating");
    const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
    const move = (ev: PointerEvent): void => {
      const a = Math.atan2(ev.clientY - cy, ev.clientX - cx);
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






