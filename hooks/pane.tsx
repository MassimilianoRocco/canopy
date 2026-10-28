import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Lang, Mode, TurnRecord } from '../types'
import { faultOn, openFile, toggleTurns } from './actions'
import { currentEditor } from './editor'
import { releaseFileView, renderFile } from './fileview'
import { indexOf, rootOf } from './git'
import { renderLists } from './lists'
import { TONE_OF_CODE, countsOf, statusColorOf, toneOf, turnStatusOf, wordOf } from './model'
import type { Change } from './model'
import { isUnder, keyOf, labelOf, pathIn } from './paths'
import { hasScanned, isScanning, runScan, scheduleScan } from './scan'
import { search } from './search'
import { STRINGS } from './text'

export { PANE, actOn } from './actions'

const history = atom({ plugin: 'canopy', key: 'history' } as const, [])
const shown = atom({ plugin: 'canopy', key: 'shown' } as const, null)
const root = atom({ plugin: 'canopy', key: 'root' } as const, '')
const toggled = atom({ plugin: 'canopy', key: 'toggled' } as const, {})
const opened = atom({ plugin: 'canopy', key: 'opened' } as const, null)
const mode = atom({ plugin: 'canopy', key: 'mode' } as const, 'turn')
const git = atom({ plugin: 'canopy', key: 'git' } as const, null)
const query = atom({ plugin: 'canopy', key: 'query' } as const, '')
const lang = atom({ plugin: 'canopy', key: 'lang' } as const, 'en')
const editor = atom({ plugin: 'canopy', key: 'editor' } as const, null)
const promptOpen = atom({ plugin: 'canopy', key: 'isPromptOpen' } as const, false)
const turnsOpen = atom({ plugin: 'canopy', key: 'isTurnsOpen' } as const, false)

const primaryIf = (isOn: boolean) => (isOn ? { variant: 'primary' as const } : {})

/**
 * Draws the pane: `fixed` is the language the options name, else the one
 * detected. The turn shown and its summary here; one file's view in
 * fileview.tsx, the lists in lists.tsx.
 */
