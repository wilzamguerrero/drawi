import { uid } from "../core/rng";
import { multiply, type Mat2d } from "../core/mat2d";
import { polygonBounds } from "../stroke/outline";
import type { Polygon } from "../stroke/types";
import { boundingRadius, DEFAULT_SHAPE, type ShapeDef } from "../physics/shapes";
import { bodiesForInkItem } from "../physics/stroke-matter";
import { createBody, PhysicsWorld, type Body, type WorldSettings } from "../physics/world";
import { DEFAULT_SYMMETRY, normalizeSymmetry, symmetryTransforms, type SymmetryState } from "../symmetry/symmetry";
import { DEFAULT_FIELD_STYLE, type FieldStyle } from "../render/field-gl";
import { EMPTY_RECT, unionRect, type InkItem, type Rect } from "./types";
import { cloneLayer, makeMask, type LayerColor, type SceneLayer } from "./layer";

export interface DocumentMeta {
  name: string;
  background: string;
  createdAt: number;
}

/** Instantanea serializable de un cuerpo (lo que guarda el historial). */
export interface BodySnapshot {
  id: string;
  shape: ShapeDef;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  av: number;
  color: string;
  group: number;
  blend: number;
  bridgeReach: number;
  isStatic: boolean;
  density: number;
  restitution: number;
  friction: number;
  layerId: string;
  strokeId?: string;
  strokeIndex?: number;
  strokePivotX?: number;
  strokePivotY?: number;
}

export interface SceneSnapshot {
  items: InkItem[];
  layers: SceneLayer[];
  activeLayerId: string;
  bodies: BodySnapshot[];
  symmetry: SymmetryState;
  world: WorldSettings;
  field: FieldStyle;
  background: string;
}

const cloneSymmetry = (s: SymmetryState): SymmetryState => ({ ...s });
const cloneWorld = (w: WorldSettings): WorldSettings => ({ ...w, gravity: { ...w.gravity } });

export function snapshotBody(b: Body): BodySnapshot {
  return {
    id: b.id,
    shape: { ...b.shape },
    x: b.pos.x,
    y: b.pos.y,
    angle: b.angle,
    vx: b.vel.x,
    vy: b.vel.y,
    av: b.angVel,
    color: b.color,
    group: b.group,
    blend: b.blend,
    bridgeReach: b.bridgeReach,
    isStatic: b.isStatic,
    density: b.density,
    restitution: b.restitution,
    friction: b.friction,
    layerId: b.layerId,
    strokeId: b.strokeId,
    strokeIndex: b.strokeIndex,
    strokePivotX: b.strokePivotX,
    strokePivotY: b.strokePivotY,
  };
}

export function restoreBody(s: BodySnapshot): Body {
  const body = createBody({ ...s.shape }, { x: s.x, y: s.y }, {
    angle: s.angle,
    color: s.color,
    group: s.group,
    blend: s.blend,
    bridgeReach: s.bridgeReach ?? -1,
    isStatic: s.isStatic,
    density: s.density,
    restitution: s.restitution,
    friction: s.friction,
    layerId: s.layerId,
  });
  body.id = s.id;
  body.vel.x = s.vx;
  body.vel.y = s.vy;
  body.angVel = s.av;
  body.strokeId = s.strokeId;
  body.strokeIndex = s.strokeIndex;
  body.strokePivotX = s.strokePivotX;
  body.strokePivotY = s.strokePivotY;
  return body;
}

/**
 * Documento: tinta + materia.
 *
 * La tinta es una lista plana de `InkItem` inmutables (cada trazo se guarda
 * con sus transformaciones de simetria ya congeladas). La materia vive en el
 * mundo fisico y se mueve sola. El historial fotografia ambas: la tinta se
 * comparte por referencia (nunca se muta un item) y de los cuerpos se guarda
 * un snapshot plano, que es barato y exacto.
 */
export class SceneDocument {
  meta: DocumentMeta = {
    name: "Sin titulo",
    background: "#f4f1ea",
    createdAt: Date.now(),
  };

  items: InkItem[] = [];
  /** Capas ordenadas de abajo (índice 0) arriba. El z global lo da este orden. */
  layers: SceneLayer[] = [];
  activeLayerId = "";
  private layerCounter = 0;

