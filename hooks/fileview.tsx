import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { FileText, GitStatus, Mode, OpenedFile, Snapshot, TouchedFile, TurnRecord } from '../types'
import { openFile } from './actions'
import { changesOf, clipHunk, diffLines, hunksOf, linesOf, unifiedSource } from './diff'
import type { DiffLine, Hunk } from './diff'
import { compareIn, openIn, writeSide } from './editor'
import type { Editor, Launch } from './editor'
import { headOf, textOf } from './git'
import { TONE_COLOR, badgeOf, hasDiff, rangesText } from './model'
import type { Change } from './model'
import { keyOf, nativeOf, splitLabel, tidy } from './paths'
import type { Strings } from './text'

// A changed file opens on its changes, the lines around each: what the turn did, read without
// scrolling the whole file. The whole file is a press away, and stays chosen once pressed
const diffView = atom({ plugin: 'canopy', key: 'diffView' } as const, 'hunks')
const SNAPSHOT = { plugin: 'canopy', key: 'snapshot' } as const

// The code one file view draws: the engine draws a tree's first 100,000
// characters of text, and a Code it cuts loses its colours. Each block of
// changes costs its label and its editor button besides its code
const MAX_CODE = 90_000
const HUNK_LABEL = 40

type Table = ReturnType<EngineInterface['ui']['resolve']>

/** What the file view is drawn from: the pane's reading of the moment. */
export type FileContext = {
  elements: Table
  /** Where it is drawn: what a desktop marks by itself, the terminal says in words. */
  surface: string
  s: Strings
  file: OpenedFile
  how: Mode
  status: GitStatus | null
  /** The turn shown, and whether it is the latest. */
  turn: TurnRecord | undefined
  isLatest: boolean
  /** What the turn did to the file, and its entry in a section's list. */
  record: TouchedFile | undefined
  change: Change | undefined
  /** The list the file stands in, which the arrows walk. */
  pool: readonly Change[]
  ide: Editor | undefined
  header: RenderElement
}

// The last diff drawn, so a redraw of the same texts does not walk it again
let lastDiff: { before: string; after: string; lines: DiffLine[] } | undefined

const diffOf = (before: string, after: string) => {
  if (lastDiff?.before !== before || lastDiff.after !== after) {
    lastDiff = { before, after, lines: diffLines(linesOf(before), linesOf(after)) }
  }

  return lastDiff.lines
}

// The file the view shows as last read, with its time and size then: a redraw (a tool
// call elsewhere, a count landing) reads it again only once it changed on disk
let lastRead: { path: string; mtimeMs: number; size: number; text: FileText } | undefined

async function currentText($: EngineInterface, path: string): Promise<FileText> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file') return textOf($, path)
  if (lastRead?.path === path && lastRead.mtimeMs === stat.mtimeMs && lastRead.size === stat.size) return lastRead.text
  const text = await textOf($, path)
  lastRead = { path, mtimeMs: stat.mtimeMs, size: stat.size, text }

  return text
}

/** Lets go of what the file view keeps between drawings, a megabyte's texts and their diff: no file is open. */
export function releaseFileView() {
  lastDiff = undefined
  lastRead = undefined
}

const primaryIf = (isOn: boolean) => (isOn ? { variant: 'primary' as const } : {})

