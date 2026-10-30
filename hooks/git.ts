import type { EngineInterface } from 'claude-code'

import type { FileText, GitFile, GitStatus, LocalCommit, Pushing } from '../types'
import { isUnder, joinPath, keyOf, labelOf } from './paths'
import { gitOf } from './programs'

export const MAX_TEXT = 1_000_000
const MAX_GIT_FILES = 2000
const MAX_IGNORED = 2000
const MAX_INDEX = 100_000
// Outside a repository the search walks the folder itself: this many files at
// most, and this many folders opened, so a tree of folders holding few files ends too
const MAX_WALK = 20_000
const MAX_WALKED = 2000

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

type Env = { get: (name: string) => Promise<string | undefined> }

/** What starting git takes: a process, the session's folders, and the variables that say where git is. */
type Git = { process: Process; session: Session; env: Env }

// The project's folder, the tree's root: a shell `cd` moves the cwd, never this
export function rootOf($: { session: Session }) {
  return $.session.root().catch(() => $.session.cwd()).catch(() => '')
}

// Kept once found; null (outside a repository, or no `$.process` here) is asked again
let repoTop: string | undefined

// Asked from the project's folder: from the session's cwd, which a shell `cd`
// moves, it could name another repository and keep it
export async function topOf($: Git): Promise<string | null> {
  if (repoTop !== undefined) return repoTop
  const program = await gitOf($)
  if (program === null) return null
  const base = await rootOf($)
  const out = await $.process
    .run([program, 'rev-parse', '--show-toplevel'], { ...(base === '' ? {} : { cwd: base }), timeoutMs: 5000 })
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
async function git($: Git, top: string, args: readonly string[]) {
  const program = await gitOf($)
  if (program === null) return undefined

  return $.process.run([program, '--no-optional-locks', ...args], { cwd: top, timeoutMs: 10_000 }).catch(() => undefined)
}

// Past this many files unknown to git in one status, or this long for one,
// the repository holds folders git neither tracks nor ignores (a `venv/`, a
// `node_modules/` no .gitignore names), listed file by file after every
// command: from then on, for the session, git lists each as one entry
const MAX_UNTRACKED = 2000
const SLOW_STATUS = 1000
let untracked: 'all' | 'normal' = 'all'

/** Whether git lists the folders it doesn't know whole, not file by file. */
export const isFolded = () => untracked === 'normal'

// With the branch first: `## main...origin/main [ahead 2]`
function statusOf($: Git, top: string) {
  return git($, top, ['status', '--porcelain=v1', '-z', '--branch', `--untracked-files=${untracked}`])
}

/** The branch a status names, its upstream (null for none), and how many commits it is ahead of it. */
type Branch = { name: string; upstream: string | null; ahead: number }

/**
 * The branch from the line `status --branch` puts first: `main`,
 * `main...origin/main [ahead 2, behind 1]`. Null on a detached HEAD
 * (`HEAD (no branch)`) or before the first commit (`No commits yet on main`):
 * a branch's name holds no space, nor the `...` before its upstream.
 */
export function branchOf(line: string): Branch | null {
  const body = line.slice(3)
  const at = body.indexOf('...')
  const name = at === -1 ? body : body.slice(0, at)
  if (name === '' || name.includes(' ')) return null
  const track = at === -1 ? null : /^(\S+)(?: \[([^\]]*)\])?$/.exec(body.slice(at + 3))
  // An upstream deleted since (`[gone]`) is as good as none
  if (track === null || track[2] === 'gone') return { name, upstream: null, ahead: 0 }

  return { name, upstream: track[1]!, ahead: Number(/ahead (\d+)/.exec(track[2] ?? '')?.[1] ?? 0) }
}

// The commits not pushed that the commit view names: the latest few
const MAX_LISTED_COMMITS = 5

async function commitsOf($: EngineInterface, top: string, range: readonly string[]): Promise<LocalCommit[]> {
  const out = await git($, top, ['log', '-z', '--format=%h%x09%s', `--max-count=${MAX_LISTED_COMMITS}`, ...range])
  if (out === undefined || out.exitCode !== 0) return []

  return splitZ(out.stdout).map(entry => {
    const at = entry.indexOf('\t')

    return { hash: entry.slice(0, at), subject: entry.slice(at + 1, at + 1 + 200) }
  })
}

/**
 * The commits of `branch` no remote has: from git's own count against the
 * upstream, the list asked only when there is one; with no upstream (a branch
 * never pushed as itself), the commits on none of the remotes. Undefined in a
 * repository with no remote, where there is nothing to push to.
 */