  readonly physics = new PhysicsWorld();
  symmetry: SymmetryState = normalizeSymmetry(DEFAULT_SYMMETRY);
  field: FieldStyle = { ...DEFAULT_FIELD_STYLE };
  shape: ShapeDef = { ...DEFAULT_SHAPE };

  /** Cambia con cada modificacion; los renderizadores lo usan como cache key. */
  inkRevision = 0;

  constructor() {
    this.resetLayers();
  }

  get bodies(): Body[] {
    return this.physics.bodies;
  }

  get isEmpty(): boolean {
    return this.items.length === 0 && this.physics.bodies.length === 0;
  }

  // ----------------------------------------------------------------- capas

  /**
   * Deja el documento con una sola capa de tinta y ninguna de materia.
   *
   * La materia no es una pseudo-capa fija: nace cuando se crea el primer cuerpo
   * (`matterTarget`) y desaparece al borrar su capa. Asi el panel no muestra una
   * fila "Materia" vacia en un documento donde nadie ha creado materia.
   */
  resetLayers(): void {
    this.layerCounter = 0;
    const ink = this.makeInkLayer();
    this.layers = [ink];
    this.activeLayerId = ink.id;
  }

  private makeInkLayer(name?: string): SceneLayer {
    this.layerCounter++;
    return {
      id: uid(),
      kind: "ink",
      name: name ?? `Capa ${this.layerCounter}`,
      visible: true,
      opacity: 1,
      fill: 1,
      blend: "source-over",
      locked: false,
      alphaLock: false,
      clip: false,
      color: "none",
      collapsed: false,
      parentId: null,
    };
  }

  private makeMatterLayer(name?: string): SceneLayer {
    return {
      id: uid(),
      kind: "matter",
      name: name ?? "Materia",
      visible: true,
      opacity: 1,
      fill: 1,
      blend: "source-over",
      locked: false,
      alphaLock: false,
      clip: false,
      color: "none",
      collapsed: false,
      parentId: null,
    };
  }

  private makeAquaLayer(name?: string): SceneLayer {
    this.layerCounter++;
    return {
      id: uid(),
      kind: "aqua",
      name: name ?? `Acuarela ${this.layerCounter}`,
      visible: true,
      opacity: 1,
      fill: 1,
      blend: "source-over",
      locked: false,
      alphaLock: false,
      clip: false,
      color: "none",
      collapsed: false,
      parentId: null,
    };
  }

  makeImageLayer(name: string, src: string, x: number, y: number, w: number, h: number): SceneLayer {
    this.layerCounter++;
    return {
      id: uid(),
      kind: "image",
      name: name || `Imagen ${this.layerCounter}`,
      visible: true,
      opacity: 1,
      fill: 1,
      blend: "source-over",
      locked: false,
      alphaLock: false,
      clip: false,
      color: "none",
      collapsed: false,
      parentId: null,
      imageSrc: src,
      imageX: x,
      imageY: y,
      imageW: w,
      imageH: h,
    };
  }

  addImageLayer(name: string, src: string, x: number, y: number, w: number, h: number): SceneLayer {
    const layer = this.makeImageLayer(name, src, x, y, w, h);
    const active = this.activeLayer;
    const at = active ? this.layerIndex(active.id) + 1 : this.layers.length;
    this.layers.splice(at, 0, layer);
    this.activeLayerId = layer.id;
    this.inkRevision++;
    return layer;
  }

  /** Envuelve items planos (proyectos v1) en una capa de tinta por defecto. */
  migrateFlatItems(): void {
    this.resetLayers();
    const inkId = this.activeLayerId;
    for (const it of this.items) it.layerId = inkId;
    this.inkRevision++;
  }