/** One file, its changes coloured: against the turn's start, or the last commit. */
export async function renderFile($: EngineInterface, view: FileContext): Promise<RenderElement> {
  const { Box, Text, Button, Code } = view.elements
  const { s, file, how, status, turn, record, change, pool, ide, header } = view
  const open = (target: OpenedFile | null) => () => openFile($, target)
  const openChange = (one: Change) => open({ key: one.key, path: one.path, label: one.label })
  const shownAs = await read($, diffView)
  const at = pool.findIndex(one => one.key === file.key)
  const tone = change?.tone ?? ''

  // A folder git lists whole (unknown to it, or a repository of its own): no text to read
  const isFolder = /[\\/]$/.test(file.path)

  // The two texts and what the older one is: the turn's start, or the last commit
  let before: FileText | undefined
  let after: FileText
  let against: 'turn' | 'head' | undefined
  if (isFolder) {
    after = { kind: 'missing' }
  } else if (how === 'commit') {
    after = await currentText($, file.path)
    const entry = status === null ? undefined : status.files.find(one => keyOf(`${status.top}/${one.rel}`) === file.key)
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
    after = snapshot.after !== undefined && turn?.durationMs !== null ? snapshot.after : await currentText($, file.path)
    if (isKept && snapshot.before !== undefined) {
      before = snapshot.before
      against = snapshot.base === 'head' ? 'head' : 'turn'
    }
  }

  // ---- The editor: the file at a line, or its own diff of this turn ----
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
    const moment = against === 'head' || turn === undefined ? s.lastCommit : s.sideBefore
    const left = await writeSide($, file.key, file.label, moment, before.kind === 'text' ? before.text : '')
    // An older turn is compared as it left the file, not as the file is now
    const right =
      view.isLatest || after.kind !== 'text' || turn === undefined
        ? file.path
        : await writeSide($, file.key, file.label, s.sideAfter, after.text)
    await tell(await compareIn($, ide, left, right))
  }

  // A file drawn as it is: its lines while the drawing has room for them, as a diff's
  // changes are, and a note where they stop. Cut by the engine it would lose its colours
  const plain = (text: string) => {
    if (text === '') return <Text dimColor>{s.emptyFile}</Text>
    const lines = linesOf(text)
    const kept: string[] = []
    let size = 0
    for (const line of lines) {
      if (size + line.length + 1 > MAX_CODE) break
      kept.push(line)
      size += line.length + 1
    }
    // A first line longer than the room alone, as a minified file's: its start
    if (kept.length === 0) kept.push((lines[0] ?? '').slice(0, MAX_CODE))
    const isCut = kept.length < lines.length || kept[0]!.length < (lines[0] ?? '').length

    return (
      <Box flexDirection="column">
        <Code source={kept.join('\n')} path={file.path} startLine={1} />
        {isCut && (
          <Text dimColor size="footnote">
            {s.restOfFile}
          </Text>
        )}
      </Box>
    )
  }
  let body: RenderElement
  let stats: RenderElement | undefined
  let toggle: RenderElement | undefined
  let note = ''
  let firstLine = 1
  const isGone = after.kind === 'missing' && before?.kind === 'text'
  if (isFolder) {
    body = <Text dimColor>{s.wholeFolder}</Text>
  } else if (after.kind === 'too-large') {
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
      // A side with nothing to count left out, as the lists leave it: no `−0` under a new file
      stats = (
        <Box flexDirection="row" gap={1}>
          {counts.added > 0 && <Text color="success">+{counts.added}</Text>}
          {counts.removed > 0 && <Text color="error">−{counts.removed}</Text>}
          <Text dimColor size="footnote">
            · {s.lines(rangesText(counts.ranges))} · {since}
          </Text>
        </Box>
      )
      toggle = isWholeTooLarge ? undefined : (
        <Box flexDirection="row" gap={1}>
          <Button key="view:full" {...primaryIf(shownAs === 'full')} onPress={() => update($, diffView, () => 'full')}>
            {s.wholeFile}
          </Button>
          <Button key="view:hunks" {...primaryIf(shownAs === 'hunks')} onPress={() => update($, diffView, () => 'hunks')}>
            {s.onlyChanges}
          </Button>
        </Box>
      )
      // Only the changes: one block each, its lines named, and the editor a click away; as
      // many as the room holds, the last one cut at a line when it alone runs past it
      const blocks: Hunk[] = []
      let room = MAX_CODE
      let isCutShort = false
      if (shownAs === 'hunks' || isWholeTooLarge) {
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
        shownAs === 'hunks' || isWholeTooLarge ? (
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
    note = record !== undefined && hasDiff(record) ? s.noCompare : how === 'commit' ? s.unchangedHead : s.unchangedTurn
    body = plain(after.text)
  } else {
    body = <Text color="error">{s.gone}</Text>
  }

  const { name, dir } = splitLabel(file.label)
  const crumbs = tidy(dir)
    .split('/')
    .filter(part => part !== '')
    .join(' › ')
  const words = [how === 'turn' && record !== undefined ? badgeOf(s, record) : (change?.word ?? ''), note].filter(
    text => text !== '',
  )
  const prev = pool[(at - 1 + pool.length) % pool.length]
  const next = pool[(at + 1) % pool.length]
  // Against a text it had: a new file beside an empty one would only show it all added
  const canCompare = before?.kind === 'text' && after.kind === 'text'
  // The path as a prompt takes it: from the project's folder, else whole, in its system's separators
  const copyPath = async (press: { surface?: Parameters<typeof $.ui.copy>[0]['surface'] }) => {
    const text = nativeOf(file.label)
    const copied = await $.ui.copy({ text, ...(press.surface === undefined ? {} : { surface: press.surface }) })
    await $.ui.toast(copied.isCopied ? s.pathCopied(text) : s.copyFailed)
  }

  return (
    <Box flexDirection="column">
      {header}
      <Box flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
        {/* Its letter goes back to the tree from anywhere in the file, the pane holding the
            keys. A desktop marks it on the button itself; the terminal says it beside, on
            one line that gives way to the arrows */}
        <Box flexDirection="row" gap={1} flexShrink={1}>
          <Button key="back" label={s.back} hotkey={s.backKey} onPress={open(null)} />
          {view.surface === 'terminal' && (
            <Text dimColor size="footnote" wrap="truncate-end">
              {s.backHint(s.backKey)}
            </Text>
          )}
        </Box>
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
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {ide !== undefined && after.kind === 'text' && (
            <Button key="editor:open" onPress={toEditor(firstLine)}>
              {s.open(ide.name)}
            </Button>
          )}
          {ide !== undefined && after.kind === 'text' && canCompare && (
            <Button key="editor:compare" onPress={compare}>
              {s.compare(ide.name)}
            </Button>
          )}
          <Button key="copy:path" onPress={copyPath}>
            {s.copyPath}
          </Button>
        </Box>
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
