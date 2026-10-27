import type { EngineInterface } from 'claude-code'

import { hashOf, joinPath, splitLabel } from './paths'
import { onPath, systemProgram } from './programs'

/**
 * The editor a file goes to from the pane: a JetBrains IDE through its
 * launcher (`idea64.exe --line 42 file`, `idea64.exe diff a b`), or VS Code
 * (`code --goto file:42`, `code --diff a b`). A running instance takes the
 * file in the window that has its project open.
 */
export type Editor = { kind: 'jetbrains' | 'vscode'; name: string; exe: string; isWindows: boolean }

export type EditorChoice = 'auto' | 'intellij' | 'vscode' | 'off'

// The JetBrains launchers by file name, for a path given in the options
const JETBRAINS: [RegExp, string][] = [
  [/webstorm/i, 'WebStorm'],
  [/pycharm/i, 'PyCharm'],
  [/goland/i, 'GoLand'],
  [/rider/i, 'Rider'],
  [/phpstorm/i, 'PhpStorm'],
  [/clion/i, 'CLion'],
  [/rubymine/i, 'RubyMine'],
  [/datagrip/i, 'DataGrip'],
  [/idea/i, 'IntelliJ'],
]

const editorOf = (exe: string, isWindows: boolean): Editor => {
  const file = exe.split(/[\\/]/).at(-1) ?? exe
  if (/^code(?:-insiders)?(?:\.cmd|\.exe)?$/i.test(file) || /visual studio code/i.test(exe)) {
    return { kind: 'vscode', name: 'VS Code', exe, isWindows }
  }
  const name = JETBRAINS.find(([pattern]) => pattern.test(file))?.[1] ?? 'IntelliJ'

  return { kind: 'jetbrains', name, exe, isWindows }
}

function isThere($: EngineInterface, path: string) {
  return $.fs.exists(path).catch(() => false)
}

// A command in the PATH's folders, never the project's (programs.ts); on Windows the
// launcher itself, not the shell script beside it
async function which($: EngineInterface, name: string, isWindows: boolean) {
  const found = await onPath($, name)

  return isWindows ? found.find(line => /\.(?:exe|cmd|bat)$/i.test(line)) : found[0]
}

// The newest `<dir>/<prefix…>/<tail>` there is: one IDE folder per version
async function newest($: EngineInterface, dir: string | undefined, prefix: string, tail: string) {
  if (dir === undefined) return undefined
  const names = (await $.fs.list(dir).catch(() => []))
    .filter(entry => entry.kind === 'dir' && entry.name.toLowerCase().startsWith(prefix))
    .map(entry => entry.name)
    .sort()
    .reverse()
  for (const name of names) {
    const exe = joinPath(joinPath(dir, name), tail)
    if (await isThere($, exe)) return exe
  }

  return undefined
}

async function firstThere($: EngineInterface, paths: (string | undefined)[]) {
  for (const path of paths) if (path !== undefined && (await isThere($, path))) return path

  return undefined
}

async function findIntellij($: EngineInterface, isWindows: boolean) {
  if (isWindows) {
    const local = await $.env.get('LOCALAPPDATA')
    const programs = await $.env.get('ProgramFiles')

    return (
      (await which($, 'idea64', true)) ??
      (await which($, 'idea', true)) ??
      (await firstThere($, [local && `${local}\\JetBrains\\Toolbox\\scripts\\idea.cmd`])) ??
      (await newest($, local && `${local}\\Programs`, 'intellij idea', 'bin\\idea64.exe')) ??
      (await newest($, programs && `${programs}\\JetBrains`, 'intellij idea', 'bin\\idea64.exe'))
    )
  }
  const home = await $.env.get('HOME')

  return (
    (await which($, 'idea', false)) ??
    (await firstThere($, [
      '/Applications/IntelliJ IDEA.app/Contents/MacOS/idea',
      '/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea',
      '/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea',
      home && `${home}/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea`,
      home && `${home}/Applications/IntelliJ IDEA.app/Contents/MacOS/idea`,
      home && `${home}/.local/share/JetBrains/Toolbox/scripts/idea`,
    ]))
  )
}