  /** Restablece las invariantes de capas tras cargar o migrar: al menos una capa
   * de tinta, un `activeLayerId` válido y ningún item huérfano. Los cuerpos sin
   * capa de materia válida se reagrupan en una (existente o recién creada). */
  ensureLayers(): void {
    if (!this.layers.some((l) => l.kind === "ink")) this.layers.unshift(this.makeInkLayer());
    const ids = new Set(this.layers.map((l) => l.id));
    const inkId = (this.firstInkLayer() as SceneLayer).id;
    for (const it of this.items) if (!ids.has(it.layerId)) it.layerId = inkId;
    if (!ids.has(this.activeLayerId)) this.activeLayerId = inkId;

    // Cuerpos huérfanos (sin capa de materia, o apuntando a una inexistente):
    // van a la primera capa de materia; si no hay ninguna, se crea una. Solo se
    // crea una capa de materia cuando de verdad hay cuerpos que alojar.
    let matterLayers = this.layers.filter((l) => l.kind === "matter");
    const orphans = this.bodies.filter((b) => !matterLayers.some((l) => l.id === b.layerId));
    if (orphans.length > 0) {
      let target = matterLayers[0];
      if (!target) {
        target = this.makeMatterLayer();
        this.layers.push(target);
      }
      for (const b of orphans) b.layerId = target.id;
    }
  }

  /** Quita capas de materia sin cuerpos (usado al migrar proyectos antiguos que
   * forzaban una capa de materia aunque el usuario no hubiera creado nada). */
  dropEmptyMatterLayers(): void {
    const empties = this.layers.filter(
      (l) => l.kind === "matter" && this.physics.bodiesOf(l.id).length === 0,
    );
    if (empties.length === 0) return;
    const ids = new Set(empties.map((l) => l.id));
    this.layers = this.layers.filter((l) => !ids.has(l.id));
    if (ids.has(this.activeLayerId)) {
      this.activeLayerId = (this.firstInkLayer() ?? this.layers[0]).id;
    }
  }

  get activeLayer(): SceneLayer | undefined {
    return this.layerById(this.activeLayerId);
  }

  get matterLayers(): SceneLayer[] {
    return this.layers.filter((l) => l.kind === "matter");
  }

  get aquaLayers(): SceneLayer[] {
    return this.layers.filter((l) => l.kind === "aqua");
  }

  /**
   * Capa de acuarela donde deben caer las huellas nuevas: la activa si lo es,
   * si no la última creada, y si no hay ninguna se crea una. Así el pincel de
   * acuarela nunca pinta en el vacío, igual que `matterTarget` con la materia.
   */
  aquaTarget(): SceneLayer {
    const active = this.activeLayer;
    if (active?.kind === "aqua") return active;
    const existing = this.aquaLayers[this.aquaLayers.length - 1];
    return existing ?? this.addAquaLayer();
  }

  matterTarget(): SceneLayer {
    const active = this.activeLayer;
    if (active?.kind === "matter") return active;
    const existing = this.matterLayers[this.matterLayers.length - 1];
    if (existing) return existing;
    return this.addMatterLayer();
  }

  layerById(id: string): SceneLayer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  /** Items de una capa, en el orden en que fueron dibujados (z interno). */
  layerItems(id: string): InkItem[] {
    return this.items.filter((it) => it.layerId === id);
  }

  /** Capas hijas de un grupo (o de la raíz si `parentId` es null), en orden. */
  childLayers(parentId: string | null): SceneLayer[] {
    return this.layers.filter((l) => l.parentId === parentId);
  }

  /** Primera capa de tinta editable (para no dejar nunca el documento sin destino). */
  private firstInkLayer(): SceneLayer | undefined {
    return this.layers.find((l) => l.kind === "ink");
  }

  /** Índice de una capa en el array (o -1). */
  private layerIndex(id: string): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  /** Crea una capa de tinta nueva encima de la activa y la deja seleccionada. */
  addLayer(): SceneLayer {
    const layer = this.makeInkLayer();
    const active = this.activeLayer;
    layer.parentId = active && active.kind !== "matter" ? active.parentId : null;
    const at = active ? this.layerIndex(active.id) + 1 : this.layers.length;
    this.layers.splice(at, 0, layer);
    this.activeLayerId = layer.id;
    this.inkRevision++;
    return layer;
  }

  /** Crea un grupo (carpeta) encima de la activa. */
  addGroup(name?: string): SceneLayer {
    this.layerCounter++;
    const group: SceneLayer = {
      ...this.makeInkLayer(name ?? `Grupo ${this.layerCounter}`),
      id: uid(),
      kind: "group",
    };
    const active = this.activeLayer;
    const at = active ? this.layerIndex(active.id) + 1 : this.layers.length;
    this.layers.splice(at, 0, group);
    this.activeLayerId = group.id;
    this.inkRevision++;
    return group;
  }

