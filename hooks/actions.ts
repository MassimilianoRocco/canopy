import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { OpenedFile } from '../types'

const toggled = atom({ plugin: 'canopy', key: 'toggled' } as const, {})
const opened = atom({ plugin: 'canopy', key: 'opened' } as const, null)
const query = atom({ plugin: 'canopy', key: 'query' } as const, '')
const shown = atom({ plugin: 'canopy', key: 'shown' } as const, null)
const turnsOpen = atom({ plugin: 'canopy', key: 'isTurnsOpen' } as const, false)

export const PANE = 'canopy'

/** What a row of the desktop's list does when clicked. */
export type Target =
  | { kind: 'dir'; key: string; isOpen: boolean }
  | { kind: 'file'; key: string; path: string; label: string }
  // A folder the search found: shown open in the tree, its parents too
  | { kind: 'reveal'; keys: string[] }
  // A turn picked from the list of turns: its id, or null for the latest, which follows new ones
  | { kind: 'turn'; id: string | null }

// What each drawing showed, by generation: a click lands on the row the
// person saw, even when a tool call redrew the pane in between
// A click on a drawing older than these is dropped: kept generous, since
// counts and scans redraw the pane while a turn runs
const DRAWN_KEEP = 32
const drawn = new Map<number, (Target | null)[]>()
let generation = 0

/** Keeps what each row of a new drawing does, and names the drawing. */
export function remember(targets: (Target | null)[]) {
  generation += 1
  drawn.set(generation, targets)
  drawn.delete(generation - DRAWN_KEEP)

  return generation
}

// The surfaces where the list of coloured rows failed, and why as the surface said it:
// the engine draws the pane again at once, and there the list is Buttons, as on a terminal
const faults = new Map<string, string>()

export const noteFault = (surface: string, reason: string) => {
  faults.set(surface, reason)
}

/** Why the coloured list failed on `surface`; undefined while it never did. */
export const faultOn = (surface: string) => faults.get(surface)

// The file opened last: its row stays tinted, as an editor's selection does
let selectedKey: string | undefined

export const selected = () => selectedKey

export async function openFile($: EngineInterface, target: OpenedFile | null) {
  if (target !== null) selectedKey = target.key
  await update($, opened, () => target)
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

/** Opens a folder the search found in the tree, its parents with it, and leaves the search. */
export async function reveal($: EngineInterface, keys: readonly string[]) {
  await update($, toggled, current => ({ ...current, ...Object.fromEntries(keys.map(key => [key, true])) }))
  await update($, query, () => '')
}

/** Opens the list of turns in place of the lists, or closes it: a file open closes with it. */
export async function toggleTurns($: EngineInterface) {
  await update($, opened, () => null)
  await update($, turnsOpen, isOpen => !isOpen)
}

/** Shows turn `id` (null: the latest, following new ones) and closes the list of turns. */
export async function pickTurn($: EngineInterface, id: string | null) {
  await update($, shown, () => id)
  await update($, turnsOpen, () => false)
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

/** Does what a click on row `row` of drawing `gen` asks; false when it named nothing. */
export async function actOn($: EngineInterface, gen: number, row: number) {
  const target = drawn.get(gen)?.[row]
  if (target === undefined || target === null) return false
  if (target.kind === 'dir') await update($, toggled, current => ({ ...current, [target.key]: !target.isOpen }))
  else if (target.kind === 'reveal') await reveal($, target.keys)
  else if (target.kind === 'turn') await pickTurn($, target.id)
  else await openFile($, { key: target.key, path: target.path, label: target.label })

  return true
}
