import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { FileText, GitFile, GitStatus, Snapshot, TouchedFile, TurnRecord } from '../types'
import { changesOf, diffLines, linesOf } from './diff'
import { clearHeads, headText, readCatalog, readGit, rootOf, textOf } from './git'
import { forgetListings } from './listing'
import { hasDiff, isClaude, withFile } from './model'
import { keyOf, labelOf } from './paths'

const history = atom({ plugin: 'canopy', key: 'history' } as const, [])
const git = atom({ plugin: 'canopy', key: 'git' } as const, null)
const mode = atom({ plugin: 'canopy', key: 'mode' } as const, 'turn')
const root = atom({ plugin: 'canopy', key: 'root' } as const, '')
const catalog = atom({ plugin: 'canopy', key: 'catalog' } as const, null)
const SNAPSHOT = { plugin: 'canopy', key: 'snapshot' } as const

const MAX_SCANNED = 200
// A burst of shell commands is followed by one git scan, this long after the last
const SCAN_DELAY = 400
// A file written this close to one of Claude's commands is that command's
const RUN_LEAD = 250
const RUN_TAIL = 2000

async function baseOf($: EngineInterface) {
  return (await read($, root)) || (await rootOf($))
}

// ---- What the kept texts weigh ----
// Each changed file's text as a turn found it and as it left it, for its
// diff: a megabyte each at most, for every turn kept. Past these sizes, in
// characters, a text is kept as too large to show, its row listed all the same

const MAX_TURN_TEXT = 6_000_000
const MAX_KEPT_TEXT = 24_000_000
const weights = new Map<string, number>()

/** `text` as turn `turnId` keeps it: whole while the turn, and all the turns, have room for it. */
export function keepText(turnId: string, text: FileText): FileText {
  if (text.kind !== 'text') return text
  const turn = weights.get(turnId) ?? 0
  let all = 0
  for (const one of weights.values()) all += one
  if (turn + text.text.length > MAX_TURN_TEXT || all + text.text.length > MAX_KEPT_TEXT) return { kind: 'too-large' }
  weights.set(turnId, turn + text.text.length)

  return text
}

/** Gives back the room these turns' texts took: they left the history. */
export const releaseTexts = (turnIds: readonly string[]) => {
  for (const id of turnIds) weights.delete(id)
}

// ---- What a turn found as it began ----
// A command changes a file no tool read first. A clean tracked file was its
// last commit; for the others (already changed, unknown to git) the texts are
// kept as the turn starts, off the path and within bounds, so such a change
// diffs against the turn too, and a file that didn't exist then reads as new
// rather than guessed

/** The files git saw changed as a turn began, and the texts of those kept. */
type Start = { dirty: Set<string>; texts: Map<string, FileText> } | null

const MAX_START_FILES = 100
const MAX_START_BYTES = 200_000
const MAX_START_TOTAL = 2_000_000

// By turn id; `pending` until the capture ran. Kept for the last two turns
const starts = new Map<string, Start | 'pending'>()

