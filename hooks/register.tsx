import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Lang, TouchedFile, TurnRecord } from '../types'
import { findEditor, setEditor } from './editor'
import type { EditorChoice } from './editor'
import { textOf } from './git'
import { hasDiff, isClaude, withFile, withLast } from './model'
import { PANE, actOn, renderPane } from './pane'
import { isRecord, keyOf, labelOf } from './paths'
import { captureStart, refreshCatalog, rootOf, scheduleScan, settleScan, stopScans } from './scan'
import { STRINGS, detectLang } from './text'

const history = atom({ plugin: 'canopy', key: 'history' } as const, [])
const shown = atom({ plugin: 'canopy', key: 'shown' } as const, null)
const root = atom({ plugin: 'canopy', key: 'root' } as const, '')
const opened = atom({ plugin: 'canopy', key: 'opened' } as const, null)
const mode = atom({ plugin: 'canopy', key: 'mode' } as const, 'turn')
const lang = atom({ plugin: 'canopy', key: 'lang' } as const, 'en')
const editor = atom({ plugin: 'canopy', key: 'editor' } as const, null)
const git = atom({ plugin: 'canopy', key: 'git' } as const, null)
const SNAPSHOT = { plugin: 'canopy', key: 'snapshot' } as const

type Touch = { kind: 'read' | 'edit' | 'write'; path: string } | { kind: 'search' } | { kind: 'command' }