async function readPushing($: EngineInterface, top: string, branch: Branch): Promise<Pushing | undefined> {
  if (branch.upstream !== null) {
    const commits = branch.ahead === 0 ? [] : await commitsOf($, top, ['@{upstream}..HEAD'])

    return { branch: branch.name, count: branch.ahead, commits }
  }
  const remote = await git($, top, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'])
  if (remote === undefined || remote.exitCode !== 0 || remote.stdout.trim() === '') return undefined
  const counted = await git($, top, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  const count = counted?.exitCode === 0 ? Number(counted.stdout.trim()) || 0 : 0
  const commits = count === 0 ? [] : await commitsOf($, top, ['HEAD', '--not', '--remotes'])

  return { branch: branch.name, count, commits }
}

/**
 * One `git status`; null outside a repository or where git can't run. With
 * `withCounts`, what the commit view draws besides: each tracked file's lines
 * added and removed since the last commit (one `git diff --numstat` more), and
 * the branch's commits no remote has (one `git log` more, where there are some).
 */
export async function readGit($: EngineInterface, withCounts = false): Promise<GitStatus | null> {
  const top = await topOf($)
  if (top === null) return null
  const from = await $.clock.now()
  let out = await statusOf($, top)
  if (out === undefined || out.exitCode !== 0) return null
  if (untracked === 'all') {
    const took = (await $.clock.now()) - from
    const unknown = out.stdout.split('\0').filter(field => field.startsWith('?? ')).length
    if (unknown > MAX_UNTRACKED || took > SLOW_STATUS || out.isStdoutTruncated) {
      untracked = 'normal'
      out = await statusOf($, top)
      if (out === undefined || out.exitCode !== 0) return null
    }
  }

  // `XY path\0`, a rename or copy followed by its source path; past git's room the last one may be cut
  const files: GitFile[] = []
  const fields = out.stdout.split('\0')
  if (out.isStdoutTruncated) fields.pop()
  const branch = fields[0]?.startsWith('## ') === true ? branchOf(fields.shift()!) : null
  for (let at = 0; at < fields.length && files.length < MAX_GIT_FILES; at++) {
    const field = fields[at]!
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    const from = /[RC]/.test(xy) ? fields[++at] : undefined
    files.push({ rel: field.slice(3), code: codeOf(xy), ...(from === undefined || from === '' ? {} : { from }) })
  }
  const counts = withCounts && files.length > 0 ? await readCounts($, top) : undefined
  const pushing = withCounts && branch !== null ? await readPushing($, top, branch) : undefined

  return {
    at: await $.clock.now(),
    top,
    files: files.map(file => {
      const count = counts?.get(file.rel)

      return count === undefined ? file : { ...file, added: count[0], removed: count[1] }
    }),
    ...(isFolded() ? { isFolded: true } : {}),
    ...(pushing === undefined ? {} : { pushing }),
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
export async function headText($: Git, rel: string): Promise<FileText> {
  const top = await topOf($)
  const program = await gitOf($)
  if (top === null || program === null) return { kind: 'missing' }
  const out = await $.process
    .run([program, 'show', `HEAD:${rel}`], { cwd: top, timeoutMs: 10_000 })
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

/** What the search's listing found; `isSame` when its files are those the index held already. */
type Indexed = { count: number; isCut: boolean; isSame: boolean }

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
 * What git ignores under the repository, lowercased, a folder ending in `/`:
 * one `git ls-files`, each ignored folder one entry. Null outside a repository.
 */
export async function readIgnored($: EngineInterface): Promise<{ top: string; ignored: string[] } | null> {
  const top = await topOf($)
  if (top === null) return null
  const out = await git($, top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  const ignored = out !== undefined && out.exitCode === 0 ? splitZ(out.stdout).slice(0, MAX_IGNORED) : []

  return { top, ignored: ignored.map(rel => rel.toLowerCase()) }
}

/**
 * Lists the files under `base` into the search's index: one `git ls-files`
 * (a folder git doesn't know as one entry, left out, once it lists them whole),
 * or outside a repository a bounded walk of the folder that skips the heavy ones.
 */
export async function readIndex($: EngineInterface, base: string, status: GitStatus | null): Promise<Indexed> {
  const top = await topOf($)
  if (top !== null) {
    const listed = await git($, top, [
      'ls-files', '-z', '--cached', '--others', '--exclude-standard', ...(isFolded() ? ['--directory'] : []),
    ])
    if (listed !== undefined && listed.exitCode === 0) {
      const gone = new Set((status?.files ?? []).filter(file => file.code === 'D').map(file => file.rel))
      // The tree's root may be a folder inside the repository
      const prefix =
        keyOf(base) === keyOf(top) ? '' : isUnder(keyOf(base), keyOf(top)) ? `${labelOf(base, top)}/` : undefined
      const files: string[] = []
      for (const rel of splitZ(listed.stdout)) {
        if (files.length >= MAX_INDEX) break
        if (gone.has(rel) || rel.endsWith('/')) continue
        if (prefix === undefined) continue
        if (prefix === '' || rel.toLowerCase().startsWith(prefix.toLowerCase())) files.push(rel.slice(prefix.length))
      }

      return {
        count: files.length,
        isCut: listed.isStdoutTruncated || files.length >= MAX_INDEX,
        isSame: setIndex(base, files),
      }
    }
  }

  // No repository: walk the folder, breadth first, as far as its files and its folders allow
  const files: string[] = []
  const queue: string[] = ['']
  let walked = 0
  while (queue.length > 0 && files.length < MAX_WALK && walked < MAX_WALKED) {
    const rel = queue.shift()!
    walked += 1
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

  return {
    count: files.length,
    isCut: files.length >= MAX_WALK || (walked >= MAX_WALKED && queue.length > 0),
    isSame: setIndex(base, files),
  }
}
