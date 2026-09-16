import type { SceneDocument, SceneSnapshot } from "../scene/document";

export interface HistoryEntry {
  label: string;
  snapshot: SceneSnapshot;
}

export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  size: number;
}

/**
 * Historial por instantaneas.
 *
 * Webchemy guardaba 10 pasos volcando el bitmap entero. Aqui una instantanea
 * es la lista de items (compartidos por referencia, nunca mutados) mas un
 * snapshot plano de los cuerpos: cuesta kilobytes, no megabytes, asi que se
 * pueden guardar 80 pasos y ademas deshacer movimientos de materia y cambios
 * de simetria, no solo trazos.
 */
export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private pending: SceneSnapshot | null = null;
  private limit: number;

  constructor(private doc: SceneDocument, limit = 80) {
    this.limit = limit;
  }

  get status(): HistoryStatus {
    return {
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      undoLabel: this.past.length > 0 ? this.past[this.past.length - 1].label : null,
      redoLabel: this.future.length > 0 ? this.future[this.future.length - 1].label : null,
      size: this.past.length,
    };
  }

  /**
   * Fotografia el estado ANTES de una accion.
   *
   * Se llama al empezar el gesto (bajar el lapiz, agarrar un cuerpo) y se
   * confirma con `commit` al soltar. Si el gesto se cancela, `abort` lo
   * descarta sin ensuciar el historial.
   */
  begin(): void {
    this.pending = this.doc.snapshot();
  }

  commit(label: string): void {
    const snapshot = this.pending ?? this.doc.snapshot();
    this.pending = null;
    this.push(label, snapshot);
  }

  abort(): void {
    this.pending = null;
  }

  /** Registra un cambio instantaneo (un boton, no un gesto). */
  record(label: string, before?: SceneSnapshot): void {
    this.push(label, before ?? this.doc.snapshot());
  }

  private push(label: string, snapshot: SceneSnapshot): void {
    this.past.push({ label, snapshot });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  undo(): string | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, snapshot: this.doc.snapshot() });
    this.doc.restore(entry.snapshot);
    return entry.label;
  }

  redo(): string | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, snapshot: this.doc.snapshot() });
    this.doc.restore(entry.snapshot);
    return entry.label;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.pending = null;
  }
}
