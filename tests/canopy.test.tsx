import type { FsEntry, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted, TestBody } from 'claude-code/testing'

import { changesOf, diffLines, linesOf } from '../hooks/diff'
import { quoteArg } from '../hooks/editor'

const PANE = {
  plugin: 'canopy',
  component: 'Pane',
  requestId: 'canopy',
  props: {
    title: 'Canopy',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// The kit runs the tests with timers, which the plugin's own environment has none of: for a
// wait in real time, as the tree's listings keep it
declare const setTimeout: (done: () => void, ms: number) => unknown

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

// The tests that read the pane's words read them in Italian
const IT = { options: { language: 'it' } }

// What `git` answers: the committed text by repo-relative path, and what it
// ignores (a folder ends in `/`). Absent, the project is no repository.
// `renamed` maps a staged rename's new path to its old one; `nested` is a
// folder inside the project holding a repository of its own; `showDelay`, how
// long each `git show` takes on the test's clock.
type Repo = {
  head: Record<string, string>
  ignored?: string[]
  renamed?: Record<string, string>
  nested?: string
  showDelay?: number
}

const ran = (exitCode: number, stdout = '') => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// A project on a disk in memory, and the engine beneath the plugin. A Bash
// command `write <path> <text>` stands in for any command that writes a file;
// `touch` is a change made by anything else (the person, an editor, a hook).
const project = (
  on: On,
  files: Record<string, string>,
  repo?: Repo,
  cwd = 'C:\\proj',
) => {
  const disk = new Map(Object.entries(files))
  // When each file was last written: never, for the ones the test starts with
  const writtenAt = new Map<string, number>()
  const scans = { count: 0 }
  // How many folders were listed, files read, processes started
  const lists = { count: 0 }
  const reads = { count: 0 }
  const processes = { count: 0 }
  // How many times the project's files were listed for the search
  const catalogs = { count: 0 }
  // An Edit on a held path waits: `isReached` once it is under way, `release` lets it end
  const gates = new Map<string, { reached: () => void; open: Promise<void> }>()
  const hold = (path: string) => {
    let reached = () => {}
    let release = () => {}
    const isReached = new Promise<void>(resolve => {
      reached = resolve
    })
    const open = new Promise<void>(resolve => {
      release = resolve
    })
    gates.set(path, { reached, open })

    return { isReached, release }
  }
  // What the plugin started besides git, with the variables it set, and the files it wrote
  const launched: { argv: string[]; env: Record<string, string> }[] = []
  const saved = new Map<string, string>()
  const norm = (path: string) => path.replace(/\//g, '\\')
  const isDir = (path: string) => [...disk.keys()].some(file => file.startsWith(path + '\\'))
  const relOf = (path: string) => path.slice('C:\\proj\\'.length).replace(/\\/g, '/')
  const isIgnored = (rel: string) => (repo?.ignored ?? []).some(one => rel === one || (one.endsWith('/') && rel.startsWith(one)))

  const clock = mock.clock(on, { now: 1_000_000 })
  // Each write at a moment of its own, as a disk's clock is finer than the test's
  let writes = 0
  const touch = (path: string, text: string) => {
    disk.set(path, text)
    writes += 1
    writtenAt.set(path, clock.now() + writes / 1000)
  }
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: 'C:\\proj' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('fs.exists', (_, e) => ({ value: disk.has(norm(e.path)) || isDir(norm(e.path)) }))
  on('fs.read', (_, e) => {
    reads.count += 1
    const text = disk.get(norm(e.path))

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.stat', (_, e) => {
    const path = norm(e.path)
    if (!disk.has(path)) return { deny: 'ENOENT' }

    return {
      value: { kind: 'file', size: disk.get(path)!.length, mtimeMs: writtenAt.get(path) ?? 0, isLink: false },
    }
  })
  on('fs.write', (_, e) => {
    saved.set(norm(e.path), e.text)

    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    processes.count += 1
    const [command, ...rest] = e.argv
    // An editor started detached: recorded, and it starts
    if (command === 'powershell' || command === 'sh') {
      launched.push({ argv: [...e.argv], env: { ...e.init?.env } })

      return ran(0)
    }
    const isLockFree = rest[0] === '--no-optional-locks'
    const [verb, target] = isLockFree ? rest.slice(1) : rest
    if (repo === undefined || command !== 'git') return ran(128)
    // Asked from wherever the session's cwd stands, a nested repository answers for itself
    if (verb === 'rev-parse') {
      const at = e.init?.cwd ?? cwd
      const isNested = repo.nested !== undefined && (at === repo.nested || at.startsWith(repo.nested + '\\'))

      return ran(0, `${isNested ? repo.nested!.replace(/\\/g, '/') : 'C:/proj'}\n`)
    }
    // A scan must never take the index lock a commit running beside it needs
    if ((verb === 'status' || verb === 'ls-files' || verb === 'diff') && !isLockFree) return ran(128)
    const inProject = [...disk.keys()].filter(path => path.startsWith('C:\\proj\\'))
    if (verb === 'status') {
      scans.count += 1
      const renamed = repo.renamed ?? {}
      const sources = new Set(Object.values(renamed))
      const onDisk = inProject
        .filter(path => repo.head[relOf(path)] !== disk.get(path) && !isIgnored(relOf(path)))
        .filter(path => !(relOf(path) in renamed))
        .map(path => `${relOf(path) in repo.head ? ' M' : '??'} ${relOf(path)}\0`)
      // `-z` gives a rename as its new path, then its old one
      const moves = Object.entries(renamed).map(([to, from]) => `R  ${to}\0${from}\0`)
      const gone = Object.keys(repo.head)
        .filter(rel => !disk.has(`C:\\proj\\${rel.replace(/\//g, '\\')}`) && !sources.has(rel))
        .map(rel => ` D ${rel}\0`)

      return ran(0, [...onDisk, ...moves, ...gone].join(''))
    }
    // The lines added and removed since the commit, as `diff --numstat -z -M HEAD` gives them:
    // a rename's path empty, its old and new path after it; a file git doesn't track absent
    if (verb === 'diff') {
      const counted = (before: string, after: string) => {
        const { added, removed } = changesOf(diffLines(linesOf(before), linesOf(after)))

        return `${added}\t${removed}\t`
      }
      const onDiskAt = (rel: string) => disk.get(`C:\\proj\\${rel.replace(/\//g, '\\')}`)
      const renamed = repo.renamed ?? {}
      const sources = new Set(Object.values(renamed))
      const counts = Object.entries(repo.head)
        .filter(([rel, text]) => !sources.has(rel) && onDiskAt(rel) !== text)
        .map(([rel, text]) => `${counted(text, onDiskAt(rel) ?? '')}${rel}\0`)
      const moves = Object.entries(renamed).map(
        ([to, from]) => `${counted(repo.head[from] ?? '', onDiskAt(to) ?? '')}\0${from}\0${to}\0`,
      )

      return ran(0, [...counts, ...moves].join(''))
    }
    if (verb === 'ls-files') {
      if (rest.includes('--ignored')) return ran(0, (repo.ignored ?? []).map(rel => `${rel}\0`).join(''))
      catalogs.count += 1
      const listed = inProject.map(relOf).filter(rel => !isIgnored(rel))

      return ran(0, listed.map(rel => `${rel}\0`).join(''))
    }
    const committed = repo.head[String(target).replace(/^HEAD:/, '')]
    if (verb === 'show' && repo.showDelay !== undefined) await clock.sleep(repo.showDelay)
    if (verb === 'show' && committed !== undefined) return ran(0, committed)

    return ran(128)
  })
  on('fs.list', (_, e) => {
    lists.count += 1
    const names = new Map<string, FsEntry['kind']>()
    for (const file of disk.keys()) {
      const dir = norm(e.path)
      if (!file.startsWith(dir + '\\')) continue
      const [name, ...rest] = file.slice(dir.length + 1).split('\\')
      if (name !== undefined) names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    const value: FsEntry[] = [...names].map(([name, kind]) => ({
      name,
      kind,
      size: 0,
      mtimeMs: 0,
      isLink: false,
    }))

    return { value }
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Edit') {
      const gate = gates.get(e.file_path)
      if (gate !== undefined) {
        gates.delete(e.file_path)
        gate.reached()
        await gate.open
      }
      const text = disk.get(e.file_path)
      if (text === undefined) return { deny: 'no such file' }
      touch(e.file_path, text.replace(e.old_string, e.new_string))

      return { result: 'ok' }
    }
    if (e.tool === 'Write') {
      const type = disk.has(e.file_path) ? 'update' : 'create'
      touch(e.file_path, e.content)

      return { result: { type } }
    }
    // A file that isn't there: the call fails, as the real tool's does
    if (e.tool === 'Read' && !disk.has(e.file_path)) return { deny: 'File does not exist.' }
    if (e.tool === 'Bash') {
      const write = /^write (\S+) ([\s\S]*)$/.exec(e.command)
      if (write !== null) touch(write[1]!, write[2]!)
      // In the background the call returns at once and the command goes on
      const background = e.run_in_background === true ? { backgroundTaskId: 'bg1' } : {}

      return { result: { stdout: '', stderr: '', interrupted: false, ...background } }
    }

    return { result: 'ok' }
  })

  return { clock, scans, lists, reads, processes, catalogs, hold, touch, launched, saved }
}

// How an editor starts on Windows: Start-Process, the launcher and its arguments in variables
const START = 'Start-Process -FilePath $env:CANOPY_EXE -ArgumentList $env:CANOPY_ARGS -ErrorAction Stop'
const started = (exe: string, args: string) => ({
  argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', START],
  env: { CANOPY_EXE: exe, CANOPY_ARGS: args },
})

const done = (turnId: string, durationMs = 1000) => ({
  turnId,
  answer: '',
  durationMs,
  isAborted: false,
  reason: 'answer' as const,
})

// The lists as the person meets them: Buttons on the terminal, the Client's
// coloured rows on a desktop, clicked where they are drawn
const listOf = (ui: Mounted<Surface, 'Pane'>, surface: Surface) => ({
  row: (text: RegExp) =>
    ui.find({ type: 'Text', text, ...(surface === 'desktop' ? { in: 'tree' } : {}) }),
  // The name alone (an anchored pattern: a string matches within the row too),
  // where the row's own styles sit: strikethrough, underline
  name: (text: RegExp) =>
    ui.find({ type: 'Text', text, ...(surface === 'desktop' ? { in: 'tree' } : {}) }),
  click: async (key: string, name: string) => {
    if (surface === 'terminal') {
      await ui.press({ key })

      return
    }
    const client = await ui.find({ type: 'Client' })
    const rows = (client?.props.props as { rows: { t: string }[] }).rows
    const y = rows.findIndex(row => row.t.trim().replace(/^[▸▾] /, '') === name)
    expect(y).toBeGreaterThan(-1)
    await ui.pointer({ type: 'down', x: 1, y, button: 'left', in: 'tree' })
  },
})

// A TypeScript file's badge, as the rows carry it
const TS_BADGE = ['TS', '#4a8fe0']

// The tinted row and the lit one, as tree.tsx paints them
const SELECTED = '#4c8dff33'
const HOVER = '#8080801f'

test('the tree colours the files a turn changed and opens a folder that holds one', IT, async ($, on) => {
  const { clock } = project(on, {
    'C:\\proj\\README.md': '# proj\n',
    'C:\\proj\\src\\login.ts': 'a\nb\nc\n',
    'C:\\proj\\docs\\notes.md': 'x\n',
  })

  await $.turn.start({ text: 'sistema il login', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\src\\login.ts' })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'C:\\proj\\src\\login.ts',
    old_string: 'b',
    new_string: 'B',
  })
  await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\src\\auth.ts', content: 'export {}\n' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\README.md' })
  await $.turn.complete(done('t1', 32000))
  // Each file's lines are counted a moment later, off every path
  await clock.advance(300)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    expect(await ui.find({ type: 'Text', text: 'Turno 1' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /32s/ }))?.text).toBe('· 32s')
    expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('success')

    // The summary: how many files, their lines added and removed, what else the turn did
    expect(await ui.find({ type: 'Text', text: '2 file' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '+2' }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: '−1' }))?.props.color).toBe('error')
    expect(await list.row(/Modifiche/)).toBeDefined()
    // A new file says so in words, beside its folder
    expect(await list.row(/src · nuovo/)).toBeDefined()

    // The name itself carries the colour, as an IDE's tree does
    expect((await list.row(/login\.ts/))?.props.color).toBe('suggestion')
    expect((await list.row(/auth\.ts/))?.props.color).toBe('success')
    expect((await list.row(/README\.md/))?.props.color).toBeUndefined()
    expect((await list.row(/▾ src/))?.props.color).toBe('suggestion')
    expect((await list.row(/▸ docs/))?.props.color).toBeUndefined()
    expect(await list.row(/notes\.md/)).toBeUndefined()

    await list.click('dir:c:/proj/docs', 'docs')
    expect(await list.row(/notes\.md/)).toBeDefined()
    await ui.press({ key: 'collapse' })
    expect(await list.row(/notes\.md/)).toBeUndefined()
    await ui.unmount()
  }
})

