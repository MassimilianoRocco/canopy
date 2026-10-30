import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Lang, TouchedFile, TurnRecord } from '../types'
import { emptySides, findEditor, setEditor, sweepSides } from './editor'
import type { EditorChoice } from './editor'
import { rootOf, textOf } from './git'
import { forgetListings } from './listing'
import { isClaude, withFile, withTurn } from './model'
import { noteFault } from './actions'
import { PANE, actOn, renderPane } from './pane'
import { isRecord, keyOf, labelOf } from './paths'
import {
  captureStart,
  closeOpening,
  countLater,
  keepText,
  noteFilesChanged,
  onDrawn,
  recountTexts,
  releaseTexts,
  scheduleScan,
  settleScan,
  stopScans,
} from './scan'
import { STRINGS, detectLang } from './text'
import { noteOpened, noteUnseen } from './watch'

const history = atom({ plugin: 'canopy', key: 'history' } as const, [])
const shown = atom({ plugin: 'canopy', key: 'shown' } as const, null)
const root = atom({ plugin: 'canopy', key: 'root' } as const, '')
const opened = atom({ plugin: 'canopy', key: 'opened' } as const, null)
const mode = atom({ plugin: 'canopy', key: 'mode' } as const, 'turn')
const lang = atom({ plugin: 'canopy', key: 'lang' } as const, 'en')
const editor = atom({ plugin: 'canopy', key: 'editor' } as const, null)
const promptOpen = atom({ plugin: 'canopy', key: 'isPromptOpen' } as const, false)
const turnsOpen = atom({ plugin: 'canopy', key: 'isTurnsOpen' } as const, false)
const opening = atom({ plugin: 'canopy', key: 'opening' } as const, 'pending')
const SNAPSHOT = { plugin: 'canopy', key: 'snapshot' } as const

// What Canopy follows of a tool call: a file it edits or writes, or a command. What Claude
// reads or searches tells little (what it read in earlier turns it knows all the same), and
// each would cost the pane two drawings
type Touch = { kind: 'edit' | 'write'; path: string } | { kind: 'command' }

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

// The files a turn changed, read at once as it ends: the turn waits for the slowest of a few
const READ_AT_ONCE = 4

// A turn's prompt as kept, in characters
const MAX_PROMPT = 2000

const LANGS = new Set<string>(['en', 'it'])
const EDITORS = new Set<string>(['auto', 'intellij', 'vscode', 'off'])