async function readStart($: EngineInterface): Promise<Start> {
  // It replaces the status the commit view draws: with its counts there
  const status = await readGit($, (await read($, mode)) === 'commit')
  await keepStatus($, status)
  if (status === null) return null

  const dirty = new Set(status.files.filter(file => file.code !== 'D').map(file => file.rel))
  const texts = new Map<string, FileText>()
  let total = 0
  for (const rel of [...dirty].slice(0, MAX_START_FILES)) {
    const path = `${status.top}/${rel}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind !== 'file' || stat.size > MAX_START_BYTES || total + stat.size > MAX_START_TOTAL) continue
    const text = await textOf($, path)
    if (text.kind !== 'text') continue
    texts.set(rel, text)
    total += stat.size
  }

  return { dirty, texts }
}

/** Reads what the files were as the turn began, on a timer: never on the prompt's path. */
export function captureStart($: EngineInterface, turnId: string) {
  starts.set(turnId, 'pending')
  for (const old of [...starts.keys()].slice(0, -2)) starts.delete(old)
  $.clock.after(0, () => {
    void readStart($)
      .catch((): Start => null)
      .then(start => {
        if (starts.get(turnId) === 'pending') starts.set(turnId, start)
      })
  })
}

// What a file changed with no file tool was as the turn began, and against
// what its diff then reads. Undefined: nobody can say (unknown to git, and
// not kept); the file view then shows it plain rather than all green
async function startOf(
  $: EngineInterface,
  turnId: string,
  file: GitFile,
): Promise<{ before: FileText; base: 'turn' | 'head'; isNew: boolean } | undefined> {
  const start = starts.get(turnId)
  const isUnknownToGit = file.code === '?' || file.code === 'A'
  // A rename's last commit is under its old path
  const committed = file.from ?? file.rel
  if (start === undefined || start === 'pending' || start === null) {
    return isUnknownToGit ? undefined : { before: await headText($, committed), base: 'head', isNew: false }
  }
  const kept = start.texts.get(file.rel)
  if (kept !== undefined) return { before: kept, base: 'turn', isNew: false }
  if (start.dirty.has(file.rel)) {
    return isUnknownToGit ? undefined : { before: await headText($, committed), base: 'head', isNew: false }
  }
  // Clean as the turn began: a tracked file was its commit; any other didn't exist
  return isUnknownToGit
    ? { before: { kind: 'missing' }, base: 'turn', isNew: true }
    : { before: await headText($, committed), base: 'turn', isNew: false }
}

// Written while one of the turn's commands ran (one still running counts to now)
const isByCommand = (turn: TurnRecord, mtime: number, now: number) =>
  turn.runs.some(([from, to]) => mtime >= from - RUN_LEAD && mtime <= (to < 0 ? now : to) + RUN_TAIL)

/**
 * Marks the files git sees changed since the latest turn began and no file
 * tool changed: Claude's own when written while one of its commands ran,
 * `outside` otherwise. Keeps what each was as the turn began, and once the
 * turn has ended, what it left.
 */
async function markScanned($: EngineInterface, status: GitStatus, turnId: string) {
  const turn = (await read($, history)).find(one => one.id === turnId)
  if (turn === undefined || turn.id === 'orphan') return
  const known = new Map(turn.files.map(file => [file.key, file]))
  const now = await $.clock.now()

  const fresh: { path: string; file: GitFile; via: 'shell' | 'outside' }[] = []
  for (const file of status.files.slice(0, MAX_SCANNED)) {
    if (file.code === 'D') continue
    const path = `${status.top}/${file.rel}`
    const record = known.get(keyOf(path))
    if (record !== undefined && isClaude(record)) continue
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind !== 'file' || stat.mtimeMs < turn.startedAt) continue
    const via = isByCommand(turn, stat.mtimeMs, now) ? 'shell' : 'outside'
    // Seen already, and nothing new to say about it
    if (record?.via === via) continue
    fresh.push({ path, file, via })
  }

  const created = new Set<string>()
  for (const { path, file } of fresh) {
    const snapshot = atom({ ...SNAPSHOT, id: `${turn.id}|${keyOf(path)}` }, {})
    if ((await read($, snapshot)).before !== undefined) continue
    const found = await startOf($, turn.id, file)
    if (found === undefined) continue
    if (found.isNew) created.add(keyOf(path))
    const before = keepText(turn.id, found.before)
    await update($, snapshot, (current): Snapshot =>
      current.before === undefined ? { ...current, before, base: found.base } : current,
    )
  }
  if (fresh.length > 0) {
    const base = await baseOf($)
    await update($, history, list =>
      list.map(one =>
        one.id !== turn.id
          ? one
          : fresh.reduce(
              (acc, { path, via }) =>
                withFile(acc, { key: keyOf(path), path, label: labelOf(path, base) }, (file): TouchedFile => ({
                  ...file,
                  via,
                  isCreated: file.isCreated || created.has(keyOf(path)),
                })),
              one,
            ),
      ),
    )
  }

  const turns = await read($, history)
  const ended = turns.find(one => one.id === turn.id)
  if (ended === undefined) return
  const changed = ended.files.filter(one => one.via !== undefined && hasDiff(one))
  // A turn begun while this scan ran (see settleScan) may have changed a file already
  const later = turns.at(-1)?.id === ended.id ? undefined : turns.at(-1)
  if (ended.durationMs !== null) {
    for (const file of changed) {
      const snapshot = atom({ ...SNAPSHOT, id: `${ended.id}|${file.key}` }, {})
      if ((await read($, snapshot)).after === undefined) {
        // What the later turn found is what this one left; else the file now
        const found =
          later === undefined ? undefined : (await read($, atom({ ...SNAPSHOT, id: `${later.id}|${file.key}` }, {}))).before
        const after = keepText(ended.id, found ?? (await textOf($, file.path)))
        await update($, snapshot, current => ({ ...current, after }))
      }
    }
  }
  // A command may have written a file again since it was first seen: counted afresh if so
  for (const file of changed) countLater($, ended.id, file.key, false)
}

// ---- Each changed file's lines added and removed ----
// Counted from the texts its diff is drawn from, a moment after the change and
// off every path; one count at a time, so an older one never lands last

const COUNT_DELAY = 300
// By turn, the files to count, and whether each must be read again whatever its time says
const due = new Map<string, Map<string, boolean>>()
let countTimer: Timer | undefined
let counting: Promise<void> = Promise.resolve()
// What each count was taken from (`<turn>|<file>` → the file's time and size,
// or the turn's end): a scan asks again for every file a command changed, and
// one nothing touched since isn't read and diffed again
const countedFrom = new Map<string, string>()
const MAX_COUNTED = 2000

const textOr = (text: FileText) => (text.kind === 'text' ? text.text : '')

/**
 * Counts the lines `key` added and removed in turn `turnId`, soon. A scan
 * asks with `isForced` false: a file whose time and size are those of its
 * last count is left as counted.
 */
export function countLater($: EngineInterface, turnId: string, key: string, isForced = true) {
  const keys = due.get(turnId) ?? new Map<string, boolean>()
  keys.set(key, isForced || keys.get(key) === true)
  due.set(turnId, keys)
  if (countTimer !== undefined) return
  countTimer = $.clock.after(COUNT_DELAY, () => {
    countTimer = undefined
    counting = counting.then(() => countDue($)).catch(() => undefined)
  })
}

async function countDue($: EngineInterface) {
  const batch = [...due]
  due.clear()
  for (const [turnId, keys] of batch) {
    const turn = (await read($, history)).find(one => one.id === turnId)
    if (turn === undefined) continue
    const counted = new Map<string, { added: number; removed: number }>()
    for (const file of turn.files.filter(one => keys.has(one.key) && hasDiff(one))) {
      const id = `${turnId}|${file.key}`
      const snapshot = await read($, atom({ ...SNAPSHOT, id }, {}))
      const before = snapshot.before
      // Nothing to count against: the file isn't read at all
      if (before === undefined || before.kind === 'too-large') continue
      // As the file view draws it: the text the turn left, else the file now
      const isLeft = snapshot.after !== undefined && turn.durationMs !== null
      const stat = isLeft ? undefined : await $.fs.stat(file.path).catch(() => undefined)
      const from = `${before.kind}|${isLeft ? 'left' : `${stat?.mtimeMs ?? -1}:${stat?.size ?? -1}`}`
      // Left as it was counted, or as it was found to be no text: not read again
      const last = countedFrom.get(id)
      const isSettled = last === `${from}|none` || (last === from && file.added !== undefined)
      if (keys.get(file.key) === false && isSettled) continue
      const after = isLeft ? snapshot.after! : await textOf($, file.path)
      if (countedFrom.size >= MAX_COUNTED) countedFrom.clear()
      if (after.kind === 'too-large') {
        countedFrom.set(id, `${from}|none`)
        continue
      }
      const { added, removed } = changesOf(diffLines(linesOf(textOr(before)), linesOf(textOr(after))))
      counted.set(file.key, { added, removed })
      countedFrom.set(id, from)
    }
    if (counted.size === 0) continue
    await update($, history, list =>
      list.map(one =>
        one.id !== turnId
          ? one
          : { ...one, files: one.files.map(file => ({ ...file, ...counted.get(file.key) })) },
      ),
    )
  }
}

// ---- The catalogue the search reads, and what git ignores ----

let isCataloguing = false

const isSameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((one, at) => one === b[at])

/** Lists the project again, off every path; a list already under way is not doubled (false). */
export function refreshCatalog($: EngineInterface, status: GitStatus | null) {
  if (isCataloguing) return false
  isCataloguing = true
  $.clock.after(0, () => {
    void (async () => {
      const base = await baseOf($)
      if (base === '') return
      const { isSameIndex, ...found } = await readCatalog($, base, status)
      // The same list: nothing to draw again
      const was = await read($, catalog)
      const isSame =
        isSameIndex &&
        was !== null &&
        was.top === found.top &&
        was.count === found.count &&
        was.isCut === found.isCut &&
        isSameList(was.ignored, found.ignored)
      if (isSame) return
      const at = await $.clock.now()
      await update($, catalog, () => ({ at, ...found }))
    })()
      .catch(() => undefined)
      .then(() => {
        isCataloguing = false
      })
  })

  return true
}

// ---- Work kept off the tool path ----
// A command's result goes back to the model at once; git is asked by a timer
// a moment later, once per burst of commands, and a new turn waits for a scan
// only if one is still pending

let scanTimer: Timer | undefined
let scanJob: Promise<void> | undefined
// Whether git answered once since the module loaded: outside a repository the
// status stays null, and a drawing that asked again on every null would loop
let hasAnswered = false

export const isScanning = () => scanTimer !== undefined || scanJob !== undefined

export const hasScanned = () => hasAnswered

/** The same files in the same states: a status that redraws nothing. */
const isSameStatus = (a: GitStatus | null, b: GitStatus | null) =>
  a === null || b === null ? a === b : a.top === b.top && JSON.stringify(a.files) === JSON.stringify(b.files)

/** Keeps `status` as git's last answer, unless it says what the one kept says. */
async function keepStatus($: EngineInterface, status: GitStatus | null) {
  if (!isSameStatus(await read($, git), status)) await update($, git, () => status)
}

// What the catalogue follows in a status: the files that came, went or moved,
// not the ones only modified. A scan after each burst of commands lists the
// project again only when they changed, or when the list is this old (an
// ignore rule edited, a folder made that git ignores)
const CATALOG_STALE = 60_000
let catalogued: { shape: string; at: number } | undefined
// The shape the last scan found: a new one means files came or went, and the tree lists its folders again
let lastShape: string | undefined

const shapeOf = (status: GitStatus | null) =>
  status === null
    ? ''
    : [status.top, ...status.files.filter(file => file.code !== 'M').map(file => `${file.code}${file.rel}`)].join('\0')

/**
 * Asks git again and marks what it found. The counts since the last commit
 * only where they are drawn, and never on the prompt's path (`withCounts`
 * false): one git call fewer.
 */
export async function runScan($: EngineInterface, withCounts?: boolean) {
  clearHeads()
  // The turn it marks, taken before git is asked: a new one may begin while it runs
  const turnId = (await read($, history)).at(-1)?.id
  const status = await readGit($, withCounts ?? (await read($, mode)) === 'commit')
  hasAnswered = true
  await keepStatus($, status)
  if (status !== null && turnId !== undefined) await markScanned($, status, turnId)
  const shape = shapeOf(status)
  if (lastShape !== undefined && lastShape !== shape) forgetListings()
  lastShape = shape
  const now = await $.clock.now()
  const isDue = catalogued === undefined || catalogued.shape !== shape || now - catalogued.at >= CATALOG_STALE
  // A list already under way may predate this status: the next scan asks again
  if (isDue && refreshCatalog($, status)) catalogued = { shape, at: now }
}

function startScan($: EngineInterface, withCounts?: boolean) {
  const job = runScan($, withCounts).catch(() => undefined)
  scanJob = job
  void job.then(() => {
    if (scanJob === job) scanJob = undefined
  })

  return job
}

export function scheduleScan($: EngineInterface, ms = SCAN_DELAY) {
  scanTimer?.cancel()
  scanTimer = $.clock.after(ms, () => {
    scanTimer = undefined
    startScan($)
  })
}

// How long a new turn waits for a scan under way. A command that rewrote
// hundreds of files is a scan of seconds: past this it goes on beside the new
// turn, marking the turn it began for, and the prompt is never held for it
const SETTLE_MAX = 2000

/** Lets a scan pending or under way mark the last turn before a new one begins, within SETTLE_MAX. */
export async function settleScan($: EngineInterface) {
  if (scanTimer !== undefined) {
    scanTimer.cancel()
    scanTimer = undefined
    // The turn's attribution needs the status alone; the counts follow off the path
    startScan($, false)
  }
  const job = scanJob
  if (job === undefined) return
  const done = new AbortController()
  await Promise.race([
    job.then(() => done.abort()),
    $.clock.sleep(SETTLE_MAX, { signal: done.signal }).catch(() => undefined),
  ])
  done.abort()
}

export const stopScans = () => {
  scanTimer?.cancel()
  scanTimer = undefined
  countTimer?.cancel()
  countTimer = undefined
  due.clear()
}
