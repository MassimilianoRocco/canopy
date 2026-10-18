import type { EngineInterface } from 'claude-code'

import { hashOf, joinPath, splitLabel } from './paths'

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

// A command on the PATH; on Windows the launcher itself, not the shell script beside it
async function which($: EngineInterface, name: string, isWindows: boolean) {
  const out = await $.process
    .run(isWindows ? ['where', name] : ['which', name], { timeoutMs: 3000 })
    .catch(() => undefined)
  if (out === undefined || out.exitCode !== 0) return undefined
  const lines = out.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')

  return isWindows ? lines.find(line => /\.(?:exe|cmd|bat)$/i.test(line)) : lines[0]
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
  if (path.trim() !== '') return editorOf(path.trim(), isWindows)

  const intellij = choice === 'vscode' ? undefined : await findIntellij($, isWindows)
  if (intellij !== undefined) return editorOf(intellij, isWindows)
  const vscode = choice === 'intellij' ? undefined : await findVscode($, isWindows)

  return vscode === undefined ? undefined : editorOf(vscode, isWindows)
}

// Started detached: a launcher that becomes the IDE itself (none was running)
// must not hold the call, and Canopy never waits on the editor
async function launch($: EngineInterface, editor: Editor, args: string[]) {
  const argv = editor.isWindows
    ? /\.(?:cmd|bat)$/i.test(editor.exe)
      ? ['cmd', '/c', 'call', editor.exe, ...args]
      : ['cmd', '/c', 'start', '', editor.exe, ...args]
    : ['sh', '-c', '"$0" "$@" >/dev/null 2>&1 &', editor.exe, ...args]
  const out = await $.process.run(argv, { timeoutMs: 15_000 }).catch(() => undefined)

  return out?.exitCode === 0
}

/** Opens `path` at `line` in the editor; false when it could not be started. */
export function openIn($: EngineInterface, editor: Editor, path: string, line: number) {
  return launch($, editor, editor.kind === 'vscode' ? ['--goto', `${path}:${line}`] : ['--line', String(line), path])
}

/** Shows the editor's own diff of two files, `left` the older. */
export function compareIn($: EngineInterface, editor: Editor, left: string, right: string) {
  return launch($, editor, editor.kind === 'vscode' ? ['--diff', left, right] : ['diff', left, right])
}

/**
 * Writes one side of a comparison to the temporary folder, named after the
 * file and the moment it stands for (`login (before turn 5).ts`), so the
 * editor's diff says what it compares and highlights it as the file's type.
 */
export async function writeSide($: EngineInterface, key: string, label: string, moment: string, text: string) {
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  const { name } = splitLabel(label)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const path = joinPath(joinPath(joinPath(temp, 'canopy'), hashOf(key)), `${stem} (${moment})${extension}`)
  await $.fs.write(path, text)

  return path
}
