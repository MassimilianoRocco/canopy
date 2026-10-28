import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { GitStatus, Mode, OpenedFile, TouchedFile, TurnRecord } from '../types'
import { openFile, pickTurn, remember, reveal, selected } from './actions'
import type { Target } from './actions'
import { BADGE_MIN_COLUMNS, fileBadgeOf } from './filetype'
import { HEAVY, HIDDEN, indexOf } from './git'
import { listingOf } from './listing'
import { TONE_COLOR, isClaude, isDimTone, noteOf, statusColorOf } from './model'
import type { Change } from './model'
import { isUnder, joinPath, keyOf, labelOf, pathIn, shownOf, splitLabel } from './paths'
import { refreshIndex } from './scan'
import { search, treeOf } from './search'
import type { Strings } from './text'
import type { Tone, TreeRow } from './tree'

const toggled = atom({ plugin: 'canopy', key: 'toggled' } as const, {})
const catalog = atom({ plugin: 'canopy', key: 'catalog' } as const, null)

const MAX_ENTRIES = 300
const MAX_ROWS = 800
const MAX_CHANGES = 40
const MAX_MATCHES = 150
const MAX_PROPS = 90_000

// A desktop's list draws from a little above the pane's window over it (the
// rows the pane shows above the list, a scroll on its way), in steps of rows:
// the window moving inside a step changes nothing the list is handed
const WINDOW_LEAD = 40
const WINDOW_STEP = 20

// The sections' folds, kept with the folders' own: Changes and the project
// open, Other changes and Outside the project closed
const CHANGES = 'section:changes'
const OTHERS = 'section:others'
const ELSEWHERE = 'section:elsewhere'
const PROJECT = 'section:project'

type Table = ReturnType<EngineInterface['ui']['resolve']>
type ClientTag = Extract<Table, { Client: unknown }>['Client']

/** One row of the project's tree, as walked. */
type Row = {
  key: string
  path: string
  name: string
  depth: number
  kind: 'dir' | 'file' | 'more'
  isOpen: boolean
  isDim: boolean
}

/** What the lists are drawn from: the pane's reading of the moment. */
export type ListContext = {
  elements: Table
  /** A desktop's list of coloured rows, where there is one: else Buttons. */
  Client: ClientTag | undefined
  /** The pane's columns, and its window over what it draws, from its drawing's props. */
  columns: number | undefined
  scroll: { offset: number; bodyRows: number } | undefined
  s: Strings
  how: Mode
  base: string
  /** The turn's files, by key; the entries of each section, and all of them by key. */
  touched: ReadonlyMap<string, TouchedFile>
  changes: readonly Change[]
  others: readonly Change[]
  elsewhere: readonly Change[]
  byKey: ReadonlyMap<string, Change>
  status: GitStatus | null
  /** What the search field holds. */
  text: string
  /** The turns kept, to pick one in place of the lists: the one shown by id, null for the latest. */
  turns?: { list: readonly TurnRecord[]; shownId: string | null }
}

// A turn's prompt as its row carries it: the rest is cut where the row ends anyway
const TURN_PROMPT = 160

/**
 * The turns kept, the latest first, to pick one: each with its dot in its
 * state's colour, how many files it changed and its prompt, the latest marked.
 * Picking the latest follows the turns to come.
 */
function renderTurns(
  $: EngineInterface,
  view: ListContext,
  turns: NonNullable<ListContext['turns']>,
): { lists: RenderElement; isCut: boolean } {
  const { Box, Text, Button } = view.elements
  const { Client, s } = view
  const latest = turns.list.at(-1)
  const entries = [...turns.list].reverse().map(turn => {
    const isLatest = turn === latest
    const words = [
      ...(turn.durationMs === null ? [s.running] : []),
      s.files(turn.files.filter(isClaude).length),
      turn.prompt.slice(0, TURN_PROMPT),
    ].filter(word => word !== '')

    return {
      turn,
      isLatest,
      isShown: isLatest ? turns.shownId === null : turn.id === turns.shownId,
      words: words.join(' · '),
      target: { kind: 'turn' as const, id: isLatest ? null : turn.id },
    }
  })

  if (Client !== undefined) {
    const targets: Target[] = entries.map(entry => entry.target)
    const rows: TreeRow[] = entries.map(entry => ({
      t: s.turn(entry.turn.number),
      c: '',
      k: 't',
      n: entry.words,
      u: statusColorOf(entry.turn),
      ...(entry.isLatest ? { m: s.current } : {}),
    }))
    const sel = entries.findIndex(entry => entry.isShown)

    return {
      lists: (
        <Box flexDirection="column" marginTop={1}>
          <Client
            key="tree"
            module="./tree.tsx"
            props={{ gen: remember(targets), rows, ...(sel === -1 ? {} : { sel }), note: s.cut }}
            width="100%"
          />
        </Box>
      ),
      isCut: false,
    }
  }

  return {
    lists: (
      <Box flexDirection="column" marginTop={1}>
        {entries.map(entry => (
          <Box key={`turn:${entry.turn.number}`} flexDirection="row" gap={1}>
            <Text color={statusColorOf(entry.turn)}>●</Text>
            <Button key={`turn:${entry.turn.number}`} plain onPress={() => pickTurn($, entry.target.id)}>
              <Text {...(entry.isShown ? { bold: true } : {})}>{s.turn(entry.turn.number)}</Text>
            </Button>
            <Text dimColor wrap="truncate-end">
              {entry.words}
            </Text>
            {entry.isLatest && <Text dimColor>{s.current}</Text>}
          </Box>
        ))}
      </Box>
    ),
    isCut: false,
  }
}