async function findVscode($: EngineInterface, isWindows: boolean) {
  if (isWindows) {
    const local = await $.env.get('LOCALAPPDATA')
    const programs = await $.env.get('ProgramFiles')

    return (
      (await which($, 'code', true)) ??
      (await firstThere($, [
        local && `${local}\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
        programs && `${programs}\\Microsoft VS Code\\bin\\code.cmd`,
      ]))
    )
  }

  return (
    (await which($, 'code', false)) ??
    (await firstThere($, ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']))
  )
}

// ---- A launcher script and the program it starts ----
// `code.cmd` and the JetBrains Toolbox scripts only start a program
// (`"%~dp0..\Code.exe" … %*`, `start "" "C:\…\idea64.exe" %*`), and the
// `code` command itself ends by starting Code.exe with the same arguments. A
// script runs through cmd.exe, which reads `%NAME%` (and, where the registry
// turns it on, `!NAME!`) in a file's name as a variable: so Canopy starts the
// program itself, and no shell ever reads a name

const isScript = (path: string) => /\.(?:cmd|bat)$/i.test(path)

// A Windows path with `.` and `..` folded away: `C:\VS Code\bin\..\Code.exe` → `C:\VS Code\Code.exe`
const folded = (path: string) => {
  const parts: string[] = []
  for (const part of path.split(/[\\/]/)) {
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else if (part !== '.') parts.push(part)
  }

  return parts.join('\\')
}

// The folders a launcher script may name its program by, lowercase as
// Windows reads a variable's name whatever its case
async function folderVariables($: EngineInterface): Promise<Record<string, string | undefined>> {
  return {
    localappdata: await $.env.get('LOCALAPPDATA'),
    appdata: await $.env.get('APPDATA'),
    programfiles: await $.env.get('ProgramFiles'),
    'programfiles(x86)': await $.env.get('ProgramFiles(x86)'),
    userprofile: await $.env.get('USERPROFILE'),
  }
}

/**
 * The program a launcher script starts: the first quoted `.exe` in it,
 * absolute or beside the script (`%~dp0`), or under one of the usual folders
 * (`%LOCALAPPDATA%`). Undefined when the script can't be read, names none, or
 * names it otherwise, or the program isn't there.
 */
async function programOf($: EngineInterface, script: string): Promise<string | undefined> {
  const text = await $.fs.read(script).catch(() => undefined)
  if (text === undefined || text.length > 64_000) return undefined
  const dir = script.slice(0, Math.max(script.lastIndexOf('\\'), script.lastIndexOf('/')) + 1)
  let folders: Record<string, string | undefined> | undefined
  for (const [, quoted] of text.matchAll(/"([^"\r\n]+?\.exe)"/gi)) {
    let path = quoted!.replace(/%~dp0/gi, () => dir)
    if (/%[^%]+%/.test(path)) {
      folders ??= await folderVariables($)
      const known = folders
      path = path.replace(/%([^%]+)%/g, (variable, name: string) => known[name.toLowerCase()] ?? variable)
    }
    // A variable left unread, or a path not whole: not one to start
    if (path.includes('%') || !/^[A-Za-z]:[\\/]/.test(path)) continue
    const program = folded(path)
    if (await isThere($, program)) return program
  }

  return undefined
}

// The editor as found, started through its program where its launcher is a script
async function direct($: EngineInterface, editor: Editor): Promise<Editor> {
  if (!editor.isWindows || !isScript(editor.exe)) return editor
  const program = await programOf($, editor.exe)

  return program === undefined ? editor : { ...editor, exe: program }
}

// The one found as the session started
let current: Editor | undefined

export const currentEditor = () => current

export const setEditor = (found: Editor | undefined) => {
  current = found
}

/** The editor the options ask for, found on this machine; undefined when there is none. */
export async function findEditor($: EngineInterface, choice: EditorChoice, path: string): Promise<Editor | undefined> {
  if (choice === 'off') return undefined
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  // Which editor it is, the launcher's name says; how it starts, `direct`
  if (path.trim() !== '') return direct($, editorOf(path.trim(), isWindows))

  const intellij = choice === 'vscode' ? undefined : await findIntellij($, isWindows)
  if (intellij !== undefined) return direct($, editorOf(intellij, isWindows))
  const vscode = choice === 'intellij' ? undefined : await findVscode($, isWindows)

  return vscode === undefined ? undefined : direct($, editorOf(vscode, isWindows))
}

/** How a start went: `refused` when a script launcher would misread a name Canopy passes it. */
export type Launch = 'started' | 'failed' | 'refused'

/**
 * A Windows argument as the program's own parser reads it back: quoted
 * whole, a backslash run doubled where a quote or the end follows it.
 */
export const quoteArg = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`

// Windows starts the launcher through Start-Process, which the launcher and
// its arguments reach as variables: no shell reads a path, so an `&`, `^` or
// `%` in a file's name is a character of it, never a command. A script
// launcher whose program couldn't be found (see `direct`) runs in a hidden
// console of its own
const START = 'Start-Process -FilePath $env:CANOPY_EXE -ArgumentList $env:CANOPY_ARGS -ErrorAction Stop'

// Started detached: a launcher that becomes the IDE itself (none was running)
// must not hold the call, and Canopy never waits on the editor
async function launch($: EngineInterface, editor: Editor, args: string[]): Promise<Launch> {
  // A quote or a line break is in no Windows path: an argument holding one is refused, not passed
  if (editor.isWindows && args.some(arg => /["\r\n]/.test(arg))) return 'failed'
  const viaScript = editor.isWindows && isScript(editor.exe)
  // Through a script, cmd.exe would read `%…%` or `!…!` in a name as a variable: another file would open
  if (viaScript && args.some(arg => /[%!]/.test(arg))) return 'refused'
  const run = editor.isWindows
    ? $.process.run([await systemProgram($, 'powershell'), '-NoProfile', '-NonInteractive', '-Command', viaScript ? `${START} -WindowStyle Hidden` : START], {
        env: { CANOPY_EXE: editor.exe, CANOPY_ARGS: args.map(quoteArg).join(' ') },
        timeoutMs: 15_000,
      })
    : $.process.run(['sh', '-c', '"$0" "$@" >/dev/null 2>&1 &', editor.exe, ...args], { timeoutMs: 15_000 })
  const out = await run.catch(() => undefined)

  return out?.exitCode === 0 ? 'started' : 'failed'
}

/** Opens `path` at `line` in the editor. */
export function openIn($: EngineInterface, editor: Editor, path: string, line: number) {
  return launch($, editor, editor.kind === 'vscode' ? ['--goto', `${path}:${line}`] : ['--line', String(line), path])
}

/** Shows the editor's own diff of two files, `left` the older. */
export function compareIn($: EngineInterface, editor: Editor, left: string, right: string) {
  return launch($, editor, editor.kind === 'vscode' ? ['--diff', left, right] : ['diff', left, right])
}

async function sidesFolder($: EngineInterface) {
  return joinPath((await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp', 'canopy')
}

// The copies this session's comparisons wrote: emptied as it ends, so a `.env`
// compared leaves no secret in the temporary folder
const sides = new Set<string>()

/**
 * Writes one side of a comparison to the temporary folder, named after the
 * file and the side it stands for (`login (before the turn).ts`), so the
 * editor's diff says what it compares and highlights it as the file's type.
 * One name per side, written over at each comparison: nothing can delete
 * here, and the folder holds three files at most for each file compared.
 */
export async function writeSide($: EngineInterface, key: string, label: string, moment: string, text: string) {
  const { name } = splitLabel(label)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const path = joinPath(joinPath(await sidesFolder($), hashOf(key)), `${stem} (${moment})${extension}`)
  await $.fs.write(path, text)
  sides.add(path)

  return path
}

/** Empties the copies this session's comparisons wrote: nothing can delete them, an empty file stays. */
export async function emptySides($: EngineInterface) {
  for (const path of sides) await $.fs.write(path, '').catch(() => undefined)
  sides.clear()
}

// A copy older than this was left by a session that never emptied its own (one
// closed abruptly, a module reloaded); a newer one may be a comparison another
// session still shows. The folders looked at as a session starts, at most
const LEFT_AFTER = 24 * 60 * 60 * 1000
const MAX_SWEPT = 500

/** Empties the copies past sessions left in the temporary folder: off the startup path. */
export async function sweepSides($: EngineInterface) {
  const folder = await sidesFolder($)
  const now = await $.clock.now()
  const dirs = (await $.fs.list(folder).catch(() => [])).filter(entry => entry.kind === 'dir').slice(0, MAX_SWEPT)
  for (const dir of dirs) {
    const path = joinPath(folder, dir.name)
    for (const entry of await $.fs.list(path).catch(() => [])) {
      if (entry.kind !== 'file' || entry.size === 0 || now - entry.mtimeMs < LEFT_AFTER) continue
      await $.fs.write(joinPath(path, entry.name), '').catch(() => undefined)
    }
  }
}