test('a desktop draws its lists in a Client: coloured names, counts, quiet chrome', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\src\\login.ts': 'a\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(300)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const client = await ui.find({ type: 'Client' })
  expect(client?.props.module).toBe('hooks/tree.tsx')
  expect((client?.props.props as { rows: unknown[] }).rows).toEqual([
    { t: 'Modifiche', c: '', k: 'g', n: '1', o: 1 },
    { t: 'login.ts', c: 'changed', k: 'f', i: 1, n: 'src', b: TS_BADGE, s: [1, 1] },
    { t: ' ', c: '', k: 'x' },
    { t: 'Progetto', c: '', k: 'g', n: 'C:/proj', o: 1 },
    { t: 'src', c: 'changed', k: 'd', m: '●', o: 1 },
    { t: 'login.ts', c: 'changed', k: 'f', d: 1, b: TS_BADGE, s: [1, 1] },
  ])
  // No Button among the rows: a native one would drop the colour
  expect(await ui.find({ key: 'file:c:/proj/src/login.ts' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('warning')
  // The guide and the chevron quiet, the lines added and removed at the row's end
  expect((await ui.find({ type: 'Text', text: /^│ {3}$/, in: 'tree' }))?.props.color).toBe('subtle')
  expect((await ui.find({ type: 'Text', text: /^▾ $/, in: 'tree' }))?.props.color).toBe('subtle')
  expect((await ui.find({ type: 'Text', text: /^ \+1$/, in: 'tree' }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^ −1$/, in: 'tree' }))?.props.color).toBe('error')
  await ui.unmount()
})

test('the project folds like a section, and folded it is not walked', IT, async ($, on) => {
  const { lists } = project(on, { 'C:\\proj\\src\\login.ts': 'a\n', 'C:\\proj\\README.md': '#\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    // A heading's row on a desktop, its Button on the terminal
    const fold = async (key: string, title: string) => {
      if (surface === 'terminal') return ui.press({ key })
      const rows = await rowsOf(ui as Mounted<'desktop', 'Pane'>)

      return ui.pointer({ type: 'down', x: 1, y: rows.findIndex(row => row.t === title), button: 'left', in: 'tree' })
    }
    expect(await list.row(/README\.md/)).toBeDefined()
    await fold('section:project', 'Progetto')
    expect(await list.row(/README\.md/)).toBeUndefined()

    // The change is still listed, and a drawing reads nothing of the project
    expect(await list.row(/login\.ts/)).toBeDefined()
    const before = lists.count
    await fold('section:changes', 'Modifiche')
    expect(await list.row(/login\.ts/)).toBeUndefined()
    expect(lists.count).toBe(before)

    await ui.press({ key: 'collapse' })
    expect(await list.row(/README\.md/)).toBeDefined()
    await ui.unmount()
  }
})

test('a file changed again in its turn is counted again', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\a.ts': 'one\ntwo\nthree\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'one', new_string: 'ONE' })
  await clock.advance(300)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await rowsOf(ui))[1]?.s).toEqual([1, 1])

  // Two edits before the count: one count, against the turn's start
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'two', new_string: 'TWO' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'three\n', new_string: 'three\nfour\n' })
  await clock.advance(300)
  expect((await rowsOf(ui))[1]?.s).toEqual([3, 2])
  expect(await ui.find({ type: 'Text', text: /^\+3$/ })).toBeDefined()
  await ui.unmount()
})

