import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { FileText, Lang, Mode, OpenedFile, Snapshot, TurnRecord } from '../types'
import { changesOf, clipHunk, diffLines, hunksOf, linesOf, unifiedSource } from './diff'
import type { DiffLine, Hunk } from './diff'
import { compareIn, currentEditor, openIn, writeSide } from './editor'
import { BADGE_MIN_COLUMNS, fileBadgeOf } from './filetype'
import type { Launch } from './editor'
import { HEAVY, HIDDEN, headOf, indexOf, rootOf, textOf } from './git'
import {
  TONE_COLOR,
  TONE_OF_CODE,
  badgeOf,
  countsOf,
  hasDiff,
  isDimTone,
  isRead,
  noteOf,
  rangesText,
  statusColorOf,
  toneOf,
  turnStatusOf,
  wordOf,
} from './model'
import { isUnder, joinPath, keyOf, labelOf, splitLabel, tidy } from './paths'
import { hasScanned, isScanning, refreshCatalog, runScan, scheduleScan } from './scan'
import { STRINGS } from './text'
import type { Tone, TreeRow } from './tree'

const history = atom({ plugin: 'canopy', key: 'history' } as const, [])
const shown = atom({ plugin: 'canopy', key: 'shown' } as const, null)
const root = atom({ plugin: 'canopy', key: 'root' } as const, '')
const toggled = atom({ plugin: 'canopy', key: 'toggled' } as const, {})
const opened = atom({ plugin: 'canopy', key: 'opened' } as const, null)
const mode = atom({ plugin: 'canopy', key: 'mode' } as const, 'turn')
const diffView = atom({ plugin: 'canopy', key: 'diffView' } as const, 'full')
const git = atom({ plugin: 'canopy', key: 'git' } as const, null)
const query = atom({ plugin: 'canopy', key: 'query' } as const, '')
const lang = atom({ plugin: 'canopy', key: 'lang' } as const, 'en')
const catalog = atom({ plugin: 'canopy', key: 'catalog' } as const, null)
const editor = atom({ plugin: 'canopy', key: 'editor' } as const, null)
const SNAPSHOT = { plugin: 'canopy', key: 'snapshot' } as const

export const PANE = 'canopy'

const MAX_ENTRIES = 300
const MAX_ROWS = 800
const MAX_CHANGES = 40
const MAX_MATCHES = 150
const MAX_PROPS = 90_000
// The code one file view draws: the engine draws a tree's first 100,000
// characters of text, and a Code it cuts loses its colours. Each block of
// changes costs its label and its editor button besides its code
const MAX_CODE = 90_000
const HUNK_LABEL = 40

// The sections' folds, kept with the folders' own: Changes and the project
// open, Other changes and Outside the project closed
const CHANGES = 'section:changes'
const OTHERS = 'section:others'
const ELSEWHERE = 'section:elsewhere'
const PROJECT = 'section:project'

/** One entry of a section's list, whichever mode drew it. */
type Change = {
  key: string
  path: string
  label: string
  tone: Tone
  /** What its colour says, where it is more than a modification: `new`, `deleted`. */
  word?: string
  /** Its lines added and removed, once counted. */
  counts?: [number, number]
}

/** What a row of the desktop's list does when clicked. */
type Target =
  | { kind: 'dir'; key: string; isOpen: boolean }
  | { kind: 'file'; key: string; path: string; label: string }
  // A folder the search found: shown open in the tree, its parents too
  | { kind: 'reveal'; keys: string[] }

type Row = {
  key: string
  path: string
  name: string
  depth: number
  kind: 'dir' | 'file' | 'more'
  isOpen: boolean
  isDim: boolean
}

// ---- The desktop's list: a Client of coloured rows (see tree.tsx) ----

// What each drawing showed, by generation: a click lands on the row the
// person saw, even when a tool call redrew the pane in between
// A click on a drawing older than these is dropped: kept generous, since
// counts and scans redraw the pane while a turn runs
const DRAWN_KEEP = 32
const drawn = new Map<number, (Target | null)[]>()
let generation = 0

// The file opened last: its row stays tinted, as an editor's selection does
let selectedKey: string | undefined