/**
 * The sections, the project's tree under them, or the search's results: a
 * Client of coloured rows on a desktop, Buttons on the terminal. `isCut` when
 * the list was cut short, for the terminal to say so.
 */
export async function renderLists($: EngineInterface, view: ListContext): Promise<{ lists: RenderElement; isCut: boolean }> {
  if (view.turns !== undefined) return renderTurns($, view, view.turns)
  const { Box, Text, Button } = view.elements
  const { Client, s, how, base, touched, changes, others, elsewhere, byKey, status, text } = view
  const baseKey = keyOf(base)
  const open = (target: OpenedFile | null) => () => openFile($, target)
  const openChange = (one: Change) => open({ key: one.key, path: one.path, label: one.label })

  const manual = await read($, toggled)
  const isChangesFolded = manual[CHANGES] === false
  const isOthersOpen = manual[OTHERS] === true
  const isElsewhereOpen = manual[ELSEWHERE] === true
  const isProjectOpen = manual[PROJECT] !== false
  const known = await read($, catalog)
  const ignored = new Set(known?.ignored ?? [])
  const ignoreTop = known?.top ?? ''

  // Folders holding a change are blue; in the turn view they open by themselves
  const marked = new Set<string>()
  const markUp = (key: string) => {
    if (baseKey === '' || !isUnder(key, baseKey)) return
    const parts = key.slice(baseKey.length).split('/').filter(part => part !== '')
    let dir = baseKey
    for (const part of parts.slice(0, -1)) {
      dir = dir.endsWith('/') ? dir + part : `${dir}/${part}`
      marked.add(dir)
    }
  }
  for (const one of changes) markUp(one.key)

  // What git ignores, dimmed as an IDE dims it; a folder's contents with it
  const isIgnored = (path: string, isDir: boolean) => {
    if (ignoreTop === '' || ignored.size === 0) return false
    const rel = labelOf(path, ignoreTop).toLowerCase()

    return ignored.has(rel) || (isDir && ignored.has(`${rel}/`))
  }

  const rows: Row[] = []
  const walk = async (path: string, depth: number, isDimHere: boolean): Promise<void> => {
    const entries = (await listingOf($, path))
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

  // The search, over the catalogue: listed off this drawing when not there yet, or past its time
  const isSearching = text.trim() !== ''
  if (isSearching) await refreshIndex($, base, status)
  const files = isSearching ? indexOf(base) : undefined
  const matches = files === undefined ? [] : search(files, text)
  const results = treeOf(matches.slice(0, MAX_MATCHES), baseKey)
  // A folded project isn't walked: nothing of it is drawn
  if (!isSearching && base !== '' && isProjectOpen) await walk(base, 0, false)

  // A row's tone, dim words and mark, the same on every surface
  const isMarked = (key: string) => marked.has(key)
  const toneOfFile = (key: string, isDim: boolean): Tone => byKey.get(key)?.tone ?? (isDim ? 'heavy' : '')
  const toneOfDir = (key: string, isDim: boolean): Tone => (isMarked(key) ? 'changed' : isDim ? 'heavy' : '')
  // In the tree: what the colour says, or a read file's words
  const noteOfFile = (key: string) =>
    byKey.get(key)?.word ?? (how === 'turn' ? noteOf(s, touched.get(key)) : undefined)
  // A refused edit or a conflict has no lines to count: a mark says it
  const markOf = (tone: Tone) => (tone === 'failed' ? '!' : undefined)
  // In a section: the folder, then what the colour says
  const folderOf = (one: Change) =>
    [shownOf(splitLabel(one.label).dir), one.word ?? ''].filter(part => part !== '').join(' · ')

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

  const projectPath = shownOf(base)
  const hasSections = changes.length > 0 || others.length > 0 || elsewhere.length > 0
  let isCut = rows.length >= MAX_ROWS

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
        const path = pathIn(base, one.rel)
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

    const gen = remember(targets)
    const selectedKey = selected()
    const sel = targets.findIndex(target => target?.kind === 'file' && target.key === selectedKey)
    const from =
      view.scroll === undefined
        ? undefined
        : Math.max(0, Math.floor((view.scroll.offset - WINDOW_LEAD) / WINDOW_STEP) * WINDOW_STEP)

    return {
      lists: (
        <Box flexDirection="column" marginTop={1}>
          <Client
            key="tree"
            module="./tree.tsx"
            props={{
              gen,
              rows: lines,
              ...(sel === -1 ? {} : { sel }),
              note: s.cut,
              ...(isCut ? { cut: 1 } : {}),
              ...(from === undefined ? {} : { from }),
            }}
            width="100%"
          />
        </Box>
      ),
      isCut,
    }
  }

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
  const isBadged = view.columns === undefined || view.columns >= BADGE_MIN_COLUMNS
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

  const lists = isSearching ? (
    <Box flexDirection="column" marginTop={1}>
      {searchNote !== '' && <Text dimColor>{searchNote}</Text>}
      {results.map(one => {
        const path = pathIn(base, one.rel)
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

  return { lists, isCut }
}