test('the keys move a selection, Enter opens, and the opened file stays tinted', IT, async ($, on) => {
  project(on, { 'C:\\proj\\src\\login.ts': 'a\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rowBoxes = async () => (await ui.findAll({ type: 'Box', in: 'tree' })).slice(1)

  await ui.key({ key: 'down', in: 'tree' })
  await ui.key({ key: 'down', in: 'tree' })
  expect((await rowBoxes())[1]?.props.backgroundColor).toBe(SELECTED)
  await ui.key({ key: 'return', in: 'tree' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-a\n+b')

  await ui.press({ key: 'back' })
  expect((await rowBoxes())[1]?.props.backgroundColor).toBe(SELECTED)

  // The heading folds the section
  await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'tree' })
  const rows = ((await ui.find({ type: 'Client' }))?.props.props as { rows: { t: string; o?: number }[] }).rows
  expect(rows[0]?.t).toBe('Modifiche')
  expect(rows[0]?.o).toBeUndefined()
  // Folded: the section lists nothing, while the tree still holds the file
  expect(rows.slice(0, 2).some(row => row.t === 'login.ts')).toBe(false)
  await ui.unmount()
})

test('the row under the pointer lights, and only an active one', IT, async ($, on) => {
  project(on, { 'C:\\proj\\src\\login.ts': 'a\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rowBoxes = async () => (await ui.findAll({ type: 'Box', in: 'tree' })).slice(1)
  const name = () => ui.find({ type: 'Text', text: /^login\.ts$/, in: 'tree' })

  await ui.pointer({ type: 'move', x: 3, y: 1, in: 'tree' })
  expect((await rowBoxes())[1]?.props.backgroundColor).toBe(HOVER)
  expect((await name())?.props.underline).toBe(true)

  // The space between the sections is no target: nothing lights there
  await ui.pointer({ type: 'move', x: 3, y: 2, in: 'tree' })
  expect((await rowBoxes()).some(box => box.props.backgroundColor !== undefined)).toBe(false)
  expect((await name())?.props.underline).toBeUndefined()

  await ui.pointer({ type: 'move', x: 3, y: 1, in: 'tree' })
  await ui.pointer({ type: 'leave', x: 3, y: 1, in: 'tree' })
  expect((await rowBoxes())[1]?.props.backgroundColor).toBeUndefined()
  await ui.unmount()
})

test('a narrow pane cuts every row to one line, the path from its start', IT, async ($, on) => {
  project(on, { 'C:\\proj\\very\\long\\folder\\name\\here\\file.ts': 'a\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'C:\\proj\\very\\long\\folder\\name\\here\\file.ts',
    old_string: 'a',
    new_string: 'b',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.resize({ columns: 30, rows: 30, in: 'tree' })
  const room = Math.floor(30 * 0.9) - 1
  const texts = await ui.findAll({ type: 'Text', in: 'tree' })
  expect(texts.length).toBeGreaterThan(0)
  for (const one of texts) expect(one.text.length).toBeLessThanOrEqual(room)
  expect((await ui.find({ type: 'Text', text: /file\.ts/, in: 'tree' }))?.text).toBe('  file.ts  …lder/name/here')

  // Wide again, nothing is cut
  await ui.resize({ columns: 120, rows: 30, in: 'tree' })
  expect((await ui.find({ type: 'Text', text: /file\.ts/, in: 'tree' }))?.text).toBe(
    '   TS  file.ts  very/long/folder/name/here',
  )
  await ui.unmount()
})

test('a file opens whole with the changes coloured, or only its changes', IT, async ($, on) => {
  const before = Array.from({ length: 20 }, (_, at) => `l${at + 1}`).join('\n') + '\n'
  project(on, { 'C:\\proj\\src\\login.ts': before })

  await $.turn.start({ text: 'cambia l10', turnId: 't1' })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'C:\\proj\\src\\login.ts',
    old_string: 'l10\n',
    new_string: 'L10\n',
  })
  await $.turn.complete(done('t1'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await listOf(ui, surface).click('chg:c:/proj/src/login.ts', 'login.ts')

    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    expect(String(code?.props.source).startsWith('@@ -1,20 +1,20 @@\n l1\n')).toBe(true)
    expect((await ui.find({ type: 'Text', text: '+1' }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: '−1' }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: /righe 10 · dal turno/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'login.ts' }))?.props.color).toBe('suggestion')
    expect(await ui.find({ type: 'Text', text: 'src' })).toBeDefined()
    // The prompt gives its line to the code
    expect(await ui.find({ type: 'Text', text: /cambia l10/ })).toBeUndefined()

    await ui.press({ key: 'view:hunks' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe(
      '@@ -7,7 +7,7 @@\n l7\n l8\n l9\n-l10\n+L10\n l11\n l12\n l13',
    )
    await ui.press({ key: 'view:full' })

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a file too large to draw whole shows its changes, cut to the room a drawing has', IT, async ($, on) => {
  // Some 190,000 characters: past what one drawing draws
  const big = Array.from({ length: 3000 }, (_, at) => `const line${at + 1} = 'a line long enough to fill the file'`).join('\n') + '\n'
  project(on, { 'C:\\proj\\big.ts': big })

  await $.turn.start({ text: 'una riga', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\big.ts', old_string: 'line1500 =', new_string: 'LINE1500 =' })
  await $.turn.complete(done('t1'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chg:c:/proj/big.ts' })
  // Its changes, still coloured, and no whole view to pick
  const code = await ui.find({ type: 'Code' })
  expect(code?.props.format).toBe('diff')
  expect(String(code?.props.source).startsWith('@@ -1497,7 +1497,7 @@')).toBe(true)
  expect(await ui.find({ key: 'view:full' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /troppo grande per mostrarlo intero: solo le modifiche/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /il resto delle modifiche/ })).toBeUndefined()
  await ui.press({ key: 'back' })

  // Every line rewritten: one change past the room, drawn up to it, its header counting what is drawn
  await $.turn.start({ text: 'riscrivi', turnId: 't2' })
  await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\big.ts', content: big.replace(/const /g, 'let ') })
  await $.turn.complete(done('t2'))
  await ui.press({ key: 'chg:c:/proj/big.ts' })
  const codes = await ui.findAll({ type: 'Code' })
  expect(codes.length).toBe(1)
  const source = String(codes[0]?.props.source)
  expect(source.length).toBeLessThanOrEqual(90_000)
  const [header, ...rows] = source.split('\n')
  const [, oldCount, newCount] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(header!) ?? []
  expect(Number(oldCount)).toBe(rows.filter(row => !row.startsWith('+')).length)
  expect(Number(newCount)).toBe(rows.filter(row => !row.startsWith('-')).length)
  expect(await ui.find({ type: 'Text', text: '… il resto delle modifiche non è mostrato qui' })).toBeDefined()
  await ui.unmount()
})

test('the arrows walk the changed files, and an earlier turn keeps its own diff', IT, async ($, on) => {
  project(on, { 'C:\\proj\\a.ts': 'x\n', 'C:\\proj\\b.ts': 'p\n' })

  await $.turn.start({ text: 'primo', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'x', new_string: 'y' })
  await $.turn.complete(done('t1'))
  await $.turn.start({ text: 'secondo', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'y', new_string: 'z' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\b.ts', old_string: 'p', new_string: 'q' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '· in corso…' })).toBeDefined()

    await listOf(ui, surface).click('chg:c:/proj/a.ts', 'a.ts')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-y\n+z')
    await ui.press({ key: 'chg:next' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-p\n+q')
    await ui.press({ key: 'chg:next' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-y\n+z')

    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: 'Turno 1' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-x\n+y')

    await ui.press({ key: 'next' })
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a refused edit is red, an unchanged file opens plain, and a subagent adds no turn', IT, async ($, on) => {
  project(on, { 'C:\\proj\\a.ts': 'uno\n' })

  await $.turn.start({ text: 'prova', turnId: 't1' })
  await $.turn.start({ text: 'cerca', turnId: 'sub', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\a.ts' })
  await $.tool.call({
    tool: 'Edit',
    file_path: 'C:\\proj\\b.ts',
    old_string: 'a',
    new_string: 'b',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    expect(await ui.find({ type: 'Text', text: 'Turno 1' })).toBeDefined()
    expect(await ui.find({ key: 'prev' })).toBeUndefined()
    expect((await list.row(/b\.ts/))?.props.color).toBe('error')
    // No lines to count: a mark at the row's end, and the word beside it
    expect((await list.row(/^ ?!$/))?.props.color).toBe('error')
    expect(await list.row(/non riuscito/)).toBeDefined()

    await list.click('file:c:/proj/a.ts', 'a.ts')
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBeUndefined()
    expect(code?.props.source).toBe('uno')
    expect(await ui.find({ type: 'Text', text: 'non modificato in questo turno' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('what Claude only reads or searches leaves no trace, and draws nothing again', IT, async ($, on) => {
  project(on, { 'C:\\proj\\docs\\notes.md': 'x\n', 'C:\\proj\\a.ts': 'x\n' })
  // The turns as written: a read or a search writes nothing, so nothing is drawn again
  let written = 0
  on('state.set', { plugin: 'canopy', key: 'history' }, (_, e, next) => {
    written += 1

    return next(e)
  })

  await $.turn.start({ text: 'leggi', turnId: 't1' })
  const before = written
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\docs\\notes.md' })
  // One that fails, too: no file there
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\config\\local.json' })
  await $.tool.call({ tool: 'Grep', pattern: 'x' })
  await $.tool.call({ tool: 'Glob', pattern: '*.ts' })
  expect(written).toBe(before)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    // No folder opened for a read, no word, no count, no failure
    expect(await list.row(/▸ docs/)).toBeDefined()
    expect(await list.row(/notes\.md/)).toBeUndefined()
    expect(await list.row(/local\.json/)).toBeUndefined()
    expect(await list.row(/^ ?!$/)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /lett[oi]/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Nessun file modificato in questo turno.' })).toBeDefined()
    await ui.unmount()
  }
})

test('a shell command returns before git is asked, and a burst asks it once', IT, async ($, on) => {
  const { clock, scans } = project(
    on,
    { 'C:\\proj\\README.md': '# proj\n', 'C:\\proj\\src\\login.ts': 'a\nb\nc\n' },
    { head: { 'README.md': '# proj\n', 'src/login.ts': 'a\nb\nc\n' } },
  )

  // The turn's start is read once, off the path, while the model thinks
  await $.turn.start({ text: 'sed', turnId: 't1' })
  expect(scans.count).toBe(0)
  await clock.advance(1)
  expect(scans.count).toBe(1)

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'git diff' })
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\src\\login.ts a\nB\nc\n' })
  expect(scans.count).toBe(1)
  await clock.advance(400)
  expect(scans.count).toBe(2)
  // What the command changed is counted a moment after the scan found it
  await clock.advance(300)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^−1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· 3 comandi' })).toBeDefined()
    expect((await list.row(/▾ src/))?.props.color).toBe('suggestion')
    expect((await list.row(/login\.ts/))?.props.color).toBe('suggestion')
    expect((await list.row(/README\.md/))?.props.color).toBeUndefined()

    // Clean as the turn began, so its commit is where the turn started from
    await list.click('chg:c:/proj/src/login.ts', 'login.ts')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
    expect(await ui.find({ type: 'Text', text: /righe 2 · dal turno/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /modificato da un comando/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('files unknown to git: one changed diffs from the turn, one made is new', IT, async ($, on) => {
  const { clock } = project(
    on,
    { 'C:\\proj\\README.md': '#\n', 'C:\\proj\\notes.txt': 'x\n' },
    { head: { 'README.md': '#\n' } },
  )

  await $.turn.start({ text: 'appunti', turnId: 't1' })
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\notes.txt y\n' })
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\fresh.txt z\n' })
  await clock.advance(400)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    expect((await list.row(/notes\.txt/))?.props.color).toBe('suggestion')
    expect((await list.row(/fresh\.txt/))?.props.color).toBe('success')

    await list.click('chg:c:/proj/notes.txt', 'notes.txt')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-x\n+y')
    expect(await ui.find({ type: 'Text', text: /dal turno/ })).toBeDefined()
    await ui.press({ key: 'chg:prev' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1,1 @@\n+z')
    expect(await ui.find({ type: 'Text', text: /creato da un comando/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /file nuovo/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('outside a git repository a shell command marks nothing', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\a.ts': 'x\n' })

  await $.turn.start({ text: 'sed', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\a.ts y\n' })
  await $.turn.complete(done('t1'))
  await clock.advance(400)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '1 comando' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Nessun file modificato in questo turno.' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /a\.ts/, in: 'tree' }))?.props.color).toBeUndefined()
  await ui.unmount()
})

test('since the last commit: modified blue, unknown to git orange, deleted struck through', IT, async ($, on) => {
  project(
    on,
    { 'C:\\proj\\src\\login.ts': 'a\nB\n', 'C:\\proj\\src\\new.ts': 'n\n', 'C:\\proj\\README.md': '#\n' },
    { head: { 'src/login.ts': 'a\nb\n', 'src/old.ts': 'o\n', 'README.md': '#\n' } },
  )

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    await ui.press({ key: 'mode:commit' })
    // The lines git counts since the commit: the file it doesn't track has none
    expect(await ui.find({ type: 'Text', text: '3 file' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^−2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'dall’ultimo commit' })).toBeDefined()
    expect(await list.row(/src · non in git/)).toBeDefined()
    expect(await list.row(/src · eliminato/)).toBeDefined()
    expect((await list.row(/login\.ts/))?.props.color).toBe('suggestion')
    expect((await list.row(/new\.ts/))?.props.color).toBe('warning')
    expect((await list.name(/^old\.ts$/))?.props.strikethrough).toBe(true)
    expect((await list.row(/README\.md/))?.props.color).toBeUndefined()

    await list.click('chg:c:/proj/src/login.ts', 'login.ts')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+B')
    await ui.press({ key: 'chg:next' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1,1 @@\n+n')
    await ui.press({ key: 'chg:next' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +0,0 @@\n-o')
    await ui.press({ key: 'back' })

    await ui.press({ key: 'mode:turn' })
    expect(await list.row(/new\.ts/)).toBeUndefined()
    await ui.unmount()
  }
})

test('since the last commit, a renamed file diffs against its old path', IT, async ($, on) => {
  project(
    on,
    { 'C:\\proj\\src\\new-name.ts': 'a\nB\nc\n' },
    { head: { 'src/old-name.ts': 'a\nb\nc\n' }, renamed: { 'src/new-name.ts': 'src/old-name.ts' } },
  )

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    await ui.press({ key: 'mode:commit' })
    expect(await list.row(/src · rinominato/)).toBeDefined()
    // Counted against the old path: one line changed, not a whole file added
    expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^−1$/ })).toBeDefined()
    // The old path is gone with the rename: no deleted file beside it
    expect(await list.row(/eliminat/)).toBeUndefined()

    await list.click('chg:c:/proj/src/new-name.ts', 'new-name.ts')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
    expect(await ui.find({ type: 'Text', text: /file nuovo/ })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'mode:turn' })
    await ui.unmount()
  }
})

test("the tree's root is the project, wherever a shell cd left the cwd", IT, async ($, on) => {
  project(on, { 'C:\\proj\\src\\login.ts': 'a\n', 'C:\\proj\\README.md': '#\n' }, undefined, 'C:\\proj\\src')
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:\\proj\\src', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^▾ Progetto · C:\/proj$/, in: 'tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /README\.md/, in: 'tree' })).toBeDefined()
  await ui.unmount()
})

// ---- Canopy 1.0 ----

type Row = {
  t: string
  c: string
  k: string
  d?: number
  i?: number
  m?: string
  n?: string
  s?: [number, number]
  b?: [string, string]
  o?: number
  h?: [number, number]
}
const rowsOf = async (ui: Mounted<'desktop', 'Pane'>) =>
  ((await ui.find({ type: 'Client' }))?.props.props as { rows: Row[] }).rows

// The engine beneath a session's start: the command, the pane, the folder
const sessionEngine = (on: On) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('the pane speaks English unless told otherwise', async ($, on) => {
  project(on, { 'C:\\proj\\src\\login.ts': 'a\n' })

  await $.turn.start({ text: 'change it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete(done('t1', 5000))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Turn 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '· 5s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
  expect((await rowsOf(ui)).filter(row => row.k === 'g').map(row => row.t)).toEqual(['Changes', 'Project'])
  expect((await ui.find({ key: 'mode:commit' }))?.text).toBe('Commit')
  expect((await ui.find({ key: 'search' }))?.props.placeholder).toBe('Search files…')
  await ui.unmount()
})

test('the search finds files by every word, marks the match, and Enter opens the best', IT, async ($, on) => {
  const { clock } = project(
    on,
    {
      'C:\\proj\\src\\login.ts': 'a\n',
      'C:\\proj\\src\\auth\\session.ts': 's\n',
      'C:\\proj\\README.md': '#\n',
    },
    { head: { 'src/login.ts': 'a\n', 'src/auth/session.ts': 's\n', 'README.md': '#\n' } },
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'search', text: 'log', kind: 'change' })
  // The catalogue is listed off the drawing, once
  expect((await rowsOf(ui))[0]?.t).toBe('Indicizzo il progetto…')
  await clock.advance(1)
  expect(await rowsOf(ui)).toEqual([
    { t: '1 file', c: '', k: 'x' },
    { t: 'src', c: '', k: 'd', o: 1 },
    { t: 'login.ts', c: '', k: 'f', d: 1, b: TS_BADGE, h: [0, 3] },
  ])
  // The match is marked where it is
  expect((await ui.find({ type: 'Text', text: /^log$/, in: 'tree' }))?.props.bold).toBe(true)

  // A folder holding only a folder reads as one, as an IDE's compact folders
  await ui.input({ key: 'search', text: 'sess', kind: 'change' })
  expect((await rowsOf(ui)).map(row => row.t)).toEqual(['1 file', 'src/auth', 'session.ts'])
  await ui.input({ key: 'search', text: 'nothing here', kind: 'change' })
  expect((await rowsOf(ui))[0]?.t).toBe('Nessun file corrisponde a “nothing here”.')

  // Enter opens the best match; back, the search is still there
  await ui.input({ key: 'search', text: 'login' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('a')
  await ui.press({ key: 'back' })
  expect((await ui.find({ key: 'search' }))?.props.value).toBe('login')

  // A folder found is shown in the tree, open, and the search cleared
  await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'tree' })
  expect((await ui.find({ key: 'search' }))?.props.value).toBe('')
  const rows = await rowsOf(ui)
  expect(rows.some(row => row.t === 'src' && row.k === 'd' && row.o === 1)).toBe(true)
  expect(rows.some(row => row.t === 'login.ts' && row.d === 1)).toBe(true)
  await ui.unmount()

  // The terminal: the same results, Buttons that open
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.input({ key: 'search', text: 'sess', kind: 'change' })
  await term.press({ key: 'file:c:/proj/src/auth/session.ts' })
  expect((await term.find({ type: 'Code' }))?.props.source).toBe('s')
  await term.press({ key: 'back' })
  await term.press({ key: 'search:clear' })
  expect(await term.find({ key: 'search:clear' })).toBeUndefined()
  await term.unmount()
})

test('git is asked from the project, even with the cwd in a repository of its own', IT, async ($, on) => {
  // A shell `cd` left the session in a nested repository: the project's is still the one
  const { clock } = project(
    on,
    { 'C:\\proj\\src\\login.ts': 'a\n', 'C:\\proj\\vendor\\lib\\index.js': 'x\n' },
    { head: { 'src/login.ts': 'a\n', 'vendor/lib/index.js': 'x\n' }, nested: 'C:\\proj\\vendor\\lib' },
    'C:\\proj\\vendor\\lib',
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'search', text: 'login', kind: 'change' })
  await clock.advance(1)
  expect((await rowsOf(ui)).map(row => row.t)).toEqual(['1 file', 'src', 'login.ts'])
  await ui.unmount()
})

test('what git ignores is dimmed, never opened by itself', IT, async ($, on) => {
  const { clock } = project(
    on,
    {
      'C:\\proj\\src\\a.ts': 'a\n',
      'C:\\proj\\logs\\today.log': 'x\n',
      'C:\\proj\\.env': 'KEY=1\n',
    },
    { head: { 'src/a.ts': 'a\n' }, ignored: ['logs/', '.env'] },
  )

  await $.turn.start({ text: 'guarda', turnId: 't1' })
  await $.turn.complete(done('t1'))
  // The scan at the turn's end lists the catalogue too
  await clock.advance(1)
  await clock.advance(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rows = await rowsOf(ui)
  expect(rows.find(row => row.t === 'logs' && row.k === 'd')?.c).toBe('heavy')
  expect(rows.find(row => row.t === '.env')?.c).toBe('heavy')
  expect(rows.find(row => row.t === 'src' && row.k === 'd')?.c).toBe('')
  await ui.unmount()
})

test('a change made outside Claude’s tools waits in its own folded section', IT, async ($, on) => {
  const { clock, touch } = project(
    on,
    { 'C:\\proj\\a.ts': 'x\n', 'C:\\proj\\b.ts': 'p\n' },
    { head: { 'a.ts': 'x\n', 'b.ts': 'p\n' } },
  )

  await $.turn.start({ text: 'sed', turnId: 't1' })
  await clock.advance(1)
  // Claude's command writes a.ts; seconds later something else writes b.ts
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\a.ts y\n' })
  await clock.advance(5000)
  touch('C:\\proj\\b.ts', 'q\n')
  await $.turn.complete(done('t1'))
  await clock.advance(1)
  await clock.advance(300)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 altra modifica/ })).toBeDefined()

    if (ui.surface === 'desktop') {
      const desk = ui as Mounted<'desktop', 'Pane'>
      const rows = await rowsOf(desk)
      expect(rows.slice(0, 3)).toEqual([
        { t: 'Modifiche', c: '', k: 'g', n: '1', o: 1 },
        { t: 'a.ts', c: 'changed', k: 'f', i: 1, b: TS_BADGE, s: [1, 1] },
        { t: 'Altre modifiche', c: '', k: 'g', n: '1' },
      ])
      // In the tree it reads dimmed, its counts too
      expect(rows.find(row => row.t === 'b.ts')).toEqual({ t: 'b.ts', c: 'outside', k: 'f', b: TS_BADGE, s: [1, 1] })
      // Its section opens on a click, and the file with the next
      await ui.pointer({ type: 'down', x: 1, y: 2, button: 'left', in: 'tree' })
      expect((await rowsOf(desk))[3]).toEqual({ t: 'b.ts', c: 'outside', k: 'f', i: 1, b: TS_BADGE, s: [1, 1] })
      await ui.pointer({ type: 'down', x: 1, y: 3, button: 'left', in: 'tree' })
    } else {
      await ui.press({ key: 'section:others' })
      await ui.press({ key: 'chg:c:/proj/b.ts' })
    }
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-p\n+q')
    expect(await ui.find({ type: 'Text', text: /fuori dalle modifiche e dai comandi di Claude/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'collapse' })
    await ui.unmount()
  }
})

test('a command left running in the background is Claude’s until its turn ends', IT, async ($, on) => {
  const { clock, touch } = project(
    on,
    { 'C:\\proj\\a.ts': 'x\n', 'C:\\proj\\b.ts': 'p\n' },
    { head: { 'a.ts': 'x\n', 'b.ts': 'p\n' } },
  )

  await $.turn.start({ text: 'avvia il watcher', turnId: 't1' })
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'npm run watch', run_in_background: true })
  // What the command writes seconds after its call returned
  await clock.advance(5000)
  touch('C:\\proj\\a.ts', 'y\n')
  await $.turn.complete(done('t1'))
  await clock.advance(1)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /altra modifica/ })).toBeUndefined()
    expect((await listOf(ui, surface).row(/a\.ts/))?.props.color).toBe('suggestion')
    await ui.unmount()
  }

  // The next turn runs no command: a write then is someone else's
  await $.turn.start({ text: 'altro', turnId: 't2' })
  await clock.advance(5000)
  touch('C:\\proj\\b.ts', 'q\n')
  await $.turn.complete(done('t2'))
  await clock.advance(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 altra modifica/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\d+ file$/ })).toBeUndefined()
  await ui.unmount()
})

test('IntelliJ, found by itself, opens the file at its change and diffs the turn', IT, async ($, on) => {
  const idea = 'C:\\Users\\me\\AppData\\Local\\Programs\\IntelliJ IDEA Ultimate\\bin\\idea64.exe'
  const before = Array.from({ length: 20 }, (_, at) => `l${at + 1}`).join('\n') + '\n'
  const { clock, launched, saved } = project(on, { 'C:\\proj\\src\\login.ts': before, [idea]: '' })
  mock.env(on, { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', TEMP: 'C:\\Temp' })
  sessionEngine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'l12\n', new_string: 'L12\n' })
  await $.turn.complete(done('t1'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await listOf(ui as Mounted<Surface, 'Pane'>, 'desktop').click('chg:c:/proj/src/login.ts', 'login.ts')
  expect(await ui.find({ key: 'editor:open' })).toBeDefined()

  await ui.press({ key: 'editor:open' })
  expect(launched.at(-1)).toEqual(started(idea, '"--line" "12" "C:\\proj\\src\\login.ts"'))

  // The turn's own diff: the file as the turn found it, beside the file now
  await ui.press({ key: 'editor:compare' })
  const left = [...saved.keys()].find(path => path.endsWith('login (prima del turno).ts'))
  expect(left?.startsWith('C:\\Temp\\canopy\\')).toBe(true)
  expect(saved.get(left!)).toBe(before)
  expect(launched.at(-1)).toEqual(started(idea, `"diff" "${left}" "C:\\proj\\src\\login.ts"`))

  // Only the changes: each block names its lines and opens there
  await ui.press({ key: 'view:hunks' })
  expect(await ui.find({ type: 'Text', text: 'Righe 9–15' })).toBeDefined()
  await ui.press({ key: 'hunk:open:0' })
  expect(launched.at(-1)?.env.CANOPY_ARGS).toBe('"--line" "12" "C:\\proj\\src\\login.ts"')
  await ui.unmount()
})

test('a name with the characters cmd reads reaches the editor whole, through no shell', IT, async ($, on) => {
  const idea = 'C:\\Users\\me\\AppData\\Local\\Programs\\IntelliJ IDEA Ultimate\\bin\\idea64.exe'
  const path = 'C:\\proj\\R&D\\50%^off&calc.ts'
  const { clock, launched } = project(on, { [path]: 'a\n', [idea]: '' })
  mock.env(on, { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', TEMP: 'C:\\Temp' })
  sessionEngine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1)

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chg:c:/proj/r&d/50%^off&calc.ts' })
  await ui.press({ key: 'editor:open' })
  // The path is in a variable, quoted for the launcher's own parser; nothing on the command line holds it
  expect(launched.at(-1)).toEqual(started(idea, `"--line" "1" "${path}"`))
  expect(launched.at(-1)?.argv.some(arg => /[&%^]/.test(arg))).toBe(false)
  await ui.unmount()
})

const VSCODE_SCRIPT = { options: { language: 'it', editorPath: 'C:\\VS Code\\bin\\code.cmd' } }

test('a script launcher runs hidden, and the quoting keeps a trailing backslash its own', VSCODE_SCRIPT, async ($, on) => {
  const code = 'C:\\VS Code\\bin\\code.cmd'
  const { clock, launched } = project(on, { 'C:\\proj\\a.ts': 'x\n' })
  mock.env(on, { OS: 'Windows_NT' })
  sessionEngine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1)

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'x', new_string: 'y' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chg:c:/proj/a.ts' })
  await ui.press({ key: 'editor:open' })
  expect(launched.at(-1)?.argv.at(-1)).toBe(`${START} -WindowStyle Hidden`)
  expect(launched.at(-1)?.env).toEqual({ CANOPY_EXE: code, CANOPY_ARGS: '"--goto" "C:\\proj\\a.ts:1"' })
  await ui.unmount()

  expect(quoteArg('C:\\dir\\')).toBe('"C:\\dir\\\\"')
  expect(quoteArg('a\\"b')).toBe('"a\\\\\\"b"')
})

test('with no editor found, nothing offers one; the command leaves no line for the model', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\a.ts': 'x\n' })
  mock.env(on, { OS: 'Windows_NT' })
  sessionEngine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'x', new_string: 'y' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chg:c:/proj/a.ts' })
  expect(await ui.find({ key: 'editor:open' })).toBeUndefined()
  await ui.unmount()

  const ran = await $.command.run({
    command: 'canopy',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(ran.text).toBeUndefined()
})

// The menu's line for /canopy, as the engine asks for it
const describeCanopy = {
  command: 'canopy',
  description: '',
  isHidden: false,
  immediate: false,
  provider: { plugin: 'canopy', tier: 'user' },
} as const

test('the command reads in English in the menu by default', async ($, on) => {
  on('command.describe', (_, e) => ({ description: e.description, isHidden: e.isHidden }))
  expect((await $.command.describe(describeCanopy)).description).toBe(
    'Show the project tree with the files Claude reads and changes, turn by turn',
  )
})

test('and in Italian when the pane speaks Italian', IT, async ($, on) => {
  on('command.describe', (_, e) => ({ description: e.description, isHidden: e.isHidden }))
  expect((await $.command.describe(describeCanopy)).description).toBe(
    'Mostra l’albero del progetto con i file che Claude legge e modifica, turno per turno',
  )
})

// ---- Found in review ----

test('the commit view outside a repository asks git once, not on every drawing', IT, async ($, on) => {
  const { clock, processes } = project(on, { 'C:\\proj\\a.ts': 'x\n' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:commit' })
  for (let at = 0; at < 10; at += 1) await clock.advance(50)
  expect(await ui.find({ type: 'Text', text: 'Qui non c’è un repository git.' })).toBeDefined()
  const settled = processes.count
  for (let at = 0; at < 10; at += 1) await clock.advance(50)
  expect(processes.count).toBe(settled)
  expect(settled).toBeLessThan(10)
  await ui.unmount()
})

test('a binary file a command writes is listed, neither counted nor diffed', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\README.md': '#\n' }, { head: { 'README.md': '#\n' } })

  await $.turn.start({ text: 'genera il logo', turnId: 't1' })
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\logo.png \u0000PNG\u0001\u0002' })
  await $.turn.complete(done('t1'))
  await clock.advance(1)
  await clock.advance(300)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await rowsOf(ui)).find(one => one.t === 'logo.png' && one.i === 1)
  expect(row?.c).toBe('created')
  expect(row?.s).toBeUndefined()
  await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'tree' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'File troppo grande o illeggibile per mostrarlo qui.' })).toBeDefined()
  await ui.unmount()
})

test('a turn leaving the history takes its texts along, a refused edit’s too', { options: { language: 'it', turns: '5' } }, async ($, on) => {
  project(on, { 'C:\\proj\\a.ts': 'x\n' })
  // The texts kept for a turn's diffs as they are written: emptied, they are gone
  const kept = new Map<string, unknown>()
  on('state.set', { plugin: 'canopy', key: 'snapshot' }, (_, e, next) => {
    if (e.id !== undefined) kept.set(e.id, e.value)

    return next(e)
  })

  await $.turn.start({ text: 'primo', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\b.ts', old_string: 'p', new_string: 'q' })
  await $.turn.complete(done('t1'))
  expect(kept.get('t1|c:/proj/a.ts')).not.toEqual({})
  expect(kept.get('t1|c:/proj/b.ts')).toEqual({ before: { kind: 'missing' } })

  // Five turns kept: the sixth pushes the first out
  for (const turnId of ['t2', 't3', 't4', 't5']) {
    await $.turn.start({ text: turnId, turnId })
    await $.turn.complete(done(turnId))
  }
  expect(kept.get('t1|c:/proj/b.ts')).toEqual({ before: { kind: 'missing' } })
  await $.turn.start({ text: 't6', turnId: 't6' })
  expect(kept.get('t1|c:/proj/a.ts')).toEqual({})
  expect(kept.get('t1|c:/proj/b.ts')).toEqual({})
})

test('a call that ends after a new turn began stays with the turn it began in', IT, async ($, on) => {
  const { hold } = project(on, { 'C:\\proj\\a.ts': 'x\n' })

  await $.turn.start({ text: 'primo', turnId: 't1' })
  // A subagent left running: its edit is under way as the turn ends and the next begins
  const gate = hold('C:\\proj\\a.ts')
  const call = $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'x', new_string: 'y' })
  await gate.isReached
  await $.turn.complete(done('t1'))
  await $.turn.start({ text: 'secondo', turnId: 't2' })
  gate.release()
  await call

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Nessun file modificato in questo turno.' })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: 'Turno 1' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^a\.ts$/ }))?.props.color).toBe('suggestion')
  // Settled: no row left running
  expect(await ui.find({ type: 'Text', text: /in corso/ })).toBeUndefined()
  await ui.unmount()
})

test('the commit view keeps its counts as a new turn begins', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\a.ts': 'x\nY\n' }, { head: { 'a.ts': 'x\ny\n' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:commit' })
  expect(await ui.find({ type: 'Text', text: /^\+1$/ })).toBeDefined()

  // The turn's start reads git again, off the prompt's path
  await $.turn.start({ text: 'altro', turnId: 't1' })
  await clock.advance(1)
  expect(await ui.find({ type: 'Text', text: /^\+1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^−1$/ })).toBeDefined()
  await ui.unmount()
})

test('a file a command left alone since its last count is not read again', IT, async ($, on) => {
  const { clock, reads } = project(on, { 'C:\\proj\\a.ts': 'x\n' }, { head: { 'a.ts': 'x\n' } })

  await $.turn.start({ text: 'sed', turnId: 't1' })
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\a.ts y\n' })
  await clock.advance(400)
  await clock.advance(300)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await rowsOf(ui))[1]?.s).toEqual([1, 1])

  // Another command writes nothing: its scan counts nothing again
  const before = reads.count
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(400)
  await clock.advance(300)
  expect(reads.count).toBe(before)

  // Written again: counted again
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\a.ts y\nz\n' })
  await clock.advance(400)
  await clock.advance(300)
  expect((await rowsOf(ui))[1]?.s).toEqual([2, 1])
  await ui.unmount()
})

test('away from Windows a name with a quote still reaches the editor', { options: { language: 'it', editorPath: '/usr/local/bin/code' } }, async ($, on) => {
  const path = 'C:\\proj\\say "hi".ts'
  const { clock, launched } = project(on, { [path]: 'a\n' })
  mock.env(on, {})
  sessionEngine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1)

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chg:c:/proj/say "hi".ts' })
  await ui.press({ key: 'editor:open' })
  expect(launched.at(-1)?.argv.slice(-3)).toEqual(['/usr/local/bin/code', '--goto', `${path}:1`])
  await ui.unmount()
})

// ---- A launcher script and the program it starts ----

// VS Code's own `bin\code.cmd`: it only starts Code.exe beside it
const CODE_CMD = [
  '@echo off',
  'setlocal',
  'set VSCODE_DEV=',
  'set ELECTRON_RUN_AS_NODE=1',
  '"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*',
  'IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%',
  'endlocal',
].join('\r\n')

// Opens `path` in the editor the options name, and says what was started and what the person was told
const openWith = async ($: Parameters<TestBody>[0], on: On, files: Record<string, string>, path: string) => {
  const { clock, launched } = project(on, { [path]: 'a\n', ...files })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  mock.env(on, { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
  sessionEngine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `chg:${path.replace(/\\/g, '/').toLowerCase()}` })
  await ui.press({ key: 'editor:open' })
  await ui.unmount()

  return { launched, toasts }
}

const SCRIPT = (script: string) => ({ options: { language: 'it', editorPath: script } })

test('VS Code’s code.cmd is passed by: Code.exe starts, a % in a name stays a character', SCRIPT('C:\\VS Code\\bin\\code.cmd'), async ($, on) => {
  const path = 'C:\\proj\\100%USERNAME%.ts'
  const { launched, toasts } = await openWith($, on, { 'C:\\VS Code\\bin\\code.cmd': CODE_CMD, 'C:\\VS Code\\Code.exe': '' }, path)

  expect(launched.at(-1)).toEqual(started('C:\\VS Code\\Code.exe', `"--goto" "${path}:1"`))
  expect(toasts).toEqual([])
})

test('a Toolbox script naming its IDE under %LOCALAPPDATA% starts that IDE itself', SCRIPT('C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd'), async ($, on) => {
  const idea = 'C:\\Users\\me\\AppData\\Local\\Programs\\IntelliJ IDEA\\bin\\idea64.exe'
  const script = '@ECHO OFF\r\nstart "" "%LOCALAPPDATA%\\Programs\\IntelliJ IDEA\\bin\\idea64.exe" %*\r\n'
  const path = 'C:\\proj\\wow!.ts'
  const { launched, toasts } = await openWith(
    $,
    on,
    { 'C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd': script, [idea]: '' },
    path,
  )

  expect(launched.at(-1)).toEqual(started(idea, `"--line" "1" "${path}"`))
  expect(toasts).toEqual([])
})

test('a script whose program can’t be found is refused a name it would misread, and says so', SCRIPT('C:\\Tools\\code.cmd'), async ($, on) => {
  // The script names its program through a variable Canopy doesn't read: it stays the launcher
  const script = '@echo off\r\n"%MY_TOOLS%\\Code.exe" %*\r\n'
  const { launched, toasts } = await openWith($, on, { 'C:\\Tools\\code.cmd': script }, 'C:\\proj\\50%off.ts')

  expect(launched).toEqual([])
  expect(toasts).toEqual([
    'VS Code si avvia tramite uno script che leggerebbe male il nome di questo file. Indica il suo .exe come launcher nelle opzioni di Canopy.',
  ])
})

// ---- Badges ----

test('each file wears its type’s badge, by extension or by name', IT, async ($, on) => {
  const names = ['README.md', 'plugin.json', 'Dockerfile', '.gitignore', '.env.local', 'main.c', 'odd.constructor', 'NOTES']
  project(on, Object.fromEntries(names.map(name => [`C:\\proj\\${name}`, 'x\n'])))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const badges = Object.fromEntries((await rowsOf(ui)).filter(row => row.k === 'f').map(row => [row.t, row.b]))
  expect(badges).toEqual({
    'README.md': ['MD', '#8a8a8a'],
    'plugin.json': ['{}', '#e07b39'],
    Dockerfile: ['DK', '#4a8fe0'],
    '.gitignore': ['GI', '#e07b39'],
    '.env.local': ['EN', '#c9a227'],
    'main.c': ['C', '#4a8fe0'],
    // An extension Canopy doesn't know: its first letters, grey; nothing of Object's
    'odd.constructor': ['CO', '#8a8a8a'],
    // No extension: no badge, its room kept
    NOTES: undefined,
  })

  // Its letters a size under the name's, light, on a faint tint of their colour; a blank of the same room where there is none
  const chip = await ui.find({ type: 'Text', text: /^ MD $/, in: 'tree' })
  expect(chip?.props.color).toBe('#8a8a8a')
  expect(chip?.props.backgroundColor).toBe('#8a8a8a24')
  expect(chip?.props.size).toBe('caption')
  expect(chip?.props.weight).toBe('medium')
  expect(await ui.find({ type: 'Text', text: /^ C {2}$/, in: 'tree' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /NOTES/, in: 'tree' }))?.text).toBe('       NOTES')
  expect((await ui.find({ type: 'Text', text: /README/, in: 'tree' }))?.text).toBe('   MD  README.md')
  await ui.unmount()
})

test('a narrow pane gives the badges’ room to the names, on either surface', IT, async ($, on) => {
  project(on, { 'C:\\proj\\login.ts': 'a\n' })

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const chip = () => desk.find({ type: 'Text', text: /^ TS $/, in: 'tree' })
  expect(await chip()).toBeDefined()
  await desk.resize({ columns: 39, rows: 30, in: 'tree' })
  expect(await chip()).toBeUndefined()
  expect((await desk.find({ type: 'Text', text: /login/, in: 'tree' }))?.text).toBe('  login.ts')
  await desk.resize({ columns: 40, rows: 30, in: 'tree' })
  expect(await chip()).toBeDefined()
  await desk.unmount()

  // The terminal: letters in their colour, no tint; gone below 40 columns
  const wide = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await wide.find({ type: 'Text', text: /^TS$/ }))?.props.color).toBe('#4a8fe0')
  await wide.unmount()
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /^TS$/ })).toBeUndefined()
  expect(await narrow.find({ key: 'file:c:/proj/login.ts' })).toBeDefined()
  await narrow.unmount()
})

test('on a desktop the room before a name is monospaced, so the names start in one column', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\src\\login.ts': 'a\n', 'C:\\proj\\LICENSE': 'x\n', 'C:\\proj\\NOTES': 'n\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(300)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = await ui.findAll({ type: 'Text', in: 'tree' })
  const one = (pattern: RegExp) => texts.find(text => pattern.test(text.text))
  // A guide, a chevron, a section's indent, a file's lead and its badge: one width each, whatever the letters
  expect(one(/^│ {3}$/)?.props.mono).toBe(true)
  expect(one(/^▾ $/)?.props.mono).toBe(true)
  expect(texts.filter(text => text.text === '  ').every(text => text.props.mono === true)).toBe(true)
  // A badge is monospaced, its letters between two small spaces: the same width for every badge
  expect(texts.find(text => text.text === ' LI ')?.props.mono).toBe(true)
  expect(texts.find(text => text.text === ' TS ')?.props.mono).toBe(true)
  // A file with no badge keeps the same room, blank: two monospaced cells between the same spaces
  const blank = texts.find(text => text.text === '    ' && text.props.size === 'caption')
  expect(blank).toBeDefined()
  expect(blank?.props.backgroundColor).toBeUndefined()
  // The counts' digits are of one width
  expect(one(/^ \+1$/)?.props.tabular).toBe(true)
  expect(one(/^ −1$/)?.props.tabular).toBe(true)
  await ui.unmount()
})

// ---- Outside the project ----

test('what a turn wrote outside the project waits in its own folded section, out of the summary', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\a.ts': 'x\n' })

  await $.turn.start({ text: 'appunti', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Temp\\scratch\\notes.txt', content: 'uno\ndue\n' })
  await $.turn.complete(done('t1'))
  await clock.advance(300)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    // The summary counts the project alone, and names the rest
    expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+3$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '· 1 fuori dal progetto' })).toBeDefined()

    // Folded: its heading, not its file
    expect(await list.row(/Fuori dal progetto/)).toBeDefined()
    expect(await list.row(/notes\.txt/)).toBeUndefined()
    if (surface === 'desktop') {
      const rows = await rowsOf(ui as Mounted<'desktop', 'Pane'>)
      await ui.pointer({ type: 'down', x: 1, y: rows.findIndex(row => row.t === 'Fuori dal progetto'), button: 'left', in: 'tree' })
    } else {
      await ui.press({ key: 'section:elsewhere' })
    }
    // Opened: the file, where it is, and what was written
    expect(await list.row(/C:\/Temp\/scratch · nuovo/)).toBeDefined()
    await list.click('chg:c:/temp/scratch/notes.txt', 'notes.txt')
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1,2 @@\n+uno\n+due')
    await ui.press({ key: 'back' })
    await ui.press({ key: 'collapse' })
    expect(await list.row(/notes\.txt/)).toBeUndefined()
    await ui.unmount()
  }
})

test('a turn that only wrote outside the project still says what it did', IT, async ($, on) => {
  project(on, { 'C:\\proj\\a.ts': 'x\n' })

  await $.turn.start({ text: 'appunti', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: 'C:\\Temp\\notes.txt', content: 'uno\n' })
  await $.turn.complete(done('t1'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '1 fuori dal progetto' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\d+ file$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Nessun file modificato in questo turno.' })).toBeUndefined()
  await ui.unmount()
})

// ---- Bounds and steadiness ----

test('a long list on a desktop draws the rows around the pane’s window, and scrolls whole', IT, async ($, on) => {
  const files: Record<string, string> = {}
  for (let n = 0; n < 290; n++) files[`C:\\proj\\file-${String(n).padStart(3, '0')}.component.ts`] = 'x\n'
  for (let n = 0; n < 290; n++) files[`C:\\proj\\src\\part-${String(n).padStart(3, '0')}.service.ts`] = 'x\n'
  const { clock } = project(on, files)
  await $.turn.start({ text: 'tutto', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\part-000.service.ts', old_string: 'x', new_string: 'y' })
  await clock.advance(300)

  // Some 580 rows: far past what one drawing of the list holds
  const top = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rows = await rowsOf(top)
  expect(rows.length).toBeGreaterThan(580)
  // At the top: the first rows drawn, the rest blank room of their height, so the list is as tall as it is
  const drawnAt = async (ui: typeof top) => (await ui.findAll({ type: 'Box', in: 'tree' })).filter(box => /^\d+$/.test(box.key ?? ''))
  const atTop = await drawnAt(top)
  expect(atTop[0]?.key).toBe('0')
  expect(atTop.length).toBeGreaterThan(150)
  expect(await top.find({ type: 'Box', key: 'above', in: 'tree' })).toBeUndefined()
  expect((await top.find({ type: 'Box', key: 'below', in: 'tree' }))?.props.height).toBe(rows.length - atTop.length)
  // Nothing was cut: no note
  expect(await top.find({ type: 'Text', text: /elenco troncato/, in: 'tree' })).toBeUndefined()
  expect(await top.find({ type: 'Text', text: /elenco troncato/ })).toBeUndefined()
  await top.unmount()

  // Scrolled 400 rows down: drawn from a little above the window, the rows before it blank room
  const far = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 400, bodyRows: 40 } }, surface: 'desktop' })
  expect((await far.find({ type: 'Box', key: 'above', in: 'tree' }))?.props.height).toBe(360)
  const there = await drawnAt(far)
  expect(there[0]?.key).toBe('360')
  expect(Number(there.at(-1)?.key)).toBeGreaterThan(440)
  const wanted = rows[420]!
  expect(wanted.k).toBe('f')
  expect(await far.find({ type: 'Text', text: wanted.t, in: 'tree' })).toBeDefined()
  expect(await far.find({ type: 'Text', text: rows[100]!.t, in: 'tree' })).toBeUndefined()

  // A click there opens that row's file
  await far.pointer({ type: 'down', x: 1, y: 420, button: 'left', in: 'tree' })
  expect((await far.find({ type: 'Code' }))?.props.path).toBe(`C:\\proj\\${wanted.t}`)
  await far.unmount()
})

test('a selected row stays selected while rows are drawn above it', IT, async ($, on) => {
  const { clock } = project(on, {
    'C:\\proj\\docs\\notes.md': 'x\n',
    'C:\\proj\\src\\login.ts': 'a\n',
    'C:\\proj\\README.md': 'x\n',
  })
  await $.turn.start({ text: 'cambia', turnId: 't1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const tinted = async () =>
    (await ui.findAll({ type: 'Box', in: 'tree' }))
      .filter(box => box.props.backgroundColor === SELECTED)
      .map(box => box.text.trim())
  await ui.pointer({ type: 'down', x: 1, y: (await rowsOf(ui)).findIndex(row => row.t === 'docs'), button: 'left', in: 'tree' })
  expect(await tinted()).toEqual(['▾ docs'])

  // Claude changes a file: its section is drawn above the tree, and every row moves down
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(300)
  expect(await tinted()).toEqual(['▾ docs'])

  // Enter acts on it, not on what now stands where it stood
  await ui.key({ key: 'return', in: 'tree' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /notes\.md/, in: 'tree' })).toBeUndefined()
  expect(await tinted()).toEqual(['▸ docs'])
  await ui.unmount()
})

test('a slow scan never holds the next prompt, and still marks the turn it began for', IT, async ($, on) => {
  const files: Record<string, string> = {}
  const head: Record<string, string> = {}
  for (let n = 0; n < 30; n++) {
    files[`C:\\proj\\f${n}.ts`] = 'a\n'
    head[`f${n}.ts`] = 'a\n'
  }
  // Each committed text takes half a second: thirty of them, fifteen seconds of scan
  const { clock, touch } = project(on, files, { head, showDelay: 500 })
  await $.turn.start({ text: 'formatta', turnId: 't1' })
  await clock.advance(1)
  // One command rewrites every file, as a formatter does, and the turn ends at once
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\f0.ts b\n' })
  for (let n = 1; n < 30; n++) touch(`C:\\proj\\f${n}.ts`, 'b\n')
  await $.turn.complete(done('t1'))
  await clock.advance(0)

  // The next prompt waits two seconds at most, then its turn begins and edits a file the scan is on
  const next = $.turn.start({ text: 'ancora', turnId: 't2' })
  await clock.advance(2000)
  await next
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\f0.ts', old_string: 'b', new_string: 'c' })

  // The scan ends beside it: every file is the first turn's, as the first turn left it
  await clock.advance(20_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Turno 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: '30 file' })).toBeDefined()
  await ui.press({ key: 'chg:c:/proj/f0.ts' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,1 +1,1 @@\n-a\n+b')
  await ui.unmount()
})

test('scans that find the same files list the project no more, and draw nothing again', IT, async ($, on) => {
  const { clock, catalogs } = project(on, { 'C:\\proj\\a.ts': 'x\n' }, { head: { 'a.ts': 'x\n' } })
  // What git's answer and the catalogue are written as, while the commands run
  const written: string[] = []
  on('state.set', { plugin: 'canopy' }, (_, e, next) => {
    written.push(e.key)

    return next(e)
  })
  await $.turn.start({ text: 'sed', turnId: 't1' })
  await clock.advance(1)
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\a.ts y\n' })
  await clock.advance(400)
  await clock.advance(300)
  const listed = catalogs.count
  written.length = 0

  // Commands that change nothing more: git asked each time, the same answer, no list and no write
  for (let n = 0; n < 3; n++) {
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(400)
    await clock.advance(300)
  }
  expect(catalogs.count).toBe(listed)
  expect(written.filter(key => key === 'git' || key === 'catalog')).toEqual([])

  // A file made: listed again, and the search finds it
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\b.ts z\n' })
  await clock.advance(400)
  await clock.advance(300)
  expect(catalogs.count).toBe(listed + 1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'search', text: 'b.ts', kind: 'change' })
  expect((await rowsOf(ui)).map(row => row.t)).toEqual(['1 file', 'b.ts'])
  await ui.unmount()

  // And, a minute on, once more whatever git says: an ignore rule may have changed
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(400)
  await clock.advance(300)
  expect(catalogs.count).toBe(listed + 2)
})

test('the texts a turn keeps for its diffs are bounded: past the room, a file is too large to show', IT, async ($, on) => {
  // Eight files of 900,000 characters: a turn keeps six million at most
  const big = 'x\n'.repeat(450_000)
  const names = Array.from({ length: 8 }, (_, n) => `C:\\proj\\big${n}.txt`)
  const { clock } = project(on, Object.fromEntries(names.map(name => [name, big])))
  const kept = new Map<string, { before?: { kind: string } }>()
  on('state.set', { plugin: 'canopy', key: 'snapshot' }, (_, e, next) => {
    if (e.id !== undefined) kept.set(e.id, e.value as { before?: { kind: string } })

    return next(e)
  })

  await $.turn.start({ text: 'riscrivi', turnId: 't1' })
  for (const name of names) await $.tool.call({ tool: 'Edit', file_path: name, old_string: 'x', new_string: 'y' })
  await clock.advance(300)
  expect(names.map(name => kept.get(`t1|${name.toLowerCase().replace(/\\/g, '/')}`)?.before?.kind)).toEqual([
    'text', 'text', 'text', 'text', 'text', 'text', 'too-large', 'too-large',
  ])

  // Still listed, and the file view says why there is no diff
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '8 file' })).toBeDefined()
  await ui.press({ key: 'chg:c:/proj/big7.txt' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /confronto non disponibile/ })).toBeDefined()
  await ui.unmount()

  // A new turn has its own room
  await $.turn.complete(done('t1'))
  await $.turn.start({ text: 'ancora', turnId: 't2' })
  await $.tool.call({ tool: 'Edit', file_path: names[0]!, old_string: 'x', new_string: 'z' })
  expect(kept.get('t2|c:/proj/big0.txt')?.before?.kind).toBe('text')
})

test('a /clear or a /resume empties the history first, the texts after', IT, async ($, on) => {
  const { clock } = project(on, { 'C:\\proj\\a.ts': 'x\n', 'C:\\proj\\b.ts': 'x\n' })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  // Each text cleared takes a second: past an end's short bound, the last ones would not be
  let isSlow = false
  on('state.set', { plugin: 'canopy', key: 'snapshot' }, async (_, e, next) => {
    if (isSlow) await clock.sleep(1000)

    return next(e)
  })
  const noTurn = 'Ancora nessun turno: quando Claude lavora, i file che tocca si colorano qui.'

  for (const reason of ['clear', 'resume'] as const) {
    await $.turn.start({ text: 'cambia', turnId: `t-${reason}` })
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: 'x', new_string: 'y' })
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\b.ts', old_string: 'x', new_string: 'y' })
    await $.turn.complete(done(`t-${reason}`))
    await clock.advance(300)

    isSlow = true
    const ending = $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    await clock.settle()
    // The texts still being cleared, the pane already has no turn to show
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: noTurn })).toBeDefined()
    await ui.unmount()
    await clock.advance(5000)
    await ending
    isSlow = false
  }
})