export async function openFile($: EngineInterface, target: OpenedFile | null) {
  if (target !== null) selectedKey = target.key
  await update($, opened, () => target)
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

async function reveal($: EngineInterface, keys: readonly string[]) {
  await update($, toggled, current => ({ ...current, ...Object.fromEntries(keys.map(key => [key, true])) }))
  await update($, query, () => '')
}

/** Does what a click on row `row` of drawing `gen` asks; false when it named nothing. */
export async function actOn($: EngineInterface, gen: number, row: number) {
  const target = drawn.get(gen)?.[row]
  if (target === undefined || target === null) return false
  if (target.kind === 'dir') await update($, toggled, current => ({ ...current, [target.key]: !target.isOpen }))
  else if (target.kind === 'reveal') await reveal($, target.keys)
  else await openFile($, { key: target.key, path: target.path, label: target.label })

  return true
}

// The last diff drawn, so a redraw of the same texts does not walk it again
let lastDiff: { before: string; after: string; lines: DiffLine[] } | undefined

const diffOf = (before: string, after: string) => {
  if (lastDiff?.before !== before || lastDiff.after !== after) {
    lastDiff = { before, after, lines: diffLines(linesOf(before), linesOf(after)) }
  }

  return lastDiff.lines
}

// ---- The search ----

type Match = { rel: string; at: number }

/**
 * The files whose path holds every word of `text`, best first: the name
 * holding them all, then the shorter path. `at` marks the first word in the
 * name, where it is there.
 */
const search = (files: readonly string[], text: string): Match[] => {
  const words = text.toLowerCase().replace(/\\/g, '/').split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return []
  const found: (Match & { score: number })[] = []
  for (const rel of files) {
    const low = rel.toLowerCase()
    if (!words.every(word => low.includes(word))) continue
    const name = low.slice(low.lastIndexOf('/') + 1)
    const inName = words.every(word => name.includes(word))
    found.push({ rel, at: name.indexOf(words[0]!), score: (inName ? 0 : 1_000_000) + rel.length })
  }

  return found.sort((a, b) => a.score - b.score || (a.rel < b.rel ? -1 : 1))
}

type Found = { kind: 'dir'; name: string; rel: string; keys: string[]; depth: number } | { kind: 'file'; name: string; rel: string; depth: number; at: number }

/**
 * The matches as a small tree, folders first, a folder holding only one
 * folder merged into it (`src/app/core`) as an IDE's compact folders are.
 */
const treeOf = (matches: readonly Match[], baseKey: string): Found[] => {
  type Node = { dirs: Map<string, Node>; files: Match[]; name: string; rel: string }
  const top: Node = { dirs: new Map(), files: [], name: '', rel: '' }
  for (const match of matches) {
    const parts = match.rel.split('/')
    let node = top
    for (const part of parts.slice(0, -1)) {
      const rel = node.rel === '' ? part : `${node.rel}/${part}`
      let next = node.dirs.get(part)
      if (next === undefined) {
        next = { dirs: new Map(), files: [], name: part, rel }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(match)
  }

  const rows: Found[] = []
  const emit = (node: Node, depth: number, opens: string[]) => {
    const byName = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)
    for (const name of [...node.dirs.keys()].sort(byName)) {
      let dir = node.dirs.get(name)!
      let label = dir.name
      const keys = [...opens, keyOf(`${baseKey}/${dir.rel}`)]
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        dir = [...dir.dirs.values()][0]!
        label = `${label}/${dir.name}`
        keys.push(keyOf(`${baseKey}/${dir.rel}`))
      }
      rows.push({ kind: 'dir', name: label, rel: dir.rel, keys, depth })
      emit(dir, depth + 1, keys)
    }
    for (const match of [...node.files].sort((a, b) => byName(a.rel, b.rel))) {
      rows.push({ kind: 'file', name: match.rel.slice(match.rel.lastIndexOf('/') + 1), rel: match.rel, depth, at: match.at })
    }
  }
  emit(top, 0, [])

  return rows
}

// ---- The pane ----

/** Draws the pane: `fixed` is the language the options name, else the one detected. */
export async function renderPane(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  fixed: Lang | undefined,
) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Code } = elements
  // A desktop draws Buttons as native controls, which drop the colour of
  // their label: there the clickable list is a Client of coloured rows
  const Client = e.surface === 'desktop' && 'Client' in elements ? elements.Client : undefined
  const Input = 'Input' in elements ? elements.Input : undefined

  const s = STRINGS[fixed ?? (await read($, lang))]
  const list = await read($, history)
  const wanted = await read($, shown)
  const found = list.findIndex(turn => turn.id === wanted)
  const index = found === -1 ? list.length - 1 : found
  const turn: TurnRecord | undefined = list[index]
  const file = await read($, opened)
  const how: Mode = await read($, mode)
  const status = await read($, git)
  const base = (await read($, root)) || (await rootOf($))
  const touched = new Map((turn?.files ?? []).map(one => [one.key, one]))
  const editorName = await read($, editor)
  const ide = editorName === null ? undefined : currentEditor()

  // The commit view before any scan: git asked once, off this drawing. Once only:
  // outside a repository its answer stays null, and asking on every null would loop
  if (how === 'commit' && status === null && !hasScanned() && !isScanning()) scheduleScan($, 0)

  // ---- What the colours say: the turn's changes, or git's ----
  const baseKey = keyOf(base)
  const changes: Change[] = []
  const others: Change[] = []
  // What the turn changed outside the project (a scratch file, a setting in the home
  // folder): listed apart, folded, and left out of the project's summary
  const elsewhere: Change[] = []
  if (how === 'turn') {
    for (const one of turn?.files ?? []) {
      const tone = toneOf(one)
      if (tone === 'read') continue
      const word = tone === 'outside' ? (one.isCreated ? s.stateNew : undefined) : wordOf(s, tone)
      const counts = countsOf(one)
      const isElsewhere = baseKey !== '' && !isUnder(one.key, baseKey)
      ;(isElsewhere ? elsewhere : tone === 'outside' ? others : changes).push({
        key: one.key,
        path: one.path,
        label: one.label,
        tone,
        ...(word === undefined ? {} : { word }),
        ...(counts === undefined ? {} : { counts }),
      })
    }
  } else if (status !== null) {
    for (const one of status.files) {
      const path = `${status.top}/${one.rel}`
      const tone = TONE_OF_CODE[one.code]
      const word = wordOf(s, tone, one.code)
      const counts = countsOf(one)
      changes.push({
        key: keyOf(path),
        path,
        label: labelOf(path, base),
        tone,
        ...(word === undefined ? {} : { word }),
        ...(counts === undefined ? {} : { counts }),
      })
    }
  }
  const byLabel = (a: Change, b: Change) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1)
  changes.sort(byLabel)
  others.sort(byLabel)
  elsewhere.sort(byLabel)
  const byKey = new Map([...changes, ...others, ...elsewhere].map(one => [one.key, one]))

  // Moves from the turn shown now; landing on the latest follows new turns again
  const step = (delta: number) => async () => {
    const now = await read($, history)
    await update($, shown, current => {
      const at = now.findIndex(one => one.id === current)
      const from = at === -1 ? now.length - 1 : at
      const to = Math.min(now.length - 1, Math.max(0, from + delta))

      return to === now.length - 1 ? null : (now[to]?.id ?? null)
    })
  }

  const open = (target: OpenedFile | null) => () => openFile($, target)
  const openChange = (one: Change) => open({ key: one.key, path: one.path, label: one.label })
  const primaryIf = (isOn: boolean) => (isOn ? { variant: 'primary' as const } : {})

  const header =
    turn === undefined ? (
      <Text dimColor>{s.noTurn}</Text>
    ) : (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={statusColorOf(turn)}>●</Text>
            <Text bold>{s.turn(turn.number)}</Text>
            <Text dimColor>· {turnStatusOf(s, turn)}</Text>
          </Box>
          {list.length > 1 && (
            <Box flexDirection="row" gap={1}>
              {index > 0 && <Button key="prev" label="‹" onPress={step(-1)} />}
              <Text dimColor tabular>
                {index + 1}/{list.length}
              </Text>
              {index < list.length - 1 && <Button key="next" label="›" onPress={step(1)} />}
            </Box>
          )}
        </Box>
        {/* The code wants the room in the file view */}
        {file === null && turn.prompt !== '' && (
          <Text dimColor italic wrap="truncate-end">
            {turn.prompt}
          </Text>
        )}
      </Box>
    )

  // ---- One file, its changes coloured ----
  if (file !== null) {
    const view = await read($, diffView)
    const record = touched.get(file.key)
    const change = byKey.get(file.key)
    // The arrows walk the list the file stands in
    const pool = [elsewhere, others].find(list => list.some(one => one.key === file.key)) ?? changes
    const at = pool.findIndex(one => one.key === file.key)
    const tone = change?.tone ?? ''

    // The two texts and what the older one is: the turn's start, or the last commit
    let before: FileText | undefined
    let after: FileText
    let against: 'turn' | 'head' | undefined
    if (how === 'commit') {
      after = await textOf($, file.path)
      const entry =
        status === null ? undefined : status.files.find(one => keyOf(`${status.top}/${one.rel}`) === file.key)
      if (status !== null && entry !== undefined) {
        // A rename's last commit is under its old path
        before =
          entry.code === '?' || entry.code === 'A' ? { kind: 'missing' } : await headOf($, status, entry.from ?? entry.rel)
        against = 'head'
      }
    } else {
      const isKept = record !== undefined && hasDiff(record)
      const snapshot: Snapshot =
        isKept && turn !== undefined ? await read($, atom({ ...SNAPSHOT, id: `${turn.id}|${file.key}` }, {})) : {}
      after =
        snapshot.after !== undefined && turn?.durationMs !== null ? snapshot.after : await textOf($, file.path)
      if (isKept && snapshot.before !== undefined) {
        before = snapshot.before
        against = snapshot.base === 'head' ? 'head' : 'turn'
      }
    }

    // ---- The editor: the file at a line, or its own diff of this turn ----
    const isLatest = how === 'commit' || index === list.length - 1
    // What went wrong, said: a start that failed, or a name a script launcher would misread
    const tell = async (how: Launch) => {
      if (ide === undefined || how === 'started') return
      await $.ui.toast(how === 'refused' ? s.editorRefused(ide.name) : s.editorFailed(ide.name))
    }
    const toEditor = (line: number) => async () => {
      if (ide === undefined) return
      await tell(await openIn($, ide, file.path, line))
    }
    const compare = async () => {
      if (ide === undefined || before === undefined || before.kind === 'too-large') return
      const moment = against === 'head' || turn === undefined ? s.lastCommit : s.beforeTurn(turn.number)
      const left = await writeSide($, file.key, file.label, moment, before.kind === 'text' ? before.text : '')
      // An older turn is compared as it left the file, not as the file is now
      const right =
        isLatest || after.kind !== 'text' || turn === undefined
          ? file.path
          : await writeSide($, file.key, file.label, s.afterTurn(turn.number), after.text)
      await tell(await compareIn($, ide, left, right))
    }

    const plain = (text: string) =>
      text === '' ? (
        <Text dimColor>{s.emptyFile}</Text>
      ) : (
        <Code source={linesOf(text).join('\n')} path={file.path} startLine={1} />
      )
    let body: RenderElement
    let stats: RenderElement | undefined
    let toggle: RenderElement | undefined
    let note = ''
    let firstLine = 1
    const isGone = after.kind === 'missing' && before?.kind === 'text'
    if (after.kind === 'too-large') {
      body = <Text dimColor>{s.tooLarge}</Text>
    } else if (after.kind === 'missing' && !isGone) {
      body = <Text color="error">{s.gone}</Text>
    } else if (against !== undefined && before !== undefined && before.kind !== 'too-large') {
      const lines = diffOf(before.kind === 'text' ? before.text : '', after.kind === 'text' ? after.text : '')
      const counts = changesOf(lines)
      const since = before.kind === 'missing' ? s.newFile : against === 'turn' ? s.sinceTurn : s.sinceHead
      if (counts.ranges.length === 0) {
        note = against === 'turn' ? s.noDiffTurn : s.noDiffHead
        body = plain(after.kind === 'text' ? after.text : '')
      } else {
        firstLine = counts.ranges[0]![0]
        // Past the drawing's room the whole file would be cut and lose its colours: its changes it is
        const isWholeTooLarge = lines.reduce((size, line) => size + line.text.length + 2, 0) > MAX_CODE
        if (isWholeTooLarge) note = s.wholeTooLarge
        stats = (
          <Box flexDirection="row" gap={1}>
            <Text color="success">+{counts.added}</Text>
            <Text color="error">−{counts.removed}</Text>
            <Text dimColor size="footnote">
              · {s.lines(rangesText(counts.ranges))} · {since}
            </Text>
          </Box>
        )
        toggle = isWholeTooLarge ? undefined : (
          <Box flexDirection="row" gap={1}>
            <Button key="view:full" {...primaryIf(view === 'full')} onPress={() => update($, diffView, () => 'full')}>
              {s.wholeFile}
            </Button>
            <Button key="view:hunks" {...primaryIf(view === 'hunks')} onPress={() => update($, diffView, () => 'hunks')}>
              {s.onlyChanges}
            </Button>
          </Box>
        )
        // Only the changes: one block each, its lines named, and the editor a click away; as
        // many as the room holds, the last one cut at a line when it alone runs past it
        const blocks: Hunk[] = []
        let room = MAX_CODE
        let isCutShort = false
        if (view === 'hunks' || isWholeTooLarge) {
          for (const hunk of hunksOf(lines)) {
            const fits = hunk.source.length <= room ? hunk : clipHunk(hunk, room)
            if (fits === undefined) {
              isCutShort = true
              break
            }
            blocks.push(fits)
            room -= fits.source.length + HUNK_LABEL
            if (fits !== hunk) {
              isCutShort = true
              break
            }
          }
        }
        body =
          view === 'hunks' || isWholeTooLarge ? (
            <Box flexDirection="column">
              {blocks.length === 0 && <Text dimColor>{s.tooLarge}</Text>}
              {blocks.map((hunk, n) => (
                <Box key={`hunk:${n}`} flexDirection="column" marginTop={n === 0 ? 0 : 1}>
                  <Box flexDirection="row" justifyContent="space-between" gap={1}>
                    <Text dimColor size="footnote">
                      {s.hunk(hunk.from, hunk.to)}
                    </Text>
                    {ide !== undefined && after.kind === 'text' && (
                      <Button key={`hunk:open:${n}`} label={`${s.openHere} ${ide.name}`} onPress={toEditor(hunk.at)} />
                    )}
                  </Box>
                  <Code source={hunk.source} format="diff" path={file.path} />
                </Box>
              ))}
              {isCutShort && blocks.length > 0 && (
                <Text key="hunks:rest" dimColor size="footnote">
                  {s.restNotDrawn}
                </Text>
              )}
            </Box>
          ) : (
            <Code source={unifiedSource(lines)} format="diff" path={file.path} />
          )
      }
    } else if (after.kind === 'text') {
      note =
        record !== undefined && hasDiff(record) ? s.noCompare : how === 'commit' ? s.unchangedHead : s.unchangedTurn
      body = plain(after.text)
    } else {
      body = <Text color="error">{s.gone}</Text>
    }

    const { name, dir } = splitLabel(file.label)
    const crumbs = tidy(dir)
      .split('/')
      .filter(part => part !== '')
      .join(' › ')
    const words = [
      how === 'turn' && record !== undefined ? badgeOf(s, record) : (change?.word ?? ''),
      note,
    ].filter(text => text !== '')
    const prev = pool[(at - 1 + pool.length) % pool.length]
    const next = pool[(at + 1) % pool.length]
    const canCompare = before !== undefined && before.kind !== 'too-large' && after.kind === 'text'

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
          <Button key="back" label={s.back} onPress={open(null)} />
          {at !== -1 && pool.length > 1 && prev !== undefined && next !== undefined && (
            <Box flexDirection="row" gap={1}>
              <Button key="chg:prev" label="‹" onPress={openChange(prev)} />
              <Text dimColor>
                {at + 1}/{pool.length}
              </Text>
              <Button key="chg:next" label="›" onPress={openChange(next)} />
            </Box>
          )}
        </Box>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1} marginTop={1}>
          <Text bold color={TONE_COLOR[tone]} dimColor={tone === 'outside'} strikethrough={tone === 'deleted'}>
            {name}
          </Text>
          {ide !== undefined && after.kind === 'text' && (
            <Box flexDirection="row" gap={1}>
              <Button key="editor:open" onPress={toEditor(firstLine)}>
                {s.open(ide.name)}
              </Button>
              {canCompare && (
                <Button key="editor:compare" onPress={compare}>
                  {s.compare(ide.name)}
                </Button>
              )}
            </Box>
          )}
        </Box>
        {crumbs !== '' && (
          <Text dimColor size="footnote" wrap="truncate-start">
            {crumbs}
          </Text>
        )}
        {words.length > 0 && (
          <Text dimColor size="footnote">
            {words.join(' · ')}
          </Text>
        )}
        {tone === 'outside' && (
          <Text dimColor italic size="footnote">
            {s.outside}
          </Text>
        )}
        {stats !== undefined && (
          <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1} marginTop={1}>
            {stats}
            {toggle}
          </Box>
        )}
        <Box marginTop={1} flexDirection="column">
          {body}
        </Box>
      </Box>
    )
  }

  // ---- The tree, the sections above it, or the search's results ----
  const manual = await read($, toggled)
  const isChangesFolded = manual[CHANGES] === false
  const isOthersOpen = manual[OTHERS] === true
  const isElsewhereOpen = manual[ELSEWHERE] === true
  const isProjectOpen = manual[PROJECT] !== false
  const text = await read($, query)
  const known = await read($, catalog)
  const ignored = new Set(known?.ignored ?? [])
  const ignoreTop = known?.top ?? ''

  // Folders holding a change are blue; in the turn view they open by
  // themselves, and so does one holding a file read
  const marked = new Map<string, 'changed' | 'read'>()
  const markUp = (key: string, kind: 'changed' | 'read') => {
    if (baseKey === '' || !isUnder(key, baseKey)) return
    const parts = key.slice(baseKey.length).split('/').filter(part => part !== '')
    let dir = baseKey
    for (const part of parts.slice(0, -1)) {
      dir = dir.endsWith('/') ? dir + part : `${dir}/${part}`
      if (marked.get(dir) !== 'changed') marked.set(dir, kind)
    }
  }
  for (const one of changes) markUp(one.key, 'changed')
  if (how === 'turn') for (const one of touched.values()) if (isRead(one)) markUp(one.key, 'read')

  // What git ignores, dimmed as an IDE dims it; a folder's contents with it
  const isIgnored = (path: string, isDir: boolean) => {
    if (ignoreTop === '' || ignored.size === 0) return false
    const rel = labelOf(path, ignoreTop).toLowerCase()

    return ignored.has(rel) || (isDir && ignored.has(`${rel}/`))
  }

  const rows: Row[] = []
  const walk = async (path: string, depth: number, isDimHere: boolean): Promise<void> => {
    const entries = (await $.fs.list(path).catch(() => []))
      .filter(entry => !HIDDEN.has(entry.name))
      .sort((a, b) =>
        (a.kind === 'dir') !== (b.kind === 'dir')
          ? a.kind === 'dir' ? -1 : 1
          : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1,
      )

    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      if (rows.length >= MAX_ROWS) return
      const child = joinPath(path, entry.name)
      const key = keyOf(child)
      const isDir = entry.kind === 'dir'
      const isDim = isDimHere || (isDir && HEAVY.has(entry.name)) || isIgnored(child, isDir)
      if (isDir) {
        const isOpen = manual[key] ?? (how === 'turn' && marked.has(key) && !isDim)
        rows.push({ key, path: child, name: entry.name, depth, kind: 'dir', isOpen, isDim })
        if (isOpen) await walk(child, depth + 1, isDim)
      } else {
        rows.push({ key, path: child, name: entry.name, depth, kind: 'file', isOpen: false, isDim })
      }
    }
    if (entries.length > MAX_ENTRIES) {
      rows.push({
        key: `${keyOf(path)}/…more`,
        path,
        name: s.more(entries.length - MAX_ENTRIES),
        depth,
        kind: 'more',
        isOpen: false,
        isDim: true,
      })
    }
  }

  // The search, over the catalogue: listed off this drawing when not there yet
  const isSearching = text.trim() !== ''
  const files = isSearching ? indexOf(base) : undefined
  if (isSearching && files === undefined) refreshCatalog($, status)
  const matches = files === undefined ? [] : search(files, text)
  const results = treeOf(matches.slice(0, MAX_MATCHES), baseKey)
  // A folded project isn't walked: nothing of it is drawn
  if (!isSearching && base !== '' && isProjectOpen) await walk(base, 0, false)

  // A row's tone, dim words and mark, the same on every surface
  const isMarked = (key: string) => marked.get(key) === 'changed'
  const toneOfFile = (key: string, isDim: boolean): Tone => byKey.get(key)?.tone ?? (isDim ? 'heavy' : '')
  const toneOfDir = (key: string, isDim: boolean): Tone => (isMarked(key) ? 'changed' : isDim ? 'heavy' : '')
  // In the tree: what the colour says, or a read file's words
  const noteOfFile = (key: string) =>
    byKey.get(key)?.word ?? (how === 'turn' ? noteOf(s, touched.get(key)) : undefined)
  // A refused edit or a conflict has no lines to count: a mark says it
  const markOf = (tone: Tone) => (tone === 'failed' ? '!' : undefined)
  // In a section: the folder, then what the colour says
  const folderOf = (one: Change) =>
    [tidy(splitLabel(one.label).dir), one.word ?? ''].filter(part => part !== '').join(' · ')
  const pathOf = (rel: string) => joinPath(base, rel.replace(/\//g, base.includes('\\') ? '\\' : '/'))

  // ---- Above the list: the view, the search, then the counts, which are the legend too ----
  const choose = (next: Mode) => async () => {
    if (next === how) return
    await update($, mode, () => next)
    if (next === 'commit') await runScan($).catch(() => undefined)
  }
  const controls = (
    <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1} marginTop={1}>
      <Box flexDirection="row" gap={1}>
        <Button key="mode:turn" {...primaryIf(how === 'turn')} onPress={choose('turn')}>
          {s.modeTurn}
        </Button>
        <Button key="mode:commit" {...primaryIf(how === 'commit')} onPress={choose('commit')}>
          {s.modeCommit}
        </Button>
      </Box>
      <Box flexDirection="row" gap={1}>
        {how === 'commit' && (
          <Button key="refresh" onPress={() => runScan($).catch(() => undefined)}>
            {s.refresh}
          </Button>
        )}
        <Button key="collapse" onPress={() => update($, toggled, () => ({}))}>
          {s.collapse}
        </Button>
      </Box>
    </Box>
  )

  // Enter opens the best match, as an IDE's Go to File does; back, the search is as it was
  const openBest = async (value: string) => {
    await update($, query, () => value)
    const best = search(indexOf(base) ?? [], value)[0]
    if (best === undefined) return
    const path = pathOf(best.rel)
    await openFile($, { key: keyOf(path), path, label: best.rel })
  }
  const searchRow = Input !== undefined && (
    <Box flexDirection="row" gap={1} marginTop={1}>
      <Box flexGrow={1}>
        <Input
          key="search"
          placeholder={s.search}
          value={text}
          submitLabel={s.searchOpen}
          onInput={value => update($, query, () => value)}
          onSubmit={openBest}
        />
      </Box>
      {isSearching && <Button key="search:clear" label="✕" onPress={() => update($, query, () => '')} />}
    </Box>
  )

  // ---- The summary: how many files, their lines, and what else the turn did ----
  const readOnly = how === 'turn' ? (turn?.files.filter(isRead).length ?? 0) : 0
  const commands = how === 'turn' ? (turn?.commands ?? 0) : 0
  const added = changes.reduce((sum, one) => sum + (one.counts?.[0] ?? 0), 0)
  const removed = changes.reduce((sum, one) => sum + (one.counts?.[1] ?? 0), 0)
  const extras = [
    readOnly > 0 ? s.reads(readOnly) : '',
    commands > 0 ? s.commands(commands) : '',
    others.length > 0 ? s.others(others.length) : '',
    elsewhere.length > 0 ? s.elsewhere(elsewhere.length) : '',
    how === 'commit' && changes.length > 0 ? s.sinceCommit : '',
  ].filter(one => one !== '')
  const notice =
    how === 'commit'
      ? status === null
        ? !hasScanned() || isScanning() ? s.askingGit : s.noRepo
        : changes.length === 0 ? s.noChangesCommit : ''
      : turn !== undefined && changes.length === 0 && others.length === 0 && elsewhere.length === 0 && readOnly === 0
        ? s.nothingTouched
        : ''
  const summary = (changes.length > 0 || extras.length > 0 || notice !== '') && (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
      {changes.length > 0 && (
        <Text key="sum:files" size="footnote">
          {s.files(changes.length)}
        </Text>
      )}
      {added > 0 && (
        <Text key="sum:added" size="footnote" color="success" tabular>
          +{added}
        </Text>
      )}
      {removed > 0 && (
        <Text key="sum:removed" size="footnote" color="error" tabular>
          −{removed}
        </Text>
      )}
      {extras.length > 0 && (
        <Text key="sum:extras" dimColor size="footnote">
          {changes.length > 0 ? '· ' : ''}
          {extras.join(' · ')}
        </Text>
      )}
      {notice !== '' && (
        <Text key="sum:notice" dimColor size="footnote">
          {notice}
        </Text>
      )}
    </Box>
  )

  // What the search says above its results
  const searchNote = !isSearching
    ? ''
    : files === undefined
      ? s.indexing
      : matches.length === 0
        ? s.noMatch(text.trim())
        : s.matches(matches.length)
  const moreMatches = matches.length > MAX_MATCHES ? s.moreMatches(matches.length - MAX_MATCHES) : ''
  // How long the search's first word is, marked where a found name holds it
  const matchLength = text.trim().split(/\s+/)[0]?.length ?? 0

  const projectPath = tidy(labelOf(base, ''))
  const hasSections = changes.length > 0 || others.length > 0 || elsewhere.length > 0
  let isCut = rows.length >= MAX_ROWS
  let lists: RenderElement

  if (Client !== undefined) {
    // One Client for everything clickable: its rows and what each click does
    const targets: (Target | null)[] = []
    const lines: TreeRow[] = []
    let size = 0
    const add = (target: Target | null, line: TreeRow) => {
      size += JSON.stringify(line).length + 1
      if (size > MAX_PROPS) {
        isCut = true

        return false
      }
      targets.push(target)
      lines.push(line)

      return true
    }
    // A file's row: its badge and colour, then its lines added and removed or its mark, the same in every list.
    // The badge always travels: the list itself drops it where it is narrow
    const fileLine = (key: string, tone: Tone, extra: Partial<TreeRow>, t: string): TreeRow => {
      const counts = byKey.get(key)?.counts
      const mark = markOf(tone)
      const badge = fileBadgeOf(t)

      return {
        t,
        c: tone,
        k: 'f',
        ...extra,
        ...(badge[0] === '' ? {} : { b: badge }),
        ...(counts === undefined ? {} : { s: counts }),
        ...(mark === undefined ? {} : { m: mark }),
      }
    }
    const heading = (key: string, title: string, words: string, isOpen: boolean) =>
      add({ kind: 'dir', key, isOpen }, { t: title, c: '', k: 'g', n: words, ...(isOpen ? { o: 1 as const } : {}) })
    const section = (key: string, title: string, entries: readonly Change[], isOpen: boolean) => {
      if (entries.length === 0) return
      heading(key, title, String(entries.length), isOpen)
      if (!isOpen) return
      for (const one of entries.slice(0, MAX_CHANGES)) {
        const folder = folderOf(one)
        add(
          { kind: 'file', key: one.key, path: one.path, label: one.label },
          fileLine(one.key, one.tone, { i: 1, ...(folder === '' ? {} : { n: folder }) }, splitLabel(one.label).name),
        )
      }
      if (entries.length > MAX_CHANGES) add(null, { t: s.more(entries.length - MAX_CHANGES), c: '', k: 'x', i: 1 })
    }

    if (isSearching) {
      if (searchNote !== '') add(null, { t: searchNote, c: '', k: 'x' })
      for (const one of results) {
        const depth = one.depth > 0 ? { d: one.depth } : {}
        const path = pathOf(one.rel)
        const key = keyOf(path)
        if (one.kind === 'dir') {
          add(
            { kind: 'reveal', keys: one.keys },
            { t: one.name, c: toneOfDir(key, false), k: 'd', o: 1, ...depth, ...(isMarked(key) ? { m: '●' } : {}) },
          )
        } else {
          const match = one.at < 0 || matchLength === 0 ? {} : { h: [one.at, one.at + matchLength] as [number, number] }
          add({ kind: 'file', key, path, label: one.rel }, fileLine(key, toneOfFile(key, false), { ...depth, ...match }, one.name))
        }
      }
      if (moreMatches !== '') add(null, { t: moreMatches, c: '', k: 'x' })
    } else {
      section(CHANGES, s.changes, changes, !isChangesFolded)
      section(OTHERS, s.otherChanges, others, isOthersOpen)
      section(ELSEWHERE, s.outsideProject, elsewhere, isElsewhereOpen)
      if (hasSections) add(null, { t: ' ', c: '', k: 'x' })
      heading(PROJECT, s.project, projectPath, isProjectOpen)
      for (const row of isProjectOpen ? rows : []) {
        const depth = row.depth > 0 ? { d: row.depth } : {}
        let isAdded: boolean
        if (row.kind === 'more') {
          isAdded = add(null, { t: `  ${row.name}`, c: '', k: 'x', ...depth })
        } else if (row.kind === 'dir') {
          isAdded = add(
            { kind: 'dir', key: row.key, isOpen: row.isOpen },
            {
              t: row.name,
              c: toneOfDir(row.key, row.isDim),
              k: 'd',
              ...depth,
              ...(isMarked(row.key) ? { m: '●' } : {}),
              ...(row.isOpen ? { o: 1 as const } : {}),
            },
          )
        } else {
          const note = noteOfFile(row.key)
          isAdded = add(
            { kind: 'file', key: row.key, path: row.path, label: labelOf(row.path, base) },
            fileLine(row.key, toneOfFile(row.key, row.isDim), { ...depth, ...(note === undefined ? {} : { n: note }) }, row.name),
          )
        }
        if (!isAdded) break
      }
    }

    generation += 1
    drawn.set(generation, targets)
    drawn.delete(generation - DRAWN_KEEP)
    const sel = targets.findIndex(target => target?.kind === 'file' && target.key === selectedKey)
    lists = (
      <Box flexDirection="column" marginTop={1}>
        <Client
          key="tree"
          module="./tree.tsx"
          props={{ gen: generation, rows: lines, ...(sel === -1 ? {} : { sel }) }}
          width="100%"
        />
      </Box>
    )
  } else {
    // The terminal keeps a Button's label colours: Buttons it is
    const toggle = (key: string, isOpen: boolean) => () => update($, toggled, current => ({ ...current, [key]: !isOpen }))
    // After a file's name: its lines added and removed, or its mark
    const tail = (key: string, tone: Tone) => {
      const counts = byKey.get(key)?.counts
      const mark = markOf(tone)
      if ((counts === undefined || counts[0] + counts[1] === 0) && mark === undefined) return undefined

      return (
        <Box key={`tail:${key}`} flexDirection="row" gap={1}>
          {counts !== undefined && counts[0] > 0 && (
            <Text color="success" dimColor={isDimTone(tone)}>
              +{counts[0]}
            </Text>
          )}
          {counts !== undefined && counts[1] > 0 && (
            <Text color="error" dimColor={isDimTone(tone)}>
              −{counts[1]}
            </Text>
          )}
          {mark !== undefined && (
            <Text bold color={TONE_COLOR.failed}>
              {mark}
            </Text>
          )}
        </Box>
      )
    }
    const chevron = (isOpen: boolean) => (
      <Text color="subtle" bold={false}>
        {isOpen ? '▾ ' : '▸ '}
      </Text>
    )

    // A file's badge before its name: its letters in their colour (a terminal draws no faint
    // tint), the room kept blank for a file with none; none at all in a narrow pane
    const paneColumns = (e as { props?: { bodyColumns?: unknown } }).props?.bodyColumns
    const isBadged = typeof paneColumns !== 'number' || paneColumns >= BADGE_MIN_COLUMNS
    const badgeText = (key: string, name: string, tone: Tone) => {
      if (!isBadged) return undefined
      const [letters, color] = fileBadgeOf(name)

      return (
        <Text key={`badge:${key}`} bold color={color} dimColor={isDimTone(tone)}>
          {letters.padEnd(2)}
        </Text>
      )
    }

    const fileButton = (key: string, path: string, label: string, name: string, tone: Tone) => (
      <Button key={`file:${key}`} plain onPress={open({ key, path, label })}>
        <Text color={TONE_COLOR[tone]} dimColor={isDimTone(tone)} strikethrough={tone === 'deleted'}>
          {name}
        </Text>
      </Button>
    )

    const rowOf = (row: Row) => {
      if (row.kind === 'more') {
        return (
          <Box key={row.key} paddingLeft={row.depth * 2 + 2}>
            <Text dimColor>{row.name}</Text>
          </Box>
        )
      }
      if (row.kind === 'dir') {
        const tone = toneOfDir(row.key, row.isDim)

        return (
          <Box key={row.key} flexDirection="row" gap={1} paddingLeft={row.depth * 2}>
            <Button key={`dir:${row.key}`} plain dimColor={row.isDim} onPress={toggle(row.key, row.isOpen)}>
              <Text color={TONE_COLOR[tone]} dimColor={row.isDim}>
                {chevron(row.isOpen)}
                {row.name}
              </Text>
            </Button>
            {isMarked(row.key) && <Text color={TONE_COLOR.changed}>●</Text>}
          </Box>
        )
      }
      const tone = toneOfFile(row.key, row.isDim)
      const note = noteOfFile(row.key)

      return (
        <Box key={row.key} flexDirection="row" gap={1} paddingLeft={row.depth * 2 + 2}>
          {badgeText(row.key, row.name, tone)}
          {fileButton(row.key, row.path, labelOf(row.path, base), row.name, tone)}
          {note !== undefined && <Text dimColor>{note}</Text>}
          {tail(row.key, tone)}
        </Box>
      )
    }

    const headingOf = (key: string, title: string, words: string, isOpen: boolean) => (
      <Box key={`head:${key}`} flexDirection="row" gap={1}>
        <Button key={key} plain onPress={toggle(key, isOpen)}>
          <Text bold>
            {chevron(isOpen)}
            {title}
          </Text>
        </Button>
        <Text dimColor wrap="truncate-start">
          {words}
        </Text>
      </Box>
    )

    const sectionOf = (key: string, title: string, entries: readonly Change[], isOpen: boolean) =>
      entries.length > 0 && (
        <Box key={key} flexDirection="column" marginTop={1}>
          {headingOf(key, title, String(entries.length), isOpen)}
          {isOpen &&
            entries.slice(0, MAX_CHANGES).map(one => {
              const folder = folderOf(one)

              return (
                <Box key={`row:${one.key}`} flexDirection="row" gap={1} paddingLeft={2}>
                  {badgeText(one.key, splitLabel(one.label).name, one.tone)}
                  <Button key={`chg:${one.key}`} plain onPress={openChange(one)}>
                    <Text color={TONE_COLOR[one.tone]} dimColor={isDimTone(one.tone)} strikethrough={one.tone === 'deleted'}>
                      {splitLabel(one.label).name}
                    </Text>
                  </Button>
                  {folder !== '' && <Text dimColor>{folder}</Text>}
                  {tail(one.key, one.tone)}
                </Box>
              )
            })}
          {isOpen && entries.length > MAX_CHANGES && (
            <Box paddingLeft={2}>
              <Text dimColor>{s.more(entries.length - MAX_CHANGES)}</Text>
            </Box>
          )}
        </Box>
      )

    lists = isSearching ? (
      <Box flexDirection="column" marginTop={1}>
        {searchNote !== '' && <Text dimColor>{searchNote}</Text>}
        {results.map(one => {
          const path = pathOf(one.rel)
          const key = keyOf(path)
          if (one.kind === 'dir') {
            return (
              <Box key={`found:${key}`} flexDirection="row" gap={1} paddingLeft={one.depth * 2}>
                <Button key={`reveal:${key}`} plain onPress={() => reveal($, one.keys)}>
                  <Text color={TONE_COLOR[toneOfDir(key, false)]}>
                    {chevron(true)}
                    {one.name}
                  </Text>
                </Button>
              </Box>
            )
          }
          const tone = toneOfFile(key, false)

          return (
            <Box key={`found:${key}`} flexDirection="row" gap={1} paddingLeft={one.depth * 2 + 2}>
              {badgeText(key, one.name, tone)}
              {fileButton(key, path, one.rel, one.name, tone)}
              {tail(key, tone)}
            </Box>
          )
        })}
        {moreMatches !== '' && <Text dimColor>{moreMatches}</Text>}
      </Box>
    ) : (
      <Box flexDirection="column">
        {sectionOf(CHANGES, s.changes, changes, !isChangesFolded)}
        {sectionOf(OTHERS, s.otherChanges, others, isOthersOpen)}
        {sectionOf(ELSEWHERE, s.outsideProject, elsewhere, isElsewhereOpen)}
        <Box flexDirection="column" marginTop={1}>
          {headingOf(PROJECT, s.project, projectPath, isProjectOpen)}
          {isProjectOpen && rows.map(rowOf)}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      {summary}
      {controls}
      {searchRow}
      {lists}
      {isCut && <Text dimColor>{s.cut}</Text>}
    </Box>
  )
}
