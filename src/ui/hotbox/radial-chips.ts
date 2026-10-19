import type { Editor } from "../../app/editor";
import { TAU, clamp } from "../../core/math";
import { el } from "../dom";
import { MateriaFx, prefersReducedMotion } from "../fx/materia";
import { icon } from "../icons";
import {
  arcPathD,
  dialText,
  dialTFromValue,
  dialValueFromT,
  needlePathD,
  tileNeedleD,
  tilePathD,
  type TileSpec,
} from "./arc-geometry";
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
/** Modo de un aro: circular ("ring") o tira recta ("strip"). */
type ChipMode = "ring" | "strip";
/** Eje de una tira: horizontal ("h") o vertical ("v"). */
type StripAxis = "h" | "v";
/** Aire (px) de la caja SVG de una baldosa tira, para que no corte el trazo redondo. */
const STRIP_PAD = 7;
/** Distancia (px) a la que los punticos se apartan de la banda. */
const HANDLE_OFF = 20;
/** Separación (px) del núcleo respecto al borde de una tira, para no taparla. */
const HUB_CLEAR = 52;
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
  /** Modo del aro (grupo+nivel). Ausente en registros viejos = "ring". */
  mode?: ChipMode;
  /** Eje de la tira; solo se usa con mode === "strip". */
  axis?: StripAxis;
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
  /** Cicla el modo del aro de `chip`: aro → tira horizontal → tira vertical → aro. */
  cycleRingMode(chip: RadialChip): void;
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
  /** Cicla el modo de TODO el grupo: aro → tiras horizontales → tiras verticales → aro. */
  cycleGroupMode(groupId: string): void;
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
      mode: "ring",
      axis: "h",
    };
    this.createChip(rec, desc.node);
    this.refreshHandles();
    // enter() tras crear para que las partículas se junten en el arco ya normalizado.
    this.chips.get(id)?.enter();
    this.scheduleSave();
  }

  /**
   * Nace un chip desde el paletón: resuelve el nodo por su camino en el árbol y
   * lo hace aparecer centrado en (x, y). Reusa `spawn` con un descriptor
   * sintético —el arco mira al norte (−π/2) y con la banda del nivel 0—, así el
   * chip sale igual que si se hubiera desgarrado del radial. Si el camino ya no
   * resuelve (el árbol cambió), no hace nada.
   */
  spawnByPath(path: number[], id: string, x: number, y: number): void {
    const node = resolveNode(this.tree(), path, id);
    if (!node) return;
    this.spawn({
      node,
      path,
      ringLevel: 1,
      angleWidth: CHIP_ANGLE,
      angleMid: -Math.PI / 2,
      innerR: levelR0(0),
      outerR: levelR0(0) + CHIP_BAND,
      viewport: { x, y },
    });
  }

  private createChip(rec: ChipRecord, node: HotNode): RadialChip {
    const chip = new RadialChip(rec, node, this);
    this.chips.set(rec.id, chip);
    this.el.appendChild(chip.el);
    this.el.appendChild(chip.fx.el);
    this.el.appendChild(chip.rotateFx.el);
    this.el.appendChild(chip.moveFx.el);
    this.el.appendChild(chip.modeFx.el);
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

    // Las tiras se pegan entre sí (mismo eje, adyacentes) pero no se anidan en
    // grupos de aros: mezclar carriles y anillos rompería la correspondencia
    // nivel↔banda. Si cae cerca de otra tira del mismo eje, se une a su grupo
    // como un nivel paralelo; si no, queda como grupo propio.
    if (chip.mode === "strip") {
      const draggedIds = new Set(dragged.map((c) => c.id));
      let target: RadialChip | null = null;
      let bestDist = Infinity;
      for (const other of this.chips.values()) {
        if (draggedIds.has(other.id)) continue;
        if (other.mode !== "strip" || other.axis !== chip.axis) continue;
        const d = Math.hypot(chip.cx - other.cx, chip.cy - other.cy);
        const reach = 2 * chip.halfLen + GROUP_SNAP;
        if (d < reach && d < bestDist) {
          bestDist = d;
          target = other;
        }
      }
      if (target) {
        this.nestStrip(dragged, target);
      } else {
        this.renormalizeLevels(chip.groupId);
      }
      this.refreshHandles();
      this.scheduleSave();
      return;
    }

    const draggedIds = new Set(dragged.map((c) => c.id));
    // Grupos con tiras no aceptan anidar aros: mezclar carriles y anillos en el mismo
    // grupo rompería la correspondencia nivel↔banda.
    const stripGroups = new Set<string>();
    for (const c of this.chips.values()) if (c.mode === "strip") stripGroups.add(c.groupId);

    // Grupo destino: el chip más cercano (por su centro) que NO sea del aro arrastrado
    // y quede dentro del alcance de anidado.
    let target: RadialChip | null = null;
    let bestDist = Infinity;
    for (const other of this.chips.values()) {
      if (draggedIds.has(other.id)) continue;
      if (stripGroups.has(other.groupId)) continue;
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

  /** Anida tiras arrastradas en el grupo de `target`. Las tiras se apilan
      perpendicularmente al eje: el nivel 0 va en el centro compartido, el 1 a un
      lado, etc. El nivel destino se calcula midiendo la distancia perpendicular
      desde el centro visual del primer trozo arrastrado hasta el centro del grupo. */
  private nestStrip(dragged: RadialChip[], target: RadialChip): void {
    const gcx = target.cx;
    const gcy = target.cy;
    const gid = target.groupId;
    const axis = target.axis;
    const groupChips = this.group(target);
    let maxL = 0;
    for (const c of groupChips) maxL = Math.max(maxL, c.level);

    const levelPitch = CHIP_BAND + LEVEL_GAP;
    // Centro visual del bloque arrastrado (promedio de sus centros visuales).
    let sumX = 0;
    let sumY = 0;
    for (const c of dragged) {
      const vc = c.visualCenter();
      sumX += vc.x;
      sumY += vc.y;
    }
    const bcx = sumX / dragged.length;
    const bcy = sumY / dragged.length;

    // Distancia perpendicular al eje desde el centro del grupo.
    // Horizontal: el eje corre en X, la pila crece en Y.
    // Vertical: el eje corre en Y, la pila crece en X.
    const perpDist = axis === "v" ? gcx - bcx : gcy - bcy;
    const approx = Math.round(perpDist / levelPitch);

    // Los niveles van de 0 (centro) hacia afuera. Un valor negativo significa
    // que cayó al lado opuesto del centro respecto a la convención de apilamiento;
    // lo tratamos como un nivel nuevo por debajo (se renormalizará a 0).
    // Cuando la distancia perpendicular es ≈0 (el trozo se acercó por el eje, no
    // desde un lado), nunca reutilizamos un nivel ocupado: siempre se apila como
    // carril nuevo para que no se superponga visualmente con los existentes.
    let newLevel: number;
    if (approx < 0) {
      newLevel = -1;
    } else {
      newLevel = maxL + 1;
    }

    for (const c of dragged) {
      c.groupId = gid;
      c.setLevel(newLevel);
      c.adoptCenter(gcx, gcy);
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

// Extremos por nivel. En aro se comparan ángulos; en tira, la posición del
      // centro visual sobre el eje correspondiente (X en horizontal, Y en vertical).
      const startByLevel = new Map<number, RadialChip>();
      const endByLevel = new Map<number, RadialChip>();
      for (const c of arr) {
        if (c.mode === "strip") {
          const vc = c.visualCenter();
          const pos = c.axis === "v" ? vc.y : vc.x;
          const s = startByLevel.get(c.level);
          if (!s) {
            startByLevel.set(c.level, c);
            endByLevel.set(c.level, c);
          } else {
            const sVc = s.visualCenter();
            const sPos = s.axis === "v" ? sVc.y : sVc.x;
            const e = endByLevel.get(c.level)!;
            const eVc = e.visualCenter();
            const ePos = e.axis === "v" ? eVc.y : eVc.x;
            if (pos < sPos) startByLevel.set(c.level, c);
            if (pos > ePos) endByLevel.set(c.level, c);
          }
        } else {
          const s = startByLevel.get(c.level);
          if (!s || c.a0 < s.a0) startByLevel.set(c.level, c);
          const e = endByLevel.get(c.level);
          if (!e || c.a1 > e.a1) endByLevel.set(c.level, c);
        }
      }
      for (const c of arr) {
        c.setLocked(locked);
        const atStart = startByLevel.get(c.level) === c;
        const atEnd = endByLevel.get(c.level) === c;
        // En tira el aro no gira: se retira el puntico de rotar y manda el de modo.
        const showRotate = !locked && c.mode === "ring" && atStart;
        const showMove = !locked && atEnd;
        const showMode = !locked && atStart;
        c.updateHandles(showRotate, showMove, showMode);
      }

      // Hub del grupo: solo con ≥2 niveles. Sin tiras vive en el centro compartido;
      // con tiras se aparta al lado de los carriles (ver `hubAnchor`).
      if (multiLevel) {
        let hub = this.hubs.get(gid);
        if (!hub) {
          hub = new RingHub(gid, this);
          this.hubs.set(gid, hub);
          this.el.appendChild(hub.el);
        }
        const anchor = this.hubAnchor(arr);
        hub.position(anchor.x, anchor.y);
        hub.setLocked(locked);
        hub.setLayout(this.groupLayout(arr));
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

  /**
   * Centro visual del núcleo. Con anillos es el centro compartido (el hueco interior).
   * Con tiras no hay hueco: el núcleo se aparta perpendicularmente al carril —a la
   * izquierda si son horizontales, por encima si son verticales— para no tapar las
   * baldosas. Si el grupo mezcla ejes, se elige el lado izquierdo.
   */
  private hubAnchor(members: RadialChip[]): { x: number; y: number } {
    const strips = members.filter((c) => c.mode === "strip");
    if (strips.length === 0) return { x: members[0].cx, y: members[0].cy };
    const points = members.map((c) => c.visualCenter());
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    if (strips.every((c) => c.axis === "v")) {
      return { x: (minX + maxX) / 2, y: minY - HUB_CLEAR };
    }
    return { x: minX - HUB_CLEAR, y: (minY + maxY) / 2 };
  }

  /** Reposiciona el hub de un grupo (lo llama el propio grupo al moverse por el hub). */
  repositionHub(groupId: string, cx: number, cy: number): void {
    this.hubs.get(groupId)?.position(cx, cy);
  }

  // ------------------------------------------------------------ modo aro/tira

  /** Siguiente estado del ciclo: aro → tira horizontal → tira vertical → aro. */
  private static nextMode(mode: ChipMode, axis: StripAxis): { mode: ChipMode; axis: StripAxis } {
    if (mode === "ring") return { mode: "strip", axis: "h" };
    if (axis === "h") return { mode: "strip", axis: "v" };
    return { mode: "ring", axis: "h" };
  }

  /** Cicla solo el aro de `chip` (todos sus trozos: mismo grupo+nivel). */
  cycleRingMode(chip: RadialChip): void {
    const ring = this.ring(chip);
    if (ring.length === 0) return;
    const next = RadialChips.nextMode(ring[0].mode, ring[0].axis);
    for (const c of ring) c.setLayout(next.mode, next.axis);
    this.afterLayoutChange();
  }

  /**
   * Cicla TODO el grupo: si todos sus aros están en el mismo estado, avanza el ciclo;
   * si están mezclados (alguno convertido por su cuenta), los unifica primero en
   * horizontal. Así el botón del núcleo siempre lleva a un estado conocido y los
   * carriles quedan paralelos.
   */
  cycleGroupMode(groupId: string): void {
    const members = this.groupMembers(groupId);
    if (members.length === 0) return;
    const first = members[0];
    const uniform = members.every((m) => m.mode === first.mode && m.axis === first.axis);
    const next = uniform
      ? RadialChips.nextMode(first.mode, first.axis)
      : { mode: "strip" as ChipMode, axis: "h" as StripAxis };
    for (const m of members) m.setLayout(next.mode, next.axis);
    this.afterLayoutChange();
  }

  /** Estado de presentación del grupo para el botón del núcleo. */
  private groupLayout(members: RadialChip[]): { mode: ChipMode; axis: StripAxis; mixed: boolean } {
    const first = members[0];
    const uniform = members.every((m) => m.mode === first.mode && m.axis === first.axis);
    return uniform
      ? { mode: first.mode, axis: first.axis, mixed: false }
      : { mode: "strip", axis: "h", mixed: true };
  }

  /** Repinta tras un cambio de modo y programa el guardado. */
  private afterLayoutChange(): void {
    for (const c of this.chips.values()) c.render();
    this.refreshHandles();
    this.scheduleSave();
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
    this.normalizeRingModes();
    this.refreshHandles();
  }

  /**
   * Un aro es UNA cosa: sus trozos comparten modo y eje. Si un registro viejo (sin
   * `mode`) o corrupto trae un aro mezclado, gana el primer trozo; así la geometría
   * de la tira siempre se puede derivar sin ambigüedad.
   */
  private normalizeRingModes(): void {
    const rings = new Map<string, RadialChip[]>();
    for (const c of this.chips.values()) {
      const key = `${c.groupId}|${c.level}`;
      const arr = rings.get(key) ?? [];
      arr.push(c);
      rings.set(key, arr);
    }
    for (const arr of rings.values()) {
      const first = arr[0];
      for (const c of arr) {
        c.mode = first.mode;
        c.axis = first.axis;
      }
    }
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
 * ángulos (`a0,a1`) en coordenadas de viewport. Lleva tres punticos de materia
 * (rotar / modo / mover) y, si es un dial, el relleno + la aguja que lo hacen un slider.
 *
 * Un aro puede estar en modo `ring` (tajada curva) o `strip` (baldosa recta): el
 * botón de modo cicla aro → tira horizontal → tira vertical → aro. En tira los
 * trozos del aro se linearizan en su orden angular; los niveles concéntricos del
 * grupo pasan a carriles paralelos. El modo se guarda por aro (grupo+nivel).
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
  /** Modo del aro: tajada curva o baldosa recta. */
  mode: ChipMode = "ring";
  /** Eje de la tira (solo en modo `strip`). */
  axis: StripAxis = "h";

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
  private modeDot: HTMLElement;
  /** Origen (viewport) del elemento: `left/top` puestos en el último render. */
  private originX = 0;
  private originY = 0;
  /** Partículas propias de cada puntico: al ocultarse/mostrarse (modo limpio, o al
      reformar el aro) se juntan/dispersan como en el menú radial, no de golpe. */
  readonly rotateFx: MateriaFx;
  readonly moveFx: MateriaFx;
  readonly modeFx: MateriaFx;
  /** Estado visible actual de cada puntico y si ya hubo un primer `updateHandles`
      (el primero fija el estado sin animar: el chip nace/restaura con su propia
      materia, animar los punticos encima sería un doble parpadeo). */
  private rotateShown = true;
  private moveShown = true;
  private modeShown = true;
  private handlesInit = false;
  private rotateAnimTimer = 0;
  private moveAnimTimer = 0;
  private modeAnimTimer = 0;
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
    this.mode = rec.mode === "strip" ? "strip" : "ring";
    this.axis = rec.axis === "v" ? "v" : "h";
    this.node = node;
    this.host = host;

    this.fx = new MateriaFx({ coreSize: 96, reach: 80, gatherMs: 380, scatterMs: 300 });
    // Punticos: el filtro gooey compartido (#materia-goo, blur 7px + umbral) está
    // calibrado para masas grandes (~112px); con un `coreSize` pequeño las gotas
    // salían de 4-10px y el blur+umbral se las comía —no se veía nada—. Así que las
    // gotas van a una escala visible (`coreSize` grande manda su tamaño) pero SIN
    // núcleo sólido (`solidCore:false`): solo las gotas gooey convergen/estallan
    // alrededor del dot de 30px y luego cruzan al dot real. `reach` corto para que
    // el revoloteo quede ceñido al puntico.
    const dotFx = (): MateriaFx =>
      new MateriaFx({ coreSize: 84, reach: 44, dots: 7, solidCore: false, gatherMs: 300, scatterMs: 260 });
    this.rotateFx = dotFx();
    this.moveFx = dotFx();
    this.modeFx = dotFx();

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
    // Tres punticos de materia. Rotar y mover operan sobre todo el ARO (mismo
    // grupo+nivel); el de modo cicla ese mismo aro entre aro, tira horizontal y tira
    // vertical. Aparecen en los extremos del aro (rotar/mover) y el de modo en el
    // trozo inicial, junto a ellos. No hay botón de cerrar: se cierra manteniéndolo
    // pulsado quieto ~3 s, el mismo gesto con que se arrancó.
    this.rotateDot = el("button", { class: "rm-chip-dot rm-chip-rotate materia-blob", type: "button", title: "Rotar", html: icon("rotate") });
    this.modeDot = el("button", { class: "rm-chip-dot rm-chip-mode materia-blob", type: "button", title: "Tira horizontal", html: icon("circle") });
    this.moveDot = el("button", { class: "rm-chip-dot rm-chip-move materia-blob", type: "button", title: "Mover", html: icon("grip") });

    // Nace oculto (materia-hidden): las partículas lo forman antes de que entre.
    this.el = el("div", { class: "rm-chip materia-hidden" }, [
      this.svg as unknown as HTMLElement,
      this.label,
      this.rotateDot,
      this.modeDot,
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
    this.modeDot.addEventListener("pointerdown", (e) => this.beginModeCycle(e));
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
    if (this.node.kind === "dial") {
      if (this.mode === "strip") this.beginStripDialDrag(e);
      else this.beginDialDrag(e);
    }
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

/** Pulsación sobre el puntico de modo: cicla el aro entre aro → tira H → tira V → aro.
      Un tap corto basta; no necesita long-press ni arrastre. */
  private beginModeCycle(_e: PointerEvent): void {
    this.host.cycleRingMode(this);
  }

  /** Semilargo de la baldosa recta (media longitud a lo largo del eje). */
  get halfLen(): number {
    return Math.max(CHIP_BAND * 0.85, ((this.a1 - this.a0) * this.mid) / 2);
  }

  /** Semiancho de la banda recta (perpendicular al eje). */
  get halfBand(): number {
    return CHIP_BAND / 2;
  }

  /** Ajusta el `<svg>` al tamaño actual: lado 2·r1 en aro, caja de la baldosa en tira. */
  private applySvgSize(): void {
    if (this.mode === "strip") {
      const w = 2 * this.halfLen + STRIP_PAD * 2;
      const h = 2 * this.halfBand + STRIP_PAD * 2;
      // Origen del viewBox en el centro de la baldosa: `tilePathD` trabaja en
      // coordenadas locales centradas y el SVG las mapea directo.
      this.svg.setAttribute("viewBox", `${-w / 2} ${-h / 2} ${w} ${h}`);
      this.svg.setAttribute("width", String(w));
      this.svg.setAttribute("height", String(h));
      return;
    }
    const size = 2 * this.r1;
    this.svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    this.svg.setAttribute("width", String(size));
    this.svg.setAttribute("height", String(size));
  }

  /** Repinta el trozo: posición del elemento, tajada (o baldosa), dial, punticos y
      etiqueta, según modo/eje/geometría y el valor actual. */
  render(): void {
    this.applySvgSize();
    this.updateModeDot();
    this.el.classList.toggle("is-strip", this.mode === "strip");
    this.el.classList.toggle("is-strip-v", this.mode === "strip" && this.axis === "v");

    const center = this.visualCenter();
    if (this.mode === "strip") {
      const w = 2 * this.halfLen + STRIP_PAD * 2;
      const h = 2 * this.halfBand + STRIP_PAD * 2;
      this.originX = center.x - w / 2;
      this.originY = center.y - h / 2;
    } else {
      this.originX = this.cx - this.r1;
      this.originY = this.cy - this.r1;
    }
    this.el.style.left = `${this.originX}px`;
    this.el.style.top = `${this.originY}px`;

    if (this.mode === "strip") {
      const spec: TileSpec = {
        vertical: this.axis === "v",
        halfLen: this.halfLen,
        halfBand: this.halfBand,
        from: 0,
        to: 1,
        gapPx: CHIP_GAP_PX,
      };
      this.sectorPath.setAttribute("d", tilePathD(spec));

      if (this.dial && this.node.kind === "dial") {
        const node = this.node;
        const t = dialTFromValue(node);
        this.dial.fill.setAttribute("d", t <= 0.002 ? "" : tilePathD({ ...spec, to: t }));
        this.dial.thumb.setAttribute("d", tileNeedleD(spec, t));
        this.label.textContent = dialText(node, false);
      }
    } else {
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
    }

    this.positionHandles();
    this.positionLabel();
  }

  /** Icono y título del puntico de modo, según el estado actual del aro. */
  private updateModeDot(): void {
    const dot = this.modeDot;
    dot.classList.toggle("is-strip", this.mode === "strip");
    dot.classList.toggle("is-strip-v", this.mode === "strip" && this.axis === "v");
    if (this.mode === "ring") {
      dot.title = "Tira horizontal";
      dot.innerHTML = icon("circle");
    } else if (this.axis === "h") {
      dot.title = "Tira vertical";
      dot.innerHTML = icon("flatten");
    } else {
      dot.title = "Volver a aro";
      dot.innerHTML = icon("flatten");
    }
  }

  /** Coloca los tres punticos en coordenadas locales del elemento. En aro van a los
      bordes del sector (rotar en a0, mover en a1) y el de modo en el centro angular;
      en tira van a los extremos de la baldosa (rotar en el inicio, mover en el final)
      y el de modo en el centro, los tres sobre el lado exterior de la banda. */
  private positionHandles(): void {
    const place = (dot: HTMLElement, p: { x: number; y: number }): void => {
      dot.style.left = `${p.x - this.originX}px`;
      dot.style.top = `${p.y - this.originY}px`;
    };
    place(this.rotateDot, this.handlePoint("rotate"));
    place(this.modeDot, this.handlePoint("mode"));
    place(this.moveDot, this.handlePoint("move"));
  }

  /** Enseña rotar/mover/modo solo en los extremos del conjunto: suelto, el trozo es
      sus dos extremos (enseña ambos); conectado, solo el del extremo inicial enseña
      rotar y modo, y solo el del final enseña mover. Lo llama el gestor tras cualquier
      cambio. */
  updateHandles(showRotate: boolean, showMove: boolean, showMode: boolean): void {
    // El primer `updateHandles` (nacimiento/restauración) fija el estado sin animar:
    // el chip ya llega con su propia materia y animar los punticos encima parpadearía.
    // Después, cada cambio (bloqueo del grupo, reformar el aro) juega las partículas.
    const animate =
      this.handlesInit &&
      !this.el.classList.contains("materia-hidden") &&
      !prefersReducedMotion();
    this.setHandle("rotate", showRotate, animate);
    this.setHandle("move", showMove, animate);
    this.setHandle("mode", showMode, animate);
    this.handlesInit = true;
  }

  /** Muestra u oculta un puntico. Sin cambio real, no hace nada. Con `animate`, las
      partículas se juntan (mostrar) o se dispersan (ocultar) como en el menú radial;
      sin él, alterna `is-hidden` al instante. */
  private setHandle(which: "rotate" | "move" | "mode", show: boolean, animate: boolean): void {
    const dot = which === "rotate" ? this.rotateDot : which === "move" ? this.moveDot : this.modeDot;
    const fx = which === "rotate" ? this.rotateFx : which === "move" ? this.moveFx : this.modeFx;
    const prev = which === "rotate" ? this.rotateShown : which === "move" ? this.moveShown : this.modeShown;
    if (this.handlesInit && show === prev) return;
    if (which === "rotate") this.rotateShown = show;
    else if (which === "move") this.moveShown = show;
    else this.modeShown = show;
    window.clearTimeout(
      which === "rotate" ? this.rotateAnimTimer : which === "move" ? this.moveAnimTimer : this.modeAnimTimer,
    );

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
    if (which === "rotate") this.rotateAnimTimer = timer;
    else if (which === "move") this.moveAnimTimer = timer;
    else this.modeAnimTimer = timer;
  }

/** Centro de un puntico en coordenadas de viewport (para posicionar sus partículas,
      que viven en la capa a pantalla completa). En aro deriva del ángulo/radio; en
      tira, de los extremos del eje (rotar/mover en los cabos, modo en el centro),
      siempre sobre la línea central de la banda para que los dots queden alineados
      en recta cuando varios trozos se ensamblan. */
  private handlePoint(which: "rotate" | "move" | "mode"): { x: number; y: number } {
    const off = HANDLE_OFF;
    if (this.mode === "strip") {
      const c = this.visualCenter();
      const along = this.halfLen + off;
      // El puntico de modo se asoma justo fuera del borde ancho de la tira para
      // que no quede tapado por la etiqueta central. Rotar y mover siguen sobre
      // el eje para que los dots se alineen en recta entre trozos contiguos.
      const cross = this.halfBand + off;
      if (this.axis === "v") {
        const y = which === "rotate" ? c.y - along : which === "move" ? c.y + along : c.y;
        const x = which === "mode" ? c.x + cross : c.x;
        return { x, y };
      }
      const x = which === "rotate" ? c.x - along : which === "move" ? c.x + along : c.x;
      const y = which === "mode" ? c.y + cross : c.y;
      return { x, y };
    }
    if (which === "mode") {
      const amid = (this.a0 + this.a1) / 2;
      return {
        x: this.cx + Math.cos(amid) * this.mid + Math.sin(amid) * off,
        y: this.cy + Math.sin(amid) * this.mid - Math.cos(amid) * off,
      };
    }
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

/** Coloca la etiqueta (valor/icono) en el centro visual del trozo. En aro usa
      coordenadas polares (el centro del SVG está en cx−r1, cy−r1); en tira el
      centro de la baldosa coincide con el origen local del SVG centrado. */
  private positionLabel(): void {
    if (this.mode === "strip") {
      // El SVG de la tira ya está centrado en visualCenter(); la etiqueta va
      // en el centro de la caja local (mitad del ancho/alto del viewBox).
      this.label.style.left = `${this.halfLen + STRIP_PAD}px`;
      this.label.style.top = `${this.halfBand + STRIP_PAD}px`;
      return;
    }
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

  /** Arrastre del dial en tira recta: mapea la coordenada lineal del cursor a lo
      largo del eje de la baldosa (X si horizontal, Y si vertical) a t∈[0,1]. */
  private beginStripDialDrag(e: PointerEvent): void {
    if (this.node.kind !== "dial") return;
    e.preventDefault();
    this.isDragging = true;
    this.el.classList.add("is-active");
    this.applyStripDialDrag(e);
    const move = (ev: PointerEvent): void => this.applyStripDialDrag(ev);
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

  private applyStripDialDrag(e: PointerEvent): void {
    const node = this.node as DialNode;
    const c = this.visualCenter();
    // Proyecta el cursor sobre el eje de la tira, relativo al centro visual.
    const along = this.axis === "v" ? e.clientY - c.y : e.clientX - c.x;
    const t = clamp((along + this.halfLen) / (2 * this.halfLen), 0, 1);
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
      mode: this.mode,
      axis: this.axis,
    };
  }

  /** Cambia el modo de presentación del chip (aro ↔ tira) y repinta. Lo llama el
      gestor al ciclar un aro o un grupo entero. */
  setLayout(mode: ChipMode, axis: StripAxis): void {
    this.mode = mode;
    this.axis = axis;
    this.render();
  }

  /** Centro visual del chip: en aro es el centro virtual compartido (`cx, cy`);
      en tira es el centro geométrico de la baldosa recta, desplazado desde `cx,cy`
      según el eje para que los carriles paralelos no se solapen. */
  visualCenter(): { x: number; y: number } {
    if (this.mode === "ring") return { x: this.cx, y: this.cy };
    // En tira, cx/cy siguen siendo el centro virtual del grupo. La baldosa se
    // coloca perpendicularmente al eje según su nivel para que los carriles
    // queden paralelos sin solaparse.
    const offset = this.level * (CHIP_BAND + LEVEL_GAP);
    if (this.axis === "v") return { x: this.cx - offset, y: this.cy };
    return { x: this.cx, y: this.cy - offset };
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
  private modeHalf: HTMLElement;
  private groupId: string;
  private host: HubHost;
  /** Timer del long-press sobre MOVER que alterna el modo limpio del grupo. */
  private lockTimer = 0;

  constructor(groupId: string, host: HubHost) {
    this.groupId = groupId;
    this.host = host;
    // Un solo círculo de materia (como el hub de la rueda); dentro, tres botones
    // apilados sin corte ni división: MOVER arriba, ROTAR en medio, MODO abajo.
    // El ondulado lo pone el CSS de .rm-hub con su propio patrón de deformación.
    this.moveHalf = el("button", { class: "rm-hub-half rm-hub-move", type: "button", title: "Mover grupo", html: icon("grip") });
    this.rotateHalf = el("button", { class: "rm-hub-half rm-hub-rotate", type: "button", title: "Rotar grupo", html: icon("rotate") });
    this.modeHalf = el("button", { class: "rm-hub-half rm-hub-mode", type: "button", title: "Cambiar modo", html: icon("circle") });
    this.el = el("div", { class: "rm-hub" }, [this.moveHalf, this.rotateHalf, this.modeHalf]);
    this.moveHalf.addEventListener("pointerdown", (e) => this.beginMove(e));
    this.rotateHalf.addEventListener("pointerdown", (e) => this.beginRotate(e));
    this.modeHalf.addEventListener("click", () => this.host.cycleGroupMode(this.groupId));
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

  /** Actualiza el icono y título del botón de modo según el estado del grupo. */
  setLayout(layout: { mode: ChipMode; axis: StripAxis; mixed: boolean }): void {
    if (layout.mode === "ring") {
      this.modeHalf.title = "Tira horizontal";
      this.modeHalf.innerHTML = icon("circle");
    } else if (layout.axis === "h") {
      this.modeHalf.title = "Tira vertical";
      this.modeHalf.innerHTML = icon("flatten");
    } else {
      this.modeHalf.title = "Volver a aro";
      this.modeHalf.innerHTML = icon("circle");
    }
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






