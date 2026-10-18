import type { FsEntry, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

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

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

// The tests that read the pane's words read them in Italian
const IT = { options: { language: 'it' } }

// What `git` answers: the committed text by repo-relative path, and what it
// ignores (a folder ends in `/`). Absent, the project is no repository.
type Repo = { head: Record<string, string>; ignored?: string[] }

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
  // What the plugin started besides git, and the files it wrote
  const launched: string[][] = []
  const saved = new Map<string, string>()
  const norm = (path: string) => path.replace(/\//g, '\\')
  const isDir = (path: string) => [...disk.keys()].some(file => file.startsWith(path + '\\'))
  const relOf = (path: string) => path.slice('C:\\proj\\'.length).replace(/\\/g, '/')
  const isIgnored = (rel: string) => (repo?.ignored ?? []).some(one => rel === one || (one.endsWith('/') && rel.startsWith(one)))

  const clock = mock.clock(on, { now: 1_000_000 })
  const touch = (path: string, text: string) => {
    disk.set(path, text)
    writtenAt.set(path, clock.now())
  }
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: 'C:\\proj' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('fs.exists', (_, e) => ({ value: disk.has(norm(e.path)) || isDir(norm(e.path)) }))
  on('fs.read', (_, e) => {
    const text = disk.get(norm(e.path))

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.stat', (_, e) => {
    const path = norm(e.path)
    if (!disk.has(path)) return { deny: 'ENOENT' }

    return {
      value: { kind: 'file', size: 0, mtimeMs: writtenAt.get(path) ?? 0, isLink: false },
    }
  })
  on('fs.write', (_, e) => {
    saved.set(norm(e.path), e.text)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const [command, ...rest] = e.argv
    // An editor started detached: recorded, and it starts
    if (command === 'cmd' || command === 'sh') {
      launched.push([...e.argv])

      return ran(0)
    }
    const isLockFree = rest[0] === '--no-optional-locks'
    const [verb, target] = isLockFree ? rest.slice(1) : rest
    if (repo === undefined || command !== 'git') return ran(128)
    if (verb === 'rev-parse') return ran(0, 'C:/proj\n')
    // A scan must never take the index lock a commit running beside it needs
    if ((verb === 'status' || verb === 'ls-files') && !isLockFree) return ran(128)
    const inProject = [...disk.keys()].filter(path => path.startsWith('C:\\proj\\'))
    if (verb === 'status') {
      scans.count += 1
      const onDisk = inProject
        .filter(path => repo.head[relOf(path)] !== disk.get(path) && !isIgnored(relOf(path)))
        .map(path => `${relOf(path) in repo.head ? ' M' : '??'} ${relOf(path)}\0`)
      const gone = Object.keys(repo.head)
        .filter(rel => !disk.has(`C:\\proj\\${rel.replace(/\//g, '\\')}`))
        .map(rel => ` D ${rel}\0`)

      return ran(0, [...onDisk, ...gone].join(''))
    }
    if (verb === 'ls-files') {
      if (rest.includes('--ignored')) return ran(0, (repo.ignored ?? []).map(rel => `${rel}\0`).join(''))
      const listed = inProject.map(relOf).filter(rel => !isIgnored(rel))

      return ran(0, listed.map(rel => `${rel}\0`).join(''))
    }
    const committed = repo.head[String(target).replace(/^HEAD:/, '')]
    if (verb === 'show' && committed !== undefined) return ran(0, committed)

    return ran(128)
  })
  on('fs.list', (_, e) => {
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
  on('tool.call', (_, e) => {
    if (e.tool === 'Edit') {
      const text = disk.get(e.file_path)
      if (text === undefined) return { deny: 'no such file' }
      disk.set(e.file_path, text.replace(e.old_string, e.new_string))

      return { result: 'ok' }
    }
    if (e.tool === 'Write') {
      const type = disk.has(e.file_path) ? 'update' : 'create'
      disk.set(e.file_path, e.content)

      return { result: { type } }
    }
    if (e.tool === 'Bash') {
      const write = /^write (\S+) ([\s\S]*)$/.exec(e.command)
      if (write !== null) touch(write[1]!, write[2]!)

      return { result: { stdout: '', stderr: '', interrupted: false } }
    }

    return { result: 'ok' }
  })

  return { clock, scans, touch, launched, saved }
}

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

// The tinted row and the lit one, as tree.tsx paints them
const SELECTED = '#4c8dff33'
const HOVER = '#8080801f'

test('the tree colours the files a turn changed and opens a folder that holds one', IT, async ($, on) => {
  project(on, {
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

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    expect(await ui.find({ type: 'Text', text: 'Turno 1' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /finito in 32s/ }))?.text).toBe('· finito in 32s')
    expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('success')

    // The counts are the legend: each letter in its colour, then what it means
    expect((await ui.find({ type: 'Text', text: /^M$/ }))?.props.color).toBe('suggestion')
    expect((await ui.find({ type: 'Text', text: /^A$/ }))?.props.color).toBe('success')
    expect(await ui.find({ type: 'Text', text: '1 modificato' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 nuovo' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 letto' })).toBeDefined()
    expect(await list.row(/MODIFICHE/)).toBeDefined()

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

test('a desktop draws its lists in a Client: coloured names, letters, guides', IT, async ($, on) => {
  project(on, { 'C:\\proj\\src\\login.ts': 'a\n' })

  await $.turn.start({ text: 'cambia', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const client = await ui.find({ type: 'Client' })
  expect(client?.props.module).toBe('hooks/tree.tsx')
  expect((client?.props.props as { rows: unknown[] }).rows).toEqual([
    { t: '▾ MODIFICHE', c: '', k: 'g', n: '1', o: 1 },
    { t: 'login.ts', c: 'changed', k: 'f', i: 1, m: 'M', n: 'src' },
    { t: ' ', c: '', k: 'x' },
    { t: 'proj', c: '', k: 'h', n: 'C:/proj' },
    { t: '▾ src', c: 'changed', k: 'd', m: '●', o: 1 },
    { t: '  login.ts', c: 'changed', k: 'f', d: 1, m: 'M' },
  ])
  // No Button among the rows: a native one would drop the colour
  expect(await ui.find({ key: 'file:c:/proj/src/login.ts' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('warning')
  // The guide before a nested row, the letter at its end
  expect((await ui.find({ type: 'Text', text: /^│ $/, in: 'tree' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: / M /, in: 'tree' }))?.props.color).toBe('suggestion')
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
  const rows = ((await ui.find({ type: 'Client' }))?.props.props as { rows: { t: string }[] }).rows
  expect(rows[0]?.t).toBe('▸ MODIFICHE')
  expect(rows.some(row => row.t === 'login.ts')).toBe(false)
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

  // The project heading is no target: nothing lights there
  await ui.pointer({ type: 'move', x: 3, y: 3, in: 'tree' })
  expect((await rowBoxes()).some(box => box.props.backgroundColor !== undefined)).toBe(false)
  expect((await name())?.props.underline).toBe(false)

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
  expect((await ui.find({ type: 'Text', text: /file\.ts/, in: 'tree' }))?.text).toBe('  file.ts  …r/name/here')

  // Wide again, nothing is cut
  await ui.resize({ columns: 120, rows: 30, in: 'tree' })
  expect((await ui.find({ type: 'Text', text: /file\.ts/, in: 'tree' }))?.text).toBe(
    '  file.ts  very/long/folder/name/here',
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
    expect((await ui.find({ type: 'Text', text: /^!$/ }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: '1 non riuscito' })).toBeDefined()

    await list.click('file:c:/proj/a.ts', 'a.ts')
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBeUndefined()
    expect(code?.props.source).toBe('uno')
    expect(await ui.find({ type: 'Text', text: /letto · non modificato in questo turno/ })).toBeDefined()
    await ui.press({ key: 'back' })
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

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const list = listOf(ui, surface)
    expect(await ui.find({ type: 'Text', text: '1 modificato' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 comandi shell' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: '1 comando shell' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Nessun file toccato in questo turno.' })).toBeDefined()
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
    expect((await ui.find({ type: 'Text', text: /^U$/ }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: '1 modificato' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 non in git' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 eliminato' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'dall’ultimo commit' })).toBeDefined()
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

test("the tree's root is the project, wherever a shell cd left the cwd", IT, async ($, on) => {
  project(on, { 'C:\\proj\\src\\login.ts': 'a\n', 'C:\\proj\\README.md': '#\n' }, undefined, 'C:\\proj\\src')
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'C:\\proj\\src', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^proj {2}C:\/proj$/, in: 'tree' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /README\.md/, in: 'tree' })).toBeDefined()
  await ui.unmount()
})

// ---- Canopy 1.0 ----

type Row = { t: string; c: string; k: string; d?: number; m?: string; n?: string; o?: number; h?: [number, number] }
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
  expect(await ui.find({ type: 'Text', text: '· finished in 5s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 modified' })).toBeDefined()
  expect((await rowsOf(ui))[0]?.t).toBe('▾ CHANGES')
  expect(await ui.find({ key: 'mode:commit' })).toBeDefined()
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
    { t: '▾ src', c: '', k: 'd', o: 1 },
    { t: '  login.ts', c: '', k: 'f', d: 1, h: [2, 5] },
  ])
  // The match is marked where it is
  expect((await ui.find({ type: 'Text', text: /^log$/, in: 'tree' }))?.props.bold).toBe(true)

  // A folder holding only a folder reads as one, as an IDE's compact folders
  await ui.input({ key: 'search', text: 'sess', kind: 'change' })
  expect((await rowsOf(ui)).map(row => row.t)).toEqual(['1 file', '▾ src/auth', '  session.ts'])
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
  expect(rows.some(row => row.t === '▾ src' && row.o === 1)).toBe(true)
  expect(rows.some(row => row.t === '  login.ts' && row.d === 1)).toBe(true)
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
  expect(rows.find(row => row.t === '▸ logs')?.c).toBe('heavy')
  expect(rows.find(row => row.t === '  .env')?.c).toBe('heavy')
  expect(rows.find(row => row.t === '▸ src')?.c).toBe('')
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

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '1 modificato' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 altra modifica/ })).toBeDefined()

    if (ui.surface === 'desktop') {
      const desk = ui as Mounted<'desktop', 'Pane'>
      const rows = await rowsOf(desk)
      expect(rows.slice(0, 3)).toEqual([
        { t: '▾ MODIFICHE', c: '', k: 'g', n: '1', o: 1 },
        { t: 'a.ts', c: 'changed', k: 'f', i: 1, m: 'M' },
        { t: '▸ ALTRE MODIFICHE', c: '', k: 'g', n: '1' },
      ])
      // In the tree it reads dimmed, its letter too
      expect(rows.find(row => row.t === '  b.ts')).toEqual({ t: '  b.ts', c: 'outside', k: 'f', m: 'M' })
      // Its section opens on a click, and the file with the next
      await ui.pointer({ type: 'down', x: 1, y: 2, button: 'left', in: 'tree' })
      expect((await rowsOf(desk))[3]).toEqual({ t: 'b.ts', c: 'outside', k: 'f', i: 1, m: 'M' })
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
  expect(launched.at(-1)).toEqual(['cmd', '/c', 'start', '', idea, '--line', '12', 'C:\\proj\\src\\login.ts'])

  // The turn's own diff: the file as the turn found it, beside the file now
  await ui.press({ key: 'editor:compare' })
  const left = [...saved.keys()].find(path => path.endsWith('login (prima del turno 1).ts'))
  expect(left?.startsWith('C:\\Temp\\canopy\\')).toBe(true)
  expect(saved.get(left!)).toBe(before)
  expect(launched.at(-1)).toEqual(['cmd', '/c', 'start', '', idea, 'diff', left, 'C:\\proj\\src\\login.ts'])

  // Only the changes: each block names its lines and opens there
  await ui.press({ key: 'view:hunks' })
  expect(await ui.find({ type: 'Text', text: 'Righe 9–15' })).toBeDefined()
  await ui.press({ key: 'hunk:open:0' })
  expect(launched.at(-1)?.slice(-3)).toEqual(['--line', '12', 'C:\\proj\\src\\login.ts'])
  await ui.unmount()
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
