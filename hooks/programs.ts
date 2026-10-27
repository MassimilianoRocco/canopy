import { isUnder, keyOf } from './paths'

// ---- The programs Canopy starts ----
// Windows looks for a program named without a folder in the folder it starts
// from before the PATH: from a project holding a `git.exe`, `where git` lists
// that one first, and a start by name may run it. So on Windows Canopy starts
// Windows' own programs from their folder, and looks for git and the editors
// in the PATH's folders alone (`where $PATH:git`), never in the project. Away
// from Windows a name is looked for in the PATH alone already

type Env = { env: { get: (name: string) => Promise<string | undefined> } }

export type Probe = Env & {
  process: {
    run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }>
  }
  session: { root: () => Promise<string>; cwd: () => Promise<string> }
}

// A variable that can't be read is unset
const unset = () => undefined

export async function isWindowsOf($: Env) {
  return (await $.env.get('OS').catch(unset)) === 'Windows_NT'
}

// Where each stands under the Windows folder
const SYSTEM = {
  where: 'System32\\where.exe',
  reg: 'System32\\reg.exe',
  powershell: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe',
} as const

/** One of Windows' own programs by its full path; away from Windows, its name. */
export async function systemProgram($: Env, name: keyof typeof SYSTEM) {
  if (!(await isWindowsOf($))) return name
  const windows = (await $.env.get('SystemRoot').catch(unset)) ?? (await $.env.get('windir').catch(unset)) ?? 'C:\\Windows'

  return `${windows.replace(/[\\/]+$/, '')}\\${SYSTEM[name]}`
}

/**
 * The programs named `name` in the PATH's folders, in its order, by their
 * full path. Never one under the project's folder or the session's: a PATH
 * naming `.` or a folder of the project would bring the project's back.
 */
export async function onPath($: Probe, name: string): Promise<string[]> {
  const isWindows = await isWindowsOf($)
  const argv = isWindows ? [await systemProgram($, 'where'), `$PATH:${name}`] : ['which', '-a', name]
  const out = await $.process.run(argv, { timeoutMs: 3000 }).catch(() => undefined)
  if (out === undefined || out.exitCode !== 0) return []
  const folders = [await $.session.root().catch(() => ''), await $.session.cwd().catch(() => '')]
    .filter(folder => folder !== '')
    .map(keyOf)
  const isWhole = isWindows ? /^[A-Za-z]:[\\/]/ : /^\//

  return out.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => isWhole.test(line))
    .filter(line => !folders.some(folder => keyOf(line) === folder || isUnder(keyOf(line), folder)))
}

// git as Canopy starts it: on Windows the first git.exe the PATH holds, by its full path,
// found once; asked again while none is found (not installed yet, a `where` that timed out)
let gitFound: Promise<string | null> | undefined

async function findGit($: Probe): Promise<string | null> {
  if (!(await isWindowsOf($))) return 'git'

  return (await onPath($, 'git')).find(path => /\.exe$/i.test(path)) ?? null
}

/** The git to start: `git` away from Windows, its full path on Windows; null where there is none. */
export function gitOf($: Probe): Promise<string | null> {
  const finding = gitFound ?? findGit($).catch(() => null)
  gitFound = finding
  void finding.then(found => {
    if (found === null && gitFound === finding) gitFound = undefined
  })

  return finding
}