test('a large file shown as it is draws the lines that fit, whole, and says the rest is not drawn', IT, async ($, on) => {
  // Some 800,000 characters, read and left unchanged
  const lines = Array.from({ length: 20_000 }, (_, n) => `const value${n} = ${n} // a line of words`)
  project(on, { 'C:\\proj\\big.ts': `${lines.join('\n')}\n`, 'C:\\proj\\small.ts': 'a\nb\n' })
  await $.turn.start({ text: 'leggi', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\big.ts' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\small.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'file:c:/proj/big.ts' })
  const source = String((await ui.find({ type: 'Code' }))?.props.source)
  // Within the room a drawing gives its code, cut at a line's end
  expect(source.length).toBeLessThanOrEqual(90_000)
  expect(source.length).toBeGreaterThan(80_000)
  const drawn = source.split('\n')
  expect(drawn).toEqual(lines.slice(0, drawn.length))
  expect(await ui.find({ type: 'Text', text: '… il resto del file non è mostrato qui' })).toBeDefined()

  // A file that fits is drawn whole, with no note
  await ui.press({ key: 'back' })
  await ui.press({ key: 'file:c:/proj/small.ts' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('a\nb')
  expect(await ui.find({ type: 'Text', text: /il resto del file/ })).toBeUndefined()
  await ui.unmount()
})

test('a file with nothing to count against, or no text to count, is read once at most', IT, async ($, on) => {
  // Unknown to git and binary as the turn begins: nothing kept of it. Tracked text, then written binary
  const { clock, reads } = project(
    on,
    { 'C:\\proj\\data.bin': '\u0000old', 'C:\\proj\\img.dat': 'text\n' },
    { head: { 'img.dat': 'text\n' } },
  )
  await $.turn.start({ text: 'genera', turnId: 't1' })
  await clock.advance(1)
  const before = reads.count
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\data.bin \u0000new' })
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\img.dat \u0000bin' })
  await clock.advance(400)
  await clock.advance(300)
  // The binary text found once; the file with no start to count from never
  expect(reads.count - before).toBe(1)

  // Commands that write nothing: neither is read again
  const counted = reads.count
  for (let n = 0; n < 3; n++) {
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(400)
    await clock.advance(300)
  }
  expect(reads.count).toBe(counted)

  // Both listed, neither counted
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const listed = (await rowsOf(ui)).filter(row => row.i === 1)
  expect(listed.map(row => [row.t, row.s])).toEqual([
    ['data.bin', undefined],
    ['img.dat', undefined],
  ])
  await ui.unmount()
})

// ---- Tidy ----

test('an open file is read again only once it changed on disk, not at every redraw', IT, async ($, on) => {
  const { clock, reads } = project(on, { 'C:\\proj\\a.ts': 'one\n' })
  await $.turn.start({ text: 'cerca', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'file:c:/proj/a.ts' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('one')
  // Commands redraw the pane while the file is open: it is not read again
  const before = reads.count
  for (let n = 0; n < 5; n++) {
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('one')
  }
  expect(reads.count).toBe(before)

  // Written: read again, and shown as it is now
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\a.ts two\n' })
  await clock.advance(1)
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('two')
  await ui.unmount()
})

test('a closed file view lets go of what it kept: opened again, the file is read afresh', IT, async ($, on) => {
  const { reads } = project(on, { 'C:\\proj\\a.ts': 'one\n' })
  await $.turn.start({ text: 'cerca', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'file:c:/proj/a.ts' })
  await ui.press({ key: 'back' })
  const before = reads.count
  await ui.press({ key: 'file:c:/proj/a.ts' })
  expect(reads.count).toBe(before + 1)
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('one')
  await ui.unmount()
})

test('comparisons write over one file per side: the temporary folder does not fill up', IT, async ($, on) => {
  const idea = 'C:\\Users\\me\\AppData\\Local\\Programs\\IntelliJ IDEA Ultimate\\bin\\idea64.exe'
  const { clock, saved } = project(on, { 'C:\\proj\\a.ts': 'one\n', [idea]: '' })
  mock.env(on, { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', TEMP: 'C:\\Temp' })
  sessionEngine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1)

  for (const [turnId, from, to] of [['t1', 'one', 'two'], ['t2', 'two', 'three'], ['t3', 'three', 'four']] as const) {
    await $.turn.start({ text: 'cambia', turnId })
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\a.ts', old_string: from, new_string: to })
    await $.turn.complete(done(turnId))
  }

  // Each turn compared, the latest against the file itself, the older ones as they left it
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'chg:c:/proj/a.ts' })
  await ui.press({ key: 'editor:compare' })
  for (let n = 0; n < 2; n++) {
    await ui.press({ key: 'prev' })
    await ui.press({ key: 'editor:compare' })
  }
  expect([...saved.keys()].map(path => path.slice(path.lastIndexOf('\\') + 1)).sort()).toEqual([
    'a (dopo il turno).ts',
    'a (prima del turno).ts',
  ])
  // Each written over with the last comparison's texts: the first turn's
  const side = (name: string) => saved.get([...saved.keys()].find(path => path.endsWith(name))!)
  expect(side('a (prima del turno).ts')).toBe('one\n')
  expect(side('a (dopo il turno).ts')).toBe('two\n')
  await ui.unmount()
})

test('past the rows a pane lists at most, a desktop’s list still says it was cut, at its end', IT, async ($, on) => {
  // Three folders of 290 files, each holding a change and so open: some 880 rows
  const files: Record<string, string> = {}
  for (const dir of ['a', 'b', 'c']) {
    for (let n = 0; n < 290; n++) files[`C:\\proj\\${dir}\\f${String(n).padStart(3, '0')}.ts`] = 'x\n'
  }
  const { clock } = project(on, files)
  await $.turn.start({ text: 'tutto', turnId: 't1' })
  for (const dir of ['a', 'b', 'c']) {
    await $.tool.call({ tool: 'Edit', file_path: `C:\\proj\\${dir}\\f000.ts`, old_string: 'x', new_string: 'y' })
  }
  await clock.advance(300)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = await ui.findAll({ type: 'Text', in: 'tree' })
  expect(texts.at(-1)?.text).toBe('… elenco troncato: chiudi qualche cartella')
  await ui.unmount()
})

test('the tree reads its folders again only once a file came or went, or a moment on', { ...IT, timeoutMs: 15_000 }, async ($, on) => {
  const { clock, lists, touch } = project(
    on,
    { 'C:\\proj\\src\\a.ts': 'x\n', 'C:\\proj\\README.md': '#\n' },
    { head: { 'src/a.ts': 'x\n', 'README.md': '#\n' } },
  )
  await $.turn.start({ text: 'lavora', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\a.ts', old_string: 'x', new_string: 'y' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const isShown = async (name: string) => (await ui.find({ key: `file:c:/proj/src/${name}` })) !== undefined
  expect(await isShown('a.ts')).toBe(true)

  // While Claude works the pane is drawn again and again: commands, scans, counts. The folders stay as read
  const before = lists.count
  for (let n = 0; n < 3; n++) {
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(400)
    await clock.advance(300)
    expect(await isShown('a.ts')).toBe(true)
  }
  expect(lists.count).toBe(before)

  // A file Claude makes is there at once; one a command makes, as soon as git sees it
  await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\src\\b.ts', content: 'z\n' })
  expect(await isShown('b.ts')).toBe(true)
  await $.tool.call({ tool: 'Bash', command: 'write C:\\proj\\src\\c.ts w\n' })
  await clock.advance(400)
  expect(await isShown('c.ts')).toBe(true)

  // One made in an editor, which nothing tells: within a moment
  touch('C:\\proj\\src\\d.ts', 'v\n')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await isShown('d.ts')).toBe(false)
  await new Promise<void>(resolve => setTimeout(resolve, 2100))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await isShown('d.ts')).toBe(true)
  await ui.unmount()
})