/** Clears every text kept for these turns' diffs, a refused edit's too: they leave the history. */
async function forget($: Parameters<typeof read>[0], turns: readonly TurnRecord[]) {
  releaseTexts(turns.map(turn => turn.id))
  for (const turn of turns) {
    for (const file of turn.files) {
      await update($, atom({ ...SNAPSHOT, id: `${turn.id}|${file.key}` }, {}), () => ({}))
    }
  }
}

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
    // Not placed (no surface yet, a narrow terminal), git waits for its first drawing
    void $.ui
      .open({ id: PANE, title: STRINGS[fixed ?? 'en'].title })
      .then(noteOpened)
      .catch(() => undefined)

    // The language and the editor: found off the startup path. The comparisons' copies a
    // session closed abruptly left behind, emptied; the room the texts kept take, counted
    // again after a reload
    $.clock.after(0, () => {
      void sweepSides($).catch(() => undefined)
      void recountTexts($).catch(() => undefined)
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
    noteOpened(await $.ui.open({ id: PANE, title: s.title }))

    return {}
  })

  // The pane closed: git waits for its next drawing
  on('ui.close', ($, e, next) => {
    if (e.id === PANE) noteUnseen()

    return next(e)
  })

  // A window left: where no surface places the pane any more, git waits too
  on('session.detach', ($, e, next) => {
    if (e.reason !== 'end') {
      void $.ui
        .panes()
        .then(panes => {
          if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) noteUnseen()
        })
        .catch(() => undefined)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopScans()
    // A /clear or a /resume: the process goes on with another conversation, which has none of these turns
    const isOver = e.reason === 'clear' || e.reason === 'resume'
    // What the pane shows first, in a few writes: an end has one short bound for every
    // plugin, and the texts, one write per file, may not all fit in it
    const dropped = isOver ? await read($, history) : []
    if (isOver) {
      await update($, history, () => [])
      await update($, shown, () => null)
      await update($, opened, () => null)
      // Its first drawing chooses its view again, on the work it finds left
      await update($, opening, () => 'pending')
    }
    // The comparisons' copies, a few files at most: a secret kept no longer than the session
    await emptySides($)
    await forget($, dropped)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    // The last turn's changes belong to it, not to this one
    await settleScan($)
    const startedAt = await $.clock.now()
    const before = await read($, history)
    await forget($, before.slice(0, Math.max(0, before.length - keep + 1)))

    await update($, history, list => {
      const turn: TurnRecord = {
        id: e.turnId,
        number: (list.at(-1)?.number ?? 0) + 1,
        // Enough to read it whole in the pane, opened
        prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT),
        startedAt,
        durationMs: null,
        endReason: null,
        files: [],
        commands: 0,
        runs: [],
      }

      return [...list, turn].slice(-keep)
    })
    // A new task brings the pane back to the latest turn, its prompt on one line, its files listed
    await update($, shown, () => null)
    await update($, promptOpen, () => false)
    await update($, turnsOpen, () => false)
    await closeOpening($)
    // What the files were as it began, kept off this path
    captureStart($, e.turnId)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A command still running in the background is Claude's up to here; what it writes later, another turn's
      const endedAt = await $.clock.now()
      await update($, history, list =>
        list.map(turn =>
          turn.id === e.turnId
            ? {
                ...turn,
                durationMs: e.durationMs,
                endReason: e.reason,
                runs: turn.runs.map(([from, to]): [number, number] => [from, to < 0 ? endedAt : to]),
              }
            : turn,
        ),
      )
      // The texts as the turn left them, so an older turn's diff stays its own: read a few
      // at a time, kept in the turn's order, so the room they take is counted as before
      const turn = (await read($, history)).find(one => one.id === e.turnId)
      const files = (turn?.files.filter(isClaude) ?? []).filter(file => file.via === undefined || file.edits > 0)
      for (let at = 0; at < files.length; at += READ_AT_ONCE) {
        const batch = files.slice(at, at + READ_AT_ONCE)
        const texts = await Promise.all(batch.map(file => textOf($, file.path)))
        for (const [n, file] of batch.entries()) {
          const after = keepText(e.turnId, texts[n]!)
          await update($, atom({ ...SNAPSHOT, id: `${e.turnId}|${file.key}` }, {}), current => ({ ...current, after }))
          countLater($, e.turnId, file.key)
        }
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
      e.tool === 'Edit'
        ? { kind: 'edit', path: e.file_path }
        : e.tool === 'Write'
          ? { kind: 'write', path: e.file_path }
          : e.tool === 'NotebookEdit'
            ? { kind: 'edit', path: e.notebook_path }
            : SHELL_TOOLS.has(tool)
              ? { kind: 'command' }
              : undefined

    if (touch === undefined) return next(e)

    if (touch.kind === 'command') {
      // When it runs, so what it writes is told from what anything else writes
      const from = await $.clock.now()
      const turnId = (await read($, history)).at(-1)?.id ?? 'orphan'
      let slot = -1
      await update($, history, list =>
        withTurn(list, turnId, turn => {
          slot = turn.runs.length

          return { ...turn, commands: turn.commands + 1, runs: [...turn.runs, [from, -1]] }
        }),
      )
      const ran = await next(e)
      // In the background (asked so, or sent there with Ctrl+B) the command goes on once the
      // call returns: its run stays open until the turn ends
      const isBackground = isRecord(ran.result) && typeof ran.result['backgroundTaskId'] === 'string'
      if (!isBackground) {
        const to = await $.clock.now()
        await update($, history, list =>
          withTurn(list, turnId, turn => ({
            ...turn,
            runs: turn.runs.map((run, at): [number, number] => (at === slot ? [run[0], to] : run)),
          })),
        )
      }
      // What the command wrote, git tells a moment later: never on this path
      scheduleScan($)

      return ran
    }

    const base = (await read($, root)) || (await rootOf($))
    const seed = { key: keyOf(touch.path), path: touch.path, label: labelOf(touch.path, base) }

    // Before the turn's first change to the file: what its diff starts from
    const turnId = (await read($, history)).at(-1)?.id ?? 'orphan'
    const snapshot = atom({ ...SNAPSHOT, id: `${turnId}|${seed.key}` }, {})
    if ((await read($, snapshot)).before === undefined) {
      const was = keepText(turnId, await textOf($, touch.path))
      await update($, snapshot, current => (current.before === undefined ? { ...current, before: was } : current))
    }

    await update($, history, list =>
      withTurn(list, turnId, turn =>
        withFile(turn, seed, file => ({ ...file, running: file.running + 1, pending: 'edit' as const })),
      ),
    )

    const ran = await next(e)
    const isDone = ran.deny === undefined && ran.isError !== true
    const isCreated = isDone && touch.kind === 'write' && isRecord(ran.result) && ran.result.type === 'create'

    // On the turn it began in: a subagent's call may end after a new turn started
    await update($, history, list =>
      withTurn(list, turnId, turn =>
        withFile(turn, seed, (file): TouchedFile => {
          const running = Math.max(0, file.running - 1)
          const settled = { ...file, running, pending: running > 0 ? file.pending : null }

          if (!isDone) return { ...settled, failures: file.failures + 1 }
          if (isCreated) return { ...settled, isCreated: true }

          return { ...settled, edits: file.edits + 1 }
        }),
      ),
    )
    // Its lines added and removed, counted off this path
    if (isDone) countLater($, turnId, seed.key)
    // A new file joins the tree, and the search's catalogue the next time the search reads it;
    // the commit view follows a tool's edits too
    if (isCreated) {
      forgetListings()
      noteFilesChanged()
    }
    if ((await read($, mode)) === 'commit') scheduleScan($)

    return ran
  }).catch((_, e, next) => next(e)) // a slip in the bookkeeping never costs the tool call

  // A click in the desktop's list: open the file, fold a folder, reveal a found one
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'tree' || !isRecord(e.data)) return next(e)
    const { gen, row } = e.data
    if (typeof gen !== 'number' || typeof row !== 'number') return next(e)
    await actOn($, gen, row)

    return next(e)
  })

  // The desktop's list failed (an engine that changed, a drawing past a bound): the pane, which
  // the engine draws again right after, leaves it out there and lists Buttons instead
  on('ui.fault', ($, e, next) => {
    if (e.requestId === PANE && e.element === 'tree') noteFault(e.surface, e.reason)

    return next(e)
  })

  // Drawn, the pane is seen: what waited for it is done now
  on('ui.render', { component: 'Pane', requestId: 'canopy' }, ($, e) => {
    onDrawn($)

    return renderPane($, e, fixed)
  })
}
