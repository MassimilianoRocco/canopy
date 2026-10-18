import type { GitFile, TouchedFile, TurnRecord } from '../types'
import type { Strings } from './text'
import type { Tone } from './tree'

// ---- A turn's record ----

// A tool call before any turn.start (the plugin loaded mid-turn) lands here
export const orphan = (): TurnRecord => ({
  id: 'orphan',
  number: 1,
  prompt: '',
  startedAt: 0,
  durationMs: null,
  endReason: null,
  files: [],
  searches: 0,
  commands: 0,
  runs: [],
})

export const withLast = (list: readonly TurnRecord[], change: (turn: TurnRecord) => TurnRecord): TurnRecord[] => [
  ...list.slice(0, -1),
  change(list.at(-1) ?? orphan()),
]

/**
 * Changes turn `id`: the one a call began in, though a new turn started while
 * it ran (a subagent left running). The latest where it is no longer kept.
 */
export const withTurn = (
  list: readonly TurnRecord[],
  id: string,
  change: (turn: TurnRecord) => TurnRecord,
): TurnRecord[] =>
  list.some(turn => turn.id === id) ? list.map(turn => (turn.id === id ? change(turn) : turn)) : withLast(list, change)

export const withFile = (
  turn: TurnRecord,
  seed: Pick<TouchedFile, 'key' | 'path' | 'label'>,
  change: (file: TouchedFile) => TouchedFile,
): TurnRecord => {
  const fresh: TouchedFile = {
    ...seed,
    reads: 0,
    edits: 0,
    isCreated: false,
    running: 0,
    pending: null,
    failures: 0,
  }
  const isKnown = turn.files.some(file => file.key === seed.key)

  return {
    ...turn,
    files: isKnown
      ? turn.files.map(file => (file.key === seed.key ? change(file) : file))
      : [...turn.files, change(fresh)],
  }
}

/** Changed by Claude: a file tool, or a file its shell command wrote. */
export const isClaude = (file: TouchedFile) =>
  file.edits > 0 || file.pending === 'edit' || file.via === 'shell' || (file.isCreated && file.via !== 'outside')

/** Changed during the turn by nothing of Claude's: the person, an editor, a hook. */
export const isOutside = (file: TouchedFile) => file.via === 'outside' && !isClaude(file)

/** A file whose turn diff is kept. */
export const hasDiff = (file: TouchedFile) => isClaude(file) || isOutside(file)

export const isRead = (file: TouchedFile) => !hasDiff(file) && (file.reads > 0 || file.pending === 'read')

/** Nothing happened to it, nothing is under way: a failed read leaves such a row behind. */
export const isBlank = (file: TouchedFile) =>
  file.reads === 0 &&
  file.edits === 0 &&
  file.failures === 0 &&
  file.running === 0 &&
  !file.isCreated &&
  file.via === undefined

/** Shows up in the Changes list: Claude's changes, and its refused edits. */
export const isChange = (file: TouchedFile) => !isRead(file) && !isOutside(file)

export const toneOf = (file: TouchedFile | undefined): Tone => {
  if (file === undefined) return ''
  if (isRead(file)) return 'read'
  if (isOutside(file)) return 'outside'
  if (file.isCreated) return 'created'
  if (isClaude(file)) return 'changed'

  return 'failed'
}

// ---- How a file reads ----

export const durationOf = (ms: number) => {
  const seconds = Math.round(ms / 1000)

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export const turnStatusOf = (s: Strings, turn: TurnRecord) => {
  if (turn.durationMs === null) return s.running
  const took = durationOf(turn.durationMs)
  if (turn.endReason === 'aborted') return s.interrupted(took)
  if (turn.endReason === 'error' || turn.endReason === 'refusal') return s.failedIn(took)

  return s.finishedIn(took)
}

export const statusColorOf = (turn: TurnRecord) => {
  if (turn.durationMs === null) return 'warning'
  if (turn.endReason === 'error' || turn.endReason === 'refusal') return 'error'

  return turn.endReason === 'aborted' ? 'subtle' : 'success'
}

export const badgeOf = (s: Strings, file: TouchedFile) => {
  if (file.running > 0) return s.badgeRunning
  if (isOutside(file)) return s.outsideShort
  if (file.isCreated) {
    return file.edits > 0 ? s.createdThen(file.edits) : file.via === 'shell' ? s.createdByCommand : s.created
  }
  if (file.edits > 0) {
    return (file.edits > 1 ? s.modifiedTimes(file.edits) : s.modified) + (file.via === 'shell' ? s.plusCommand : '')
  }
  if (file.via === 'shell') return s.modifiedByCommand
  if (file.reads > 0) return file.reads > 1 ? s.readTimes(file.reads) : s.read

  return s.failed
}

// Colour says changed or new; words only for what colour can't
export const noteOf = (s: Strings, file: TouchedFile | undefined) => {
  if (file === undefined) return undefined
  if (file.running > 0) return s.badgeRunning
  if (isRead(file)) return badgeOf(s, file)

  return undefined
}

// ---- Colours and letters, as an IDE's tree prints them ----

// Theme keys, so either theme reads: an IDE's blue, green, orange and red
export const TONE_COLOR: Partial<Record<Tone, string>> = {
  changed: 'suggestion',
  created: 'success',
  untracked: 'warning',
  failed: 'error',
}

export const TONE_OF_CODE: Record<GitFile['code'], Tone> = {
  M: 'changed',
  R: 'changed',
  A: 'created',
  '?': 'untracked',
  D: 'deleted',
  U: 'failed',
}

/** What a change's colour says, in a word, where it is more than a modification. */
export const wordOf = (s: Strings, tone: Tone, code?: GitFile['code']): string | undefined => {
  if (code === 'R') return s.stateRenamed
  if (code === 'U') return s.stateConflict
  if (tone === 'created') return s.stateNew
  if (tone === 'untracked') return s.stateUntracked
  if (tone === 'deleted') return s.stateDeleted
  if (tone === 'failed') return s.stateFailed

  return undefined
}

/** A file's lines added and removed, once counted. */
export const countsOf = (file: { added?: number; removed?: number }): [number, number] | undefined =>
  file.added === undefined || file.removed === undefined ? undefined : [file.added, file.removed]

export const isDimTone = (tone: Tone) => tone === 'deleted' || tone === 'outside' || tone === 'heavy'

export const rangesText = (ranges: readonly [number, number][]) =>
  ranges
    .slice(0, 8)
    .map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`))
    .join(', ') + (ranges.length > 8 ? ', …' : '')
