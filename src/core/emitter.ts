/** Emisor de eventos tipado y minimalista (sin dependencias). */

export type Listener<T> = (value: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(key: K, fn: Listener<Events[K]>): () => void {
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(key, fn);
  }

  off<K extends keyof Events>(key: K, fn: Listener<Events[K]>): void {
    this.map.get(key)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(key: K, value: Events[K]): void {
    const set = this.map.get(key);
    if (!set) return;
    for (const fn of [...set]) (fn as Listener<Events[K]>)(value);
  }

  clear(): void {
    this.map.clear();
  }
}
