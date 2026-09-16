/**
 * Undo/redo.
 *
 * Commands rather than snapshots. A document is mostly typed arrays, and
 * snapshotting them on every stroke would copy megabytes per second; a command
 * only carries what actually changed, so history stays cheap even after an hour
 * of drawing.
 */

export interface Command {
  label: string
  undo(): void
  redo(): void
}

export class History {
  private readonly past: Command[] = []
  private readonly future: Command[] = []
  private readonly limit: number
  private listeners = new Set<() => void>()
  /** Suppresses recording while a command is being applied. */
  private applying = false

  constructor(limit = 200) {
    this.limit = limit
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get undoLabel(): string | null {
    return this.past.length > 0 ? this.past[this.past.length - 1].label : null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** Records a command that has already been applied. */
  push(command: Command): void {
    if (this.applying) return
    this.past.push(command)
    if (this.past.length > this.limit) this.past.shift()
    this.future.length = 0
    this.notify()
  }

  /** Applies a command and records it. */
  run(command: Command): void {
    command.redo()
    this.push(command)
  }

  undo(): boolean {
    const command = this.past.pop()
    if (!command) return false
    this.applying = true
    try {
      command.undo()
    } finally {
      this.applying = false
    }
    this.future.push(command)
    this.notify()
    return true
  }

  redo(): boolean {
    const command = this.future.pop()
    if (!command) return false
    this.applying = true
    try {
      command.redo()
    } finally {
      this.applying = false
    }
    this.past.push(command)
    this.notify()
    return true
  }

  clear(): void {
    this.past.length = 0
    this.future.length = 0
    this.notify()
  }
}