  /** Crea una capa de materia encima de la activa. */
  addMatterLayer(name?: string): SceneLayer {
    const layer = this.makeMatterLayer(name);
    const active = this.activeLayer;
    const at = active ? this.layerIndex(active.id) + 1 : this.layers.length;
    this.layers.splice(at, 0, layer);
    this.activeLayerId = layer.id;
    this.inkRevision++;
    return layer;
  }

  /** Crea una capa de acuarela encima de la activa. */
  addAquaLayer(name?: string): SceneLayer {
    const layer = this.makeAquaLayer(name);
    const active = this.activeLayer;
    const at = active ? this.layerIndex(active.id) + 1 : this.layers.length;
    this.layers.splice(at, 0, layer);
    this.activeLayerId = layer.id;
    this.inkRevision++;
    return layer;
  }

  /** ¿`id` es `ancestorId` o desciende de él? (corta ciclos por seguridad). */
  isDescendantOf(id: string, ancestorId: string): boolean {
    let p: string | null = id;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (p === ancestorId) return true;
      seen.add(p);
      p = this.layerById(p)?.parentId ?? null;
    }
    return false;
  }

  /** La capa y todas sus descendientes, a cualquier profundidad. */
  subtreeIds(id: string): Set<string> {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of this.layers) {
        if (!out.has(l.id) && l.parentId !== null && out.has(l.parentId)) {
          out.add(l.id);
          grew = true;
        }
      }
    }
    return out;
  }

  /**
   * Elimina una capa con su contenido: los items si es de tinta (y, si es
   * grupo, también los de sus descendientes) o los cuerpos si es de materia.
   */
  removeLayer(id: string): void {
    const layer = this.layerById(id);
    if (!layer) return;

    // Materia y acuarela no alojan items de tinta: su contenido vive en el
    // mundo físico o en la GPU, así que basta con soltar la fila. Son capas
    // eliminables aunque fueran las únicas de su tipo: la invariante que el
    // documento protege es tener siempre una capa de TINTA donde dibujar.
    if (layer.kind === "matter" || layer.kind === "aqua") {
      if (layer.kind === "matter") this.physics.removeByLayer(id);
      this.layers = this.layers.filter((l) => l.id !== id);
      if (this.activeLayerId === id) {
        this.activeLayerId = (this.firstInkLayer() ?? this.layers[0])?.id ?? "";
      }
      this.inkRevision++;
      return;
    }

    // Un grupo se lleva TODO su subárbol, no solo sus hijas directas.
    const ids = layer.kind === "group" ? this.subtreeIds(id) : new Set<string>([id]);
    // No dejar el documento sin ninguna capa de tinta.
    const remainingInk = this.layers.filter((l) => l.kind === "ink" && !ids.has(l.id));
    if (remainingInk.length === 0) {
      // Vaciar la capa en vez de borrarla: siempre debe quedar un destino.
      this.items = this.items.filter((it) => !ids.has(it.layerId));
      if (layer.mask) layer.mask = makeMask();
      this.inkRevision++;
      return;
    }
    this.items = this.items.filter((it) => !ids.has(it.layerId));
    this.layers = this.layers.filter((l) => !ids.has(l.id));
    if (ids.has(this.activeLayerId)) {
      this.activeLayerId = (this.firstInkLayer() ?? this.layers[0]).id;
    }
    this.inkRevision++;
  }

  /** Duplica una capa de tinta o imagen. Imagen: clona la capa raster. */
  duplicateLayer(id: string): SceneLayer | null {
    const layer = this.layerById(id);
    if (!layer || (layer.kind !== "ink" && layer.kind !== "image")) return null;
    if (layer.kind === "image") {
      const copy = cloneLayer(layer);
      copy.id = uid();
      copy.name = `${layer.name} copia`;
      const at = this.layerIndex(id) + 1;
      this.layers.splice(at, 0, copy);
      this.activeLayerId = copy.id;
      this.inkRevision++;
      return copy;
    }
    const copy = cloneLayer(layer);
    copy.id = uid();
    copy.name = `${layer.name} copia`;
    const at = this.layerIndex(id) + 1;
    this.layers.splice(at, 0, copy);
    // Copiar sus items justo después de los originales, con id y capa nuevos.
    const clones = this.layerItems(id).map((it) => ({
      ...it,
      id: uid(),
      polys: it.polys.map((p) => p.slice()),
      transforms: it.transforms.slice(),
      layerId: copy.id,
    }));
    // Insertar tras el último item de la capa original para conservar el z.
    let insertAt = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].layerId === id) {
        insertAt = i + 1;
        break;
      }
    }
    this.items.splice(insertAt, 0, ...clones);
    this.activeLayerId = copy.id;
    this.inkRevision++;
    return copy;
  }

  /** Combina una capa con la de tinta o imagen inmediatamente inferior. Para imagen, la rasteriza sobre la inferior si es ink/image. */
  mergeDown(id: string): void {
    const layer = this.layerById(id);
    if (!layer || (layer.kind !== "ink" && layer.kind !== "image")) return;
    if (layer.kind === "image") {
      // No-op seguro por ahora: evita romper tinta; el usuario puede aplanar luego.
      // TODO: rasterizar imagen sobre la inferior si se requiere mezcla real.
      return;
    }
    const idx = this.layerIndex(id);
    let below: SceneLayer | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (this.layers[i].kind === "ink" && this.layers[i].parentId === layer.parentId) {
        below = this.layers[i];
        break;
      }
    }
    if (!below) return;
    for (const it of this.items) if (it.layerId === id) it.layerId = below.id;
    this.layers = this.layers.filter((l) => l.id !== id);
    this.activeLayerId = below.id;
    this.inkRevision++;
  }

  /** Funde toda la tinta en una sola capa. Conserva materia y acuarela: su
   *  contenido no es un item de tinta y no se puede fundir en uno. */
  flatten(): void {
    const ink = this.firstInkLayer();
    if (!ink) return;
    for (const it of this.items) it.layerId = ink.id;
    ink.parentId = null;
    ink.clip = false;
    this.layers = this.layers.filter(
      (l) => l.kind === "matter" || l.kind === "aqua" || l.id === ink.id,
    );
    this.activeLayerId = ink.id;
    this.inkRevision++;
  }

  /**
   * Reubica una capa: la mete en `parentId` (null = raíz) en la posición
   * `index` entre sus hermanas, contando de ABAJO arriba (0 = la más baja).
   *
   * Se razona sobre la lista de hermanas y luego se reconstruye el array
   * entero, en vez de calcular un índice absoluto: el array es plano pero el
   * modelo es un árbol (`parentId`), y mezclar las dos cosas es lo que hacía
   * que soltar una capa junto a un grupo abierto no moviera nada.
   */
  moveLayerTo(id: string, parentId: string | null, index: number): void {
    const layer = this.layerById(id);
    if (!layer) return;
    // Materia y acuarela son planos propios: viven en la raíz, no en grupos.
    if (layer.kind === "matter" || layer.kind === "aqua") parentId = null;
    if (parentId !== null) {
      // Un grupo no puede caer dentro de sí mismo ni de sus descendientes.
      if (this.isDescendantOf(parentId, id)) return;
      // Solo los grupos alojan hijas; cualquier otra capa recibe a su hermana.
      const parent = this.layerById(parentId);
      if (!parent) parentId = null;
      else if (parent.kind !== "group") parentId = parent.parentId;
    }
    const sibs = this.layers.filter((l) => l.parentId === parentId && l.id !== id);
    layer.parentId = parentId;
    sibs.splice(clampIndex(index, sibs.length), 0, layer);
    this.rebuildLayerOrder(parentId, sibs);
    this.inkRevision++;
  }

  /**
   * Reconstruye `layers` en orden canónico: recorrido en profundidad desde la
   * raíz, cada grupo seguido de sus hijas. Solo cambia posiciones ABSOLUTAS
   * —el z lo decide el orden relativo entre hermanas— así que el dibujo no se
   * altera; lo que gana es que las hijas de un grupo quedan contiguas, que es
   * la forma en la que `moveLayerTo` y el compositor esperan encontrarlas.
   *
   * `overrideKids` fija el orden de un nivel concreto (el destino de un
   * movimiento); los demás niveles conservan el orden que ya tenían.
   */
  private rebuildLayerOrder(overrideParent?: string | null, overrideKids?: SceneLayer[]): void {
    const out: SceneLayer[] = [];
    const seen = new Set<string>();
    const kidsOf = (pid: string | null): SceneLayer[] =>
      overrideKids && pid === overrideParent
        ? overrideKids
        : this.layers.filter((l) => l.parentId === pid);
    const walk = (pid: string | null): void => {
      for (const l of kidsOf(pid)) {
        if (seen.has(l.id)) continue; // ciclo o duplicado: no reentrar
        seen.add(l.id);
        out.push(l);
        if (l.kind === "group") walk(l.id);
      }
    };
    walk(null);
    // Huérfanas (padre inexistente o ciclo): se rescatan a la raíz, en su orden.
    for (const l of this.layers) {
      if (seen.has(l.id)) continue;
      l.parentId = null;
      seen.add(l.id);
      out.push(l);
    }
    this.layers = out;
  }

  setActiveLayer(id: string): void {
    if (this.layerById(id)) this.activeLayerId = id;
  }

  setLayer(id: string, patch: Partial<SceneLayer>): void {
    const layer = this.layerById(id);
    if (!layer) return;
    Object.assign(layer, patch);
    this.inkRevision++;
  }

  /** Añade/quita máscara a una capa. */
  toggleMask(id: string, on?: boolean): void {
    const layer = this.layerById(id);
    if (!layer || layer.kind === "matter") return;
    const want = on ?? !layer.mask;
    if (want && !layer.mask) layer.mask = makeMask();
    else if (!want) layer.mask = undefined;
    this.inkRevision++;
  }

  invertMask(id: string): void {
    const layer = this.layerById(id);
    if (!layer?.mask) return;
    layer.mask.inverted = !layer.mask.inverted;
    this.inkRevision++;
  }

  /** Empuja un trazo a la máscara de una capa. */
  addMaskStroke(id: string, item: InkItem): void {
    const layer = this.layerById(id);
    if (!layer) return;
    if (!layer.mask) layer.mask = makeMask();
    item.layerId = id;
    layer.mask.items.push(item);
    this.inkRevision++;
  }

  setLayerColor(id: string, color: LayerColor): void {
    this.setLayer(id, { color });
  }

  /**
   * Capa de tinta donde deben caer los trazos nuevos: la activa si es de tinta;
   * si no (materia o grupo), la primera capa de tinta. Así dibujar nunca asigna
   * un trazo a una capa que el compositor no pinta (la materia lo omitiría y el
   * trazo quedaría invisible). `ensureLayers` garantiza que siempre hay ≥1.
   */
  inkTarget(): SceneLayer {
    const active = this.activeLayer;
    if (active && active.kind === "ink") return active;
    return this.firstInkLayer() as SceneLayer;
  }

  addItem(item: InkItem): InkItem {
    if (!item.layerId) item.layerId = this.inkTarget().id;
    this.items.push(item);
    this.inkRevision++;
    return item;
  }

  removeItem(id: string): void {
    const i = this.items.findIndex((it) => it.id === id);
    if (i >= 0) {
      this.items.splice(i, 1);
      this.inkRevision++;
    }
  }

  clearInk(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.inkRevision++;
  }

  clearMatter(layerId?: string): void {
    if (layerId) this.physics.removeByLayer(layerId);
    else this.physics.clear();
  }

  clearAll(): void {
    this.clearInk();
    this.clearMatter();
  }

  /**
   * Convierte los trazos de una capa de tinta en cuerpos de forma libre.
   *
   * Cada silueta conservada por el item se convierte en UN cuerpo `poly` con el
   * contorno dibujado (no cadenas de cápsulas), con sus transformaciones de
   * simetria congeladas replicadas como cuerpos hermanos y el pivote en el
   * centroide de la forma. Devuelve el numero de cuerpos creados; los items sin
   * geometria valida quedan intactos para no destruir contenido que no se pudo
   * convertir.
   */
  convertInkLayerToMatter(layerId: string, maxBodies = 4096): number {
    const source = this.layerById(layerId);
    if (!source || source.kind !== "ink") return 0;
    const candidates = this.layerItems(layerId).filter((item) => !item.erase);
    if (candidates.length === 0) return 0;

    const target = this.matterTarget();
    let created = 0;
    const converted = new Set<string>();
    for (const item of candidates) {
      if (created >= maxBodies) break;
      const bodies = bodiesForInkItem(item, {
        color: item.color,
        blend: this.field.blend,
        restitution: this.physics.settings.restitution,
        friction: this.physics.settings.friction,
        layerId: target.id,
        maxBodies: maxBodies - created,
      });
      if (bodies.length === 0) continue;
      for (const body of bodies) {
        this.physics.add(body);
        created++;
      }
      converted.add(item.id);
    }
    if (created === 0) return 0;
    this.items = this.items.filter((item) => !converted.has(item.id));
    this.inkRevision++;
    return created;
  }

  /** Crea el item de tinta de un trazo aplicando la simetria vigente. */
  buildItem(
    polys: Polygon[],
    color: string,
    opacity: number,
    smooth: boolean,
    gradient: boolean,
    erase = false,
    extraTransform?: Mat2d,
  ): InkItem | null {
    if (polys.length === 0) return null;
    let base = symmetryTransforms(this.symmetry);
    if (extraTransform) base = base.map((m) => multiply(m, extraTransform));

    let bounds: Rect | null = null;
    for (const poly of polys) {
      if (poly.length < 3) continue;
      const b = polygonBounds(poly);
      for (const m of base) {
        bounds = unionRect(bounds, transformRect(b, m));
      }
    }
    if (!bounds) return null;

    return {
      id: uid(),
      polys,
      transforms: base,
      color,
      opacity,
      smooth,
      gradient,
      erase,
      gy0: bounds.y,
      gy1: bounds.y + bounds.h,
      bounds,
      layerId: "",
    };
  }

  /** Caja de todo lo dibujado, tinta, materia e imágenes. */
  contentBounds(): Rect {
    let r: Rect | null = null;
    for (const item of this.items) r = unionRect(r, item.bounds);
    for (const b of this.physics.bodies) {
      const rad = boundingRadius(b.shape) + b.blend;
      r = unionRect(r, { x: b.pos.x - rad, y: b.pos.y - rad, w: rad * 2, h: rad * 2 });
    }
    for (const l of this.layers) {
      if (l.kind === "image" && l.imageSrc) {
        const w = l.imageW ?? 0;
        const h = l.imageH ?? 0;
        if (w > 0 && h > 0) {
          r = unionRect(r, { x: l.imageX ?? 0, y: l.imageY ?? 0, w, h });
        }
      }
      // La acuarela horneada ocupa sitio en el mundo; el fluido vivo no, porque
      // está anclado al viewport y encuadrar por él movería la cámara sola.
      if (l.kind === "aqua" && l.aquaBaked && l.aquaRect && l.aquaRect.w > 0) {
        r = unionRect(r, l.aquaRect);
      }
    }
    return r ?? { ...EMPTY_RECT };
  }

  snapshot(): SceneSnapshot {
    return {
      items: this.items.slice(),
      layers: this.layers.map(cloneLayer),
      activeLayerId: this.activeLayerId,
      bodies: this.physics.bodies.map(snapshotBody),
      symmetry: normalizeSymmetry(cloneSymmetry(this.symmetry)),
      world: cloneWorld(this.physics.settings),
      field: { ...this.field },
      background: this.meta.background,
    };
  }

  restore(snap: SceneSnapshot): void {
    this.items = snap.items.slice();
    this.layers = snap.layers.map(cloneLayer);
    this.activeLayerId = snap.activeLayerId;
    this.symmetry = normalizeSymmetry(cloneSymmetry(snap.symmetry));
    this.physics.settings = cloneWorld(snap.world);
    this.field = { ...snap.field };
    this.meta.background = snap.background;
    this.physics.clear();
    for (const b of snap.bodies) this.physics.add(restoreBody(b));
    this.ensureLayers();
    this.inkRevision++;
  }
}

/** Índice acotado al rango insertable de una lista (0..length). */
const clampIndex = (i: number, length: number): number =>
  i < 0 ? 0 : i > length ? length : Math.round(i);

/** Caja envolvente de un rect transformado (se transforman las 4 esquinas). */
export function transformRect(r: Rect, m: Mat2d): Rect {
  const xs = [r.x, r.x + r.w, r.x, r.x + r.w];
  const ys = [r.y, r.y, r.y + r.h, r.y + r.h];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const x = m.a * xs[i] + m.c * ys[i] + m.e;
    const y = m.b * xs[i] + m.d * ys[i] + m.f;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
