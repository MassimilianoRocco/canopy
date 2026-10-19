# Canopy

A live project tree beside your Claude Code conversation. Every file Claude
changes lights up in the tree, turn by turn, and a click shows that
turn's diff — or sends you to the exact line in IntelliJ or VS Code.

Like a cockpit canopy, it is the glass you look through while Claude flies:
the whole project under it, and what each turn touched marked on it.

## What it shows

- **The project tree**, IDE style: each file with its type's badge where an
  IDE draws its icon (`TS`, `MD`, `{}` on a tint of the language's colour,
  left out when the pane is narrow), a changed file's name in blue, a new one in
  green, one git doesn't track in orange, a deleted one struck through, a
  refused edit in red with a `!`; its lines added and removed at the right edge
  (`+12 −3`), a word where the colour means more than a change (*new*,
  *renamed*, *untracked*), and a dot on every folder holding a change. It folds
  like the sections above it.
- **Each turn's footprint**: the files Claude edited or created, and the ones
  its shell commands wrote (`sed`, `npm install`, code generators) — which
  file-tool-only views miss. A line above the lists sums it up: how many files,
  how many lines, how many commands. What Claude only reads or searches is left
  out: it says little (what it read in earlier turns it still knows), and would
  draw the pane again for nothing.
- **Other changes**, in their own folded section: files that changed during the
  turn outside Claude's edits and commands (you in your IDE, a formatter run by
  a hook, a watcher left running).
- **Outside the project**, folded too: what Claude wrote beyond the project's
  folder (a scratch file, a setting in your home folder), worth a look but
  kept out of the project's summary.
- **The diff of a turn**, not just against the last commit: the whole file with
  its changes coloured, or only the changes, block by block. The last ten turns
  stay one click away.
- **Since the last commit**, as a second view, for the whole picture.

## Working with it

- **Search** the project from the field above the tree: every word must match
  the path, the match is marked, and Enter opens the best hit. A folder found
  opens in the tree.
- **Open in IntelliJ / VS Code** jumps to the change you are looking at, in the
  window that already has the project open. Each block in *Only changes* has its
  own `↗`.
- **Compare in IntelliJ / VS Code** opens the editor's own diff of that turn
  alone: the file as the turn found it beside the file now — side by side,
  editable, each block revertible from the editor. The older side is a copy in
  the temporary folder (`login (before the turn).ts`), written over at each
  comparison rather than piled up.
- **Copy path** puts the file's path on the clipboard as a prompt takes it:
  from the project's folder (`src/app/login.ts`), whole for a file outside it.
- What git ignores (`node_modules/`, `dist/`, `.env`) is dimmed and never opened
  by itself.
- On a desktop: hover highlight, keyboard navigation (↑ ↓ Enter ← →) after a click
  in the list. Should the coloured list ever fail to draw there, the pane lists
  plain buttons instead and says why.

## Cost

None in tokens: Canopy never calls the model and adds nothing to the context;
`/canopy` leaves no line for the model to read. Git is asked on timers, after a
burst of shell commands and once a turn has ended, never on a tool's path; every
git call runs without optional locks, so it never takes `index.lock` from a
commit running beside it.

## Install

At the prompt of a terminal session:

```
/plugin install canopy --marketplace MassimilianoRocco/canopy
```

Answer `y` to add the marketplace, then pick a scope (user: every project).
From a shell:

```
claude plugin install canopy --marketplace MassimilianoRocco/canopy
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `MassimilianoRocco/canopy`, then Add
plugin.

The pane opens by itself as a session starts; closed, `/canopy` brings it
back. Turn it off and on from the app's plugin
list, or with `claude plugin disable canopy` / `claude plugin enable canopy`.

To update to a newer version:

```
claude plugin marketplace update canopy
claude plugin update canopy@canopy
```

Offline, from a copy of this repository: run `install.ps1` on Windows, or
`claude plugin marketplace add /path/to/canopy` then
`claude plugin install canopy@canopy`.

## Options

| Option | Values | Default |
| --- | --- | --- |
| Language | `auto`, `en`, `it` | `auto` (the system's) |
| Turns kept | `5`, `10`, `20` | `10` |
| Editor | `auto`, `intellij`, `vscode`, `off` | `auto` (IntelliJ, then VS Code) |
| Editor launcher | a path to `idea64.exe`, `idea`, `code`… | found by itself |

Any JetBrains IDE works through its launcher (`webstorm64.exe`, `pycharm`…).

## Limits

- One git repository: the project folder or a folder inside one.
- Files over 1 MB are listed but not diffed. A diff too long for one drawing
  (some 90,000 characters) shows only its changes, as many as fit; a file shown
  as it is, its first lines. The texts kept for the diffs are bounded too: past
  some six million characters in one turn (24 million in all), a file is
  listed but not diffed.
- The tree lists 800 rows at most, 300 a folder, and says so where it stops:
  close a few folders to see the rest. On a desktop the list draws the rows
  around what the pane shows, and draws the next ones as you scroll.
- After a command, git is asked about the first 200 files it lists as changed:
  in a repository with more (a folder of untracked files, say), a change to a
  file further down that list goes unseen.
- A file changed by a command is attributed by time: written while one of
  Claude's commands ran is Claude's, anything else is an *other change*. A
  command left running in the background counts as running until its turn
  ends: what it writes in a later turn is an *other change*.

## License

MIT
