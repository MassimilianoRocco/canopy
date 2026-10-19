import type { EngineInterface } from 'claude-code'

import type { FileText, GitFile, GitStatus } from '../types'
import { isUnder, joinPath, keyOf, labelOf } from './paths'

export const MAX_TEXT = 1_000_000
const MAX_GIT_FILES = 2000
const MAX_IGNORED = 2000
const MAX_INDEX = 100_000
// Outside a repository the search walks the folder itself, this far at most
const MAX_WALK = 20_000

// Folders never opened by themselves, dimmed even outside a repository
export const HEAVY = new Set([
  'node_modules', '.angular', 'dist', 'target', 'build', 'out', 'coverage',
  '.idea', '.vscode', '.gradle', '.next', '.nuxt', '.cache', '__pycache__', '.venv',
])
export const HIDDEN = new Set(['.git'])

type Process = {
  run: (
    argv: readonly string[],
    init?: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; isStdoutTruncated: boolean }>
}

type Files = {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
}

// A file holding a NUL byte is binary: its text would diff and count as noise
export async function textOf($: { fs: Files }, path: string): Promise<FileText> {
  const isThere = await $.fs.exists(path).catch(() => false)
  if (!isThere) return { kind: 'missing' }
  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined || text.length > MAX_TEXT || text.includes('\0')) return { kind: 'too-large' }

  return { kind: 'text', text }
}

type Session = {
  root: () => Promise<string>
  cwd: () => Promise<string>
}

// The project's folder, the tree's root: a shell `cd` moves the cwd, never this
export function rootOf($: { session: Session }) {
  return $.session.root().catch(() => $.session.cwd()).catch(() => '')
}

// Kept once found; null (outside a repository, or no `$.process` here) is asked again
let repoTop: string | undefined

// Asked from the project's folder: from the session's cwd, which a shell `cd`
// moves, it could name another repository and keep it
export async function topOf($: { process: Process; session: Session }): Promise<string | null> {
  if (repoTop !== undefined) return repoTop
  const base = await rootOf($)
  const out = await $.process
    .run(['git', 'rev-parse', '--show-toplevel'], { ...(base === '' ? {} : { cwd: base }), timeoutMs: 5000 })
    .catch(() => undefined)
  const top = out?.exitCode === 0 ? out.stdout.trim().replace(/\/+$/, '') : ''
  if (top === '') return null
  repoTop = top

  return top
}

const codeOf = (xy: string): GitFile['code'] => {
  if (xy === '??') return '?'
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'U'
  if (xy.includes('D')) return 'D'
  if (xy.startsWith('A')) return 'A'
  if (/[RC]/.test(xy)) return 'R'

  return 'M'
}

// Every git call here runs without optional locks, as an editor's scan does:
// a plain status refreshes the index under `index.lock`, and a commit the
// model runs meanwhile would fail
function git($: { process: Process }, top: string, args: readonly string[]) {
  return $.process.run(['git', '--no-optional-locks', ...args], { cwd: top, timeoutMs: 10_000 }).catch(() => undefined)
}

/**
 * One `git status`; null outside a repository or where git can't run. With
 * `withCounts`, each tracked file's lines added and removed since the last
 * commit too: one `git diff --numstat` more.
 */
export async function readGit($: EngineInterface, withCounts = false): Promise<GitStatus | null> {
  const top = await topOf($)
  if (top === null) return null
  const out = await git($, top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (out === undefined || out.exitCode !== 0) return null

  // `XY path\0`, a rename or copy followed by its source path
  const files: GitFile[] = []
  const fields = out.stdout.split('\0')
  for (let at = 0; at < fields.length && files.length < MAX_GIT_FILES; at++) {
    const field = fields[at]!
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    const from = /[RC]/.test(xy) ? fields[++at] : undefined
    files.push({ rel: field.slice(3), code: codeOf(xy), ...(from === undefined || from === '' ? {} : { from }) })
  }
  const counts = withCounts && files.length > 0 ? await readCounts($, top) : undefined

  return {
    at: await $.clock.now(),
    top,
    files: files.map(file => {
      const count = counts?.get(file.rel)

      return count === undefined ? file : { ...file, added: count[0], removed: count[1] }
    }),
  }
}

/**
 * Lines added and removed since the last commit, by repo-relative path (a
 * rename by its new one): `added\tremoved\tpath\0`, a rename's path empty and
 * its source and new path after it; a binary file's counts are `-`. Empty
 * before the first commit, or where git can't say.
 */
async function readCounts($: EngineInterface, top: string) {
  const counts = new Map<string, [number, number]>()
  const out = await git($, top, ['diff', '--numstat', '-z', '-M', 'HEAD'])
  if (out === undefined || out.exitCode !== 0 || out.isStdoutTruncated) return counts
  const fields = out.stdout.split('\0')
  for (let at = 0; at < fields.length; at++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[at]!)
    if (match === null) continue
    let rel = match[3]!
    if (rel === '') {
      rel = fields[at + 2] ?? ''
      at += 2
    }
    if (rel !== '' && match[1] !== '-' && match[2] !== '-') counts.set(rel, [Number(match[1]), Number(match[2])])
  }

  return counts
}

