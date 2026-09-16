/** Monotonic ids. Short, sortable, and stable inside a single document. */

let counter = 0

export type Id = string

export const makeId = (prefix = 'o'): Id => {
  counter += 1
  return `${prefix}_${counter.toString(36)}_${Math.floor(Math.random() * 0xffff).toString(36)}`
}

/** Restores the counter after loading a document so new ids never collide. */
export const seedIdCounter = (value: number): void => {
  counter = Math.max(counter, value)
}