const SEARCH_TOOLS = new Set(['Glob', 'Grep'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const LANGS = new Set<string>(['en', 'it'])
const EDITORS = new Set<string>(['auto', 'intellij', 'vscode', 'off'])

export const register: Register = (on, options) => {
  const keep = Math.min(20, Math.max(2, Number(options['turns'] ?? 10) || 10))
  const chosenLang = String(options['language'] ?? 'auto')
  const fixed = LANGS.has(chosenLang) ? (chosenLang as Lang) : undefined
  const chosenEditor = String(options['editor'] ?? 'auto')
  const editorPath = String(options['editorPath'] ?? '')

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'canopy', description: STRINGS[fixed ?? 'en'].command })
    const base = await rootOf($)
    await update($, root, () => base)
    if (fixed !== undefined) await update($, lang, () => fixed)
    void $.ui.open({ id: PANE, title: STRINGS[fixed ?? 'en'].title })

    // The language, the editor and the search's catalogue: found off the startup path
    $.clock.after(0, () => {
      void (async () => {
        if (fixed === undefined) {
          const found = await detectLang($).catch((): Lang => 'en')
          await update($, lang, () => found)
          // The menu's line for /canopy, asked again in the language just found
          $.ui.invalidate('command.describe')
        }
        const choice = (EDITORS.has(chosenEditor) ? chosenEditor : 'auto') as EditorChoice
        const ide = await findEditor($, choice, editorPath).catch(() => undefined)
        setEditor(ide)
        await update($, editor, () => ide?.name ?? null)
      })().catch(() => undefined)
      refreshCatalog($, null)
    })

    return next(e)
  })

  // The command reads in the pane's language in the menu and in /help, once it is known
  on('command.describe', { command: 'canopy' }, async ($, e, next) => {
    const described = await next(e)

    return { ...described, description: STRINGS[fixed ?? (await read($, lang))].command }
  })

  // The pane is the whole answer: no line for the model to read
  on('command.run', { command: 'canopy' }, async $ => {
    const s = STRINGS[fixed ?? (await read($, lang))]
    await $.ui.open({ id: PANE, title: s.title })

    return {}
  })

  on('session.end', async ($, e, next) => {
    stopScans()
    if (e.reason === 'clear') {
      await update($, history, () => [])
      await update($, shown, () => null)
      await update($, opened, () => null)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    // The last turn's changes belong to it, not to this one
    await settleScan($)
    const startedAt = await $.clock.now()
    const before = await read($, history)
    const dropped = before.slice(0, Math.max(0, before.length - keep + 1))
    for (const turn of dropped) {
      for (const file of turn.files.filter(hasDiff)) {
        await update($, atom({ ...SNAPSHOT, id: `${turn.id}|${file.key}` }, {}), () => ({}))
      }
    }

    await update($, history, list => {
      const turn: TurnRecord = {
        id: e.turnId,
        number: (list.at(-1)?.number ?? 0) + 1,
        prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 200),
        startedAt,
        durationMs: null,
        endReason: null,
        files: [],
        searches: 0,
        commands: 0,
        runs: [],
      }

      return [...list, turn].slice(-keep)
    })
    // A new task brings the pane back to the latest turn
    await update($, shown, () => null)
    // What the files were as it began, kept off this path
    captureStart($, e.turnId)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, history, list =>
        list.map(turn => (turn.id === e.turnId ? { ...turn, durationMs: e.durationMs, endReason: e.reason } : turn)),
      )
      // The texts as the turn left them, so an older turn's diff stays its own
      const turn = (await read($, history)).find(one => one.id === e.turnId)
      for (const file of turn?.files.filter(isClaude) ?? []) {
        if (file.via !== undefined && file.edits === 0) continue
        const after = await textOf($, file.path)
        await update($, atom({ ...SNAPSHOT, id: `${e.turnId}|${file.key}` }, {}), current => ({ ...current, after }))
      }
      // What changed without a file tool (a command, a hook, an editor): asked once the answer is out
      scheduleScan($, 0)
    }

    return next(e)
  })

  // Subagents' calls count toward the main turn that spawned them
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const touch: Touch | undefined =
      e.tool === 'Read'
        ? { kind: 'read', path: e.file_path }
        : e.tool === 'Edit'
          ? { kind: 'edit', path: e.file_path }
          : e.tool === 'Write'
            ? { kind: 'write', path: e.file_path }
            : e.tool === 'NotebookEdit'
              ? { kind: 'edit', path: e.notebook_path }
              : SEARCH_TOOLS.has(tool)
                ? { kind: 'search' }
                : SHELL_TOOLS.has(tool)
                  ? { kind: 'command' }
                  : undefined

    if (touch === undefined) return next(e)

    if (touch.kind === 'search') {
      await update($, history, list => withLast(list, turn => ({ ...turn, searches: turn.searches + 1 })))

      return next(e)
    }

    if (touch.kind === 'command') {
      // When it runs, so what it writes is told from what anything else writes
      const from = await $.clock.now()
      let slot = -1
      await update($, history, list =>
        withLast(list, turn => {
          slot = turn.runs.length

          return { ...turn, commands: turn.commands + 1, runs: [...turn.runs, [from, -1]] }
        }),
      )
      const ran = await next(e)
      const to = await $.clock.now()
      await update($, history, list =>
        withLast(list, turn => ({
          ...turn,
          runs: turn.runs.map((run, at): [number, number] => (at === slot ? [run[0], to] : run)),
        })),
      )
      // What the command wrote, git tells a moment later: never on this path
      scheduleScan($)

      return ran
    }

    const base = (await read($, root)) || (await rootOf($))
    const seed = { key: keyOf(touch.path), path: touch.path, label: labelOf(touch.path, base) }
    const pending = touch.kind === 'read' ? 'read' : 'edit'

    // Before the turn's first change to the file: what its diff starts from
    if (pending === 'edit') {
      const turnId = (await read($, history)).at(-1)?.id ?? 'orphan'
      const snapshot = atom({ ...SNAPSHOT, id: `${turnId}|${seed.key}` }, {})
      if ((await read($, snapshot)).before === undefined) {
        const was = await textOf($, touch.path)
        await update($, snapshot, current => (current.before === undefined ? { ...current, before: was } : current))
      }
    }

    await update($, history, list =>
      withLast(list, turn => withFile(turn, seed, file => ({ ...file, running: file.running + 1, pending }))),
    )

    const ran = await next(e)
    const isDone = ran.deny === undefined && ran.isError !== true
    const isCreated = isDone && touch.kind === 'write' && isRecord(ran.result) && ran.result.type === 'create'

    await update($, history, list =>
      withLast(list, turn =>
        withFile(turn, seed, (file): TouchedFile => {
          const running = Math.max(0, file.running - 1)
          const settled = { ...file, running, pending: running > 0 ? file.pending : null }

          if (!isDone) return { ...settled, failures: file.failures + 1 }
          if (isCreated) return { ...settled, isCreated: true }
          if (touch.kind === 'read') return { ...settled, reads: file.reads + 1 }

          return { ...settled, edits: file.edits + 1 }
        }),
      ),
    )
    // A new file joins the search's catalogue; the commit view follows a tool's edits too
    if (isCreated) refreshCatalog($, await read($, git))
    if (pending === 'edit' && (await read($, mode)) === 'commit') scheduleScan($)

    return ran
  }).catch(($, e, next) => next(e)) // a slip in the bookkeeping never costs the tool call

  // A click in the desktop's list: open the file, fold a folder, reveal a found one
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'tree' || !isRecord(e.data)) return next(e)
    const { gen, row } = e.data
    if (typeof gen !== 'number' || typeof row !== 'number') return next(e)
    await actOn($, gen, row)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'canopy' }, ($, e) => renderPane($, e, fixed))
}