/** The last commit's text of a repo-relative path; missing when git doesn't track it. */
export async function headText($: { process: Process; session: Session }, rel: string): Promise<FileText> {
  const top = await topOf($)
  if (top === null) return { kind: 'missing' }
  const out = await $.process
    .run(['git', 'show', `HEAD:${rel}`], { cwd: top, timeoutMs: 10_000 })
    .catch(() => undefined)
  if (out === undefined || out.exitCode !== 0) return { kind: 'missing' }
  if (out.isStdoutTruncated || out.stdout.length > MAX_TEXT) return { kind: 'too-large' }

  return { kind: 'text', text: out.stdout }
}

// The last commit's texts the pane showed, until the next scan
const heads = new Map<string, { at: number; text: FileText }>()

export const clearHeads = () => heads.clear()

export async function headOf($: EngineInterface, status: GitStatus, rel: string) {
  const kept = heads.get(rel)
  if (kept?.at === status.at) return kept.text
  const text = await headText($, rel)
  heads.set(rel, { at: status.at, text })

  return text
}

// ---- The catalogue: every file the search can find, and what git ignores ----

/** The project's files, relative to the tree's root, as the search reads them. */
let index: { base: string; files: string[] } | undefined

export const indexOf = (base: string) => (index !== undefined && index.base === base ? index.files : undefined)

const splitZ = (out: string) => out.split('\0').filter(part => part !== '')

/** What a listing found; `isSameIndex` when the search's files are those it held already. */
type Found = { top: string; ignored: string[]; count: number; isCut: boolean; isSameIndex: boolean }

// Puts `files` in the index, and says whether they were there already
const setIndex = (base: string, files: string[]) => {
  const isSame =
    index !== undefined &&
    index.base === base &&
    index.files.length === files.length &&
    index.files.every((one, at) => one === files[at])
  index = { base, files }

  return isSame
}

/**
 * Lists the files under `base` and what git ignores: two `git ls-files`, or
 * outside a repository a bounded walk of the folder that skips the heavy ones.
 */
export async function readCatalog($: EngineInterface, base: string, status: GitStatus | null): Promise<Found> {
  const top = await topOf($)
  if (top !== null) {
    const listed = await git($, top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    const ignoredOut = await git($, top, [
      'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory',
    ])
    if (listed !== undefined && listed.exitCode === 0) {
      const gone = new Set((status?.files ?? []).filter(file => file.code === 'D').map(file => file.rel))
      // The tree's root may be a folder inside the repository
      const prefix =
        keyOf(base) === keyOf(top) ? '' : isUnder(keyOf(base), keyOf(top)) ? `${labelOf(base, top)}/` : undefined
      const files: string[] = []
      for (const rel of splitZ(listed.stdout)) {
        if (files.length >= MAX_INDEX) break
        if (gone.has(rel)) continue
        if (prefix === undefined) continue
        if (prefix === '' || rel.toLowerCase().startsWith(prefix.toLowerCase())) files.push(rel.slice(prefix.length))
      }
      const isSameIndex = setIndex(base, files)
      const ignored =
        ignoredOut !== undefined && ignoredOut.exitCode === 0
          ? splitZ(ignoredOut.stdout).slice(0, MAX_IGNORED).map(rel => rel.toLowerCase())
          : []

      return {
        top,
        ignored,
        count: files.length,
        isCut: listed.isStdoutTruncated || files.length >= MAX_INDEX,
        isSameIndex,
      }
    }
  }

  // No repository: walk the folder, breadth first
  const files: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && files.length < MAX_WALK) {
    const rel = queue.shift()!
    const entries = await $.fs.list(rel === '' ? base : joinPath(base, rel)).catch(() => [])
    for (const entry of entries) {
      if (HIDDEN.has(entry.name)) continue
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.kind === 'dir') {
        if (!HEAVY.has(entry.name)) queue.push(child)
      } else {
        files.push(child)
      }
    }
  }
  const isSameIndex = setIndex(base, files)

  return { top: '', ignored: [], count: files.length, isCut: files.length >= MAX_WALK, isSameIndex }
}