export async function renderPane(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  fixed: Lang | undefined,
) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  // A desktop draws Buttons as native controls, which drop the colour of
  // their label: there the clickable list is a Client of coloured rows, unless
  // it failed there, when Buttons it is all the same
  const fault = faultOn(e.surface)
  const Client = e.surface === 'desktop' && 'Client' in elements && fault === undefined ? elements.Client : undefined
  const Input = 'Input' in elements ? elements.Input : undefined
  const props = (e as { props?: { bodyColumns?: unknown; scroll?: { offset?: unknown; bodyRows?: unknown } } }).props
  const columns = props?.bodyColumns
  const scroll = props?.scroll

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
  const isInProject = (key: string) => baseKey === '' || isUnder(key, baseKey)
  const changes: Change[] = []
  const others: Change[] = []
  // What the turn changed outside the project (a scratch file, a setting in the home
  // folder): listed apart, folded, and left out of the project's summary
  const elsewhere: Change[] = []
  if (how === 'turn') {
    for (const one of turn?.files ?? []) {
      const tone = toneOf(one)
      if (tone === '') continue
      const word = tone === 'outside' ? (one.isCreated ? s.stateNew : undefined) : wordOf(s, tone)
      const counts = countsOf(one)
      ;(!isInProject(one.key) ? elsewhere : tone === 'outside' ? others : changes).push({
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
        // A folder git lists whole (`venv/`) by its name; its path keeps the slash
        label: labelOf(path, base).replace(/\/+$/, ''),
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

  // The prompt on one line; one longer than the line opens whole with a press, and closes again
  const isPromptOpen = await read($, promptOpen)
  const promptRoom = Math.floor((typeof columns === 'number' ? columns : 60) * 0.9) - 3
  const isPromptLong = turn !== undefined && turn.prompt.length > promptRoom

  // With more than one turn kept, the turn's name opens the list of them, to pick one by
  // what it was asked; the arrows step through them one by one
  const isTurnsOpen = list.length > 1 && (await read($, turnsOpen))

  const header =
    turn === undefined ? (
      <Text dimColor>{s.noTurn}</Text>
    ) : (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={statusColorOf(turn)}>●</Text>
            {list.length > 1 ? (
              <Button key="turns" plain onPress={() => toggleTurns($)}>
                <Text bold>
                  {s.turn(turn.number)} {isTurnsOpen ? '▴' : '▾'}
                </Text>
              </Button>
            ) : (
              <Text bold>{s.turn(turn.number)}</Text>
            )}
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
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor italic {...(isPromptOpen && isPromptLong ? {} : { wrap: 'truncate-end' as const })}>
                {turn.prompt}
              </Text>
            </Box>
            {isPromptLong && (
              <Button
                key="prompt"
                plain
                dimColor
                label={isPromptOpen ? '▴' : '▾'}
                onPress={() => update($, promptOpen, open => !open)}
              />
            )}
          </Box>
        )}
      </Box>
    )

  // ---- The turns kept, to pick one: in place of the lists, under the same header ----
  if (isTurnsOpen) {
    releaseFileView()
    const { lists } = await renderLists($, {
      elements,
      Client,
      columns: typeof columns === 'number' ? columns : undefined,
      scroll: undefined,
      s,
      how,
      base,
      touched,
      changes: [],
      others: [],
      elsewhere: [],
      byKey: new Map(),
      status,
      text: '',
      turns: { list, shownId: index === list.length - 1 ? null : (list[index]?.id ?? null) },
    })

    return (
      <Box flexDirection="column">
        {header}
        {lists}
      </Box>
    )
  }

  // ---- One file, its changes coloured ----
  if (file !== null) {
    return renderFile($, {
      elements,
      surface: e.surface,
      s,
      file,
      how,
      status,
      turn,
      isLatest: how === 'commit' || index === list.length - 1,
      record: touched.get(file.key),
      change: byKey.get(file.key),
      // The arrows walk the list the file stands in
      pool: [elsewhere, others].find(one => one.some(entry => entry.key === file.key)) ?? changes,
      ide,
      header,
    })
  }

  releaseFileView()

  // ---- Above the list: the view, the search, then the counts, which are the legend too ----
  const text = await read($, query)
  const isSearching = text.trim() !== ''
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
    const path = pathIn(base, best.rel)
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
  const commands = how === 'turn' ? (turn?.commands ?? 0) : 0
  const added = changes.reduce((sum, one) => sum + (one.counts?.[0] ?? 0), 0)
  const removed = changes.reduce((sum, one) => sum + (one.counts?.[1] ?? 0), 0)
  const extras = [
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
      : turn !== undefined && changes.length === 0 && others.length === 0 && elsewhere.length === 0
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

  const { lists, isCut } = await renderLists($, {
    elements,
    Client,
    columns: typeof columns === 'number' ? columns : undefined,
    scroll:
      typeof scroll?.offset === 'number' && typeof scroll.bodyRows === 'number'
        ? { offset: scroll.offset, bodyRows: scroll.bodyRows }
        : undefined,
    s,
    how,
    base,
    touched,
    changes,
    others,
    elsewhere,
    byKey,
    status,
    text,
  })

  return (
    <Box flexDirection="column">
      {header}
      {summary}
      {/* git lists the folders it doesn't know whole: a file a command made in one is not named */}
      {status?.isFolded === true && (
        <Text dimColor size="footnote">
          {s.folded}
        </Text>
      )}
      {controls}
      {searchRow}
      {lists}
      {/* On a desktop the list says it itself, where it cut the rows or drew fewer */}
      {isCut && Client === undefined && <Text dimColor>{s.cut}</Text>}
      {fault !== undefined && (
        <Text dimColor size="footnote" wrap="truncate-end">
          {s.listFallback(fault)}
        </Text>
      )}
    </Box>
  )
}
