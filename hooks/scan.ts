import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { FileText, GitFile, GitStatus, Snapshot, TouchedFile, TurnRecord } from '../types'
import { clearHeads, headText, readCatalog, readGit, textOf } from './git'
import { hasDiff, isClaude, withFile } from './model'
import { keyOf, labelOf } from './paths'

const history = atom({ plugin: 'canopy', key: 'history' } as const, [])
const git = atom({ plugin: 'canopy', key: 'git' } as const, null)
const root = atom({ plugin: 'canopy', key: 'root' } as const, '')
const catalog = atom({ plugin: 'canopy', key: 'catalog' } as const, null)
const SNAPSHOT = { plugin: 'canopy', key: 'snapshot' } as const

const MAX_SCANNED = 200
// A burst of shell commands is followed by one git scan, this long after the last
const SCAN_DELAY = 400
// A file written this close to one of Claude's commands is that command's
const RUN_LEAD = 250
const RUN_TAIL = 2000

// The project's folder, the tree's root: a shell `cd` moves the cwd, never this
export function rootOf($: EngineInterface) {
  return $.session.root().catch(() => $.session.cwd()).catch(() => '')
}

async function baseOf($: EngineInterface) {
  return (await read($, root)) || (await rootOf($))
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
  const status = await readGit($)
  await update($, git, () => status)
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
  if (start === undefined || start === 'pending' || start === null) {
    return isUnknownToGit ? undefined : { before: await headText($, file.rel), base: 'head', isNew: false }
  }
  const kept = start.texts.get(file.rel)
  if (kept !== undefined) return { before: kept, base: 'turn', isNew: false }
  if (start.dirty.has(file.rel)) {
    return isUnknownToGit ? undefined : { before: await headText($, file.rel), base: 'head', isNew: false }
  }
  // Clean as the turn began: a tracked file was its commit; any other didn't exist
  return isUnknownToGit
    ? { before: { kind: 'missing' }, base: 'turn', isNew: true }
    : { before: await headText($, file.rel), base: 'turn', isNew: false }
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
async function markScanned($: EngineInterface, status: GitStatus) {
  const turn = (await read($, history)).at(-1)
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
    await update($, snapshot, (current): Snapshot =>
      current.before === undefined ? { ...current, before: found.before, base: found.base } : current,
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

  const ended = (await read($, history)).find(one => one.id === turn.id)
  if (ended === undefined || ended.durationMs === null) return
  for (const file of ended.files.filter(one => one.via !== undefined && hasDiff(one))) {
    const snapshot = atom({ ...SNAPSHOT, id: `${ended.id}|${file.key}` }, {})
    if ((await read($, snapshot)).after === undefined) {
      const after = await textOf($, file.path)
      await update($, snapshot, current => ({ ...current, after }))
    }
  }
}

// ---- The catalogue the search reads, and what git ignores ----

let isCataloguing = false

/** Lists the project again, off every path; a list already under way is not doubled. */
export function refreshCatalog($: EngineInterface, status: GitStatus | null) {
  if (isCataloguing) return
  isCataloguing = true
  $.clock.after(0, () => {
    void (async () => {
      const base = await baseOf($)
      if (base === '') return
      const found = await readCatalog($, base, status)
      const at = await $.clock.now()
      await update($, catalog, () => ({ at, ...found }))
    })()
      .catch(() => undefined)
      .then(() => {
        isCataloguing = false
      })
  })
}

// ---- Work kept off the tool path ----
// A command's result goes back to the model at once; git is asked by a timer
// a moment later, once per burst of commands, and a new turn waits for a scan
// only if one is still pending

let scanTimer: Timer | undefined
let scanJob: Promise<void> | undefined

export const isScanning = () => scanTimer !== undefined || scanJob !== undefined

export async function runScan($: EngineInterface) {
  clearHeads()
  const status = await readGit($)
  await update($, git, () => status)
  if (status !== null) await markScanned($, status)
  refreshCatalog($, status)
}

export function scheduleScan($: EngineInterface, ms = SCAN_DELAY) {
  scanTimer?.cancel()
  scanTimer = $.clock.after(ms, () => {
    scanTimer = undefined
    const job = runScan($).catch(() => undefined)
    scanJob = job
    void job.then(() => {
      if (scanJob === job) scanJob = undefined
    })
  })
}

export async function settleScan($: EngineInterface) {
  if (scanTimer !== undefined) {
    scanTimer.cancel()
    scanTimer = undefined
    await runScan($).catch(() => undefined)
  }
  await scanJob
}

export const stopScans = () => {
  scanTimer?.cancel()
  scanTimer = undefined
}
