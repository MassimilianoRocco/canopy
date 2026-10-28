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
- **The diff of a turn**, not just against the last commit: only the changes,
  block by block, as a changed file opens, or the whole file with its changes
  coloured, a press away and kept once chosen. Back to the tree with `◀`, or
  its key (`A`, `T` in English) while the pane holds the keys.
- **The last ten turns** one click away: the turn's name opens the list of
  them, latest first, each with its state's dot, its files and its prompt, to
  pick one by what it was asked; `‹ ›` step through them one by one.
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
  comparison rather than piled up, and emptied as the session ends: a `.env`
  compared leaves no secret behind. One a session closed abruptly left is
  emptied a day on, as another session starts.
- **Copy path** puts the file's path on the clipboard as a prompt takes it:
  from the project's folder (`src/app/login.ts`), whole for a file outside it,
  in the system's own separators (`C:\Temp\notes.txt` on Windows).
- A prompt longer than its line opens whole with `▾` above the lists, and
  closes again with `▴`.
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

Git is asked only while the pane is drawn somewhere. A run nothing draws in
(`claude -p`, the SDK, a desktop session no window shows), a terminal too narrow
for the pane, a pane closed: Canopy keeps the list of what Claude's file tools
change, and asks git nothing until the pane is drawn again, when one scan
catches up. The search's list of the project's files is made the first time you
search, and again while you do, once files came or went: never for a pane
nobody searches in. The files a turn changed are read a few at a time as it
ends, so the turn does not wait for them one by one.

## Safety

A repository can carry a program named like a tool (`git.exe`, `idea64.exe`)
that Windows would find in the project's folder first. Canopy never starts one:
on Windows it starts its own tools from the Windows folder (`where`, `reg`,
PowerShell) and looks for git and the editors in the PATH's folders alone,
never in the project's, then starts them by their full path.

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
- A repository with more than 2,000 files git neither tracks nor ignores (a
  `venv/`, a `node_modules/` no `.gitignore` names), or whose `git status` takes
  over a second, has git list each such folder whole from then on, for the
  session, and the pane says so: a file a command makes inside a new folder is
  shown as that folder. What Claude's file tools change is listed file by file
  all the same.
- While nobody sees the pane, what commands change is caught up for the latest
  turn alone; earlier turns show what Claude's file tools changed.
- Outside a repository the search walks the folder itself: 20,000 files and
  2,000 folders at most.
- A file changed by a command is attributed by time: written while one of
  Claude's commands ran is Claude's, anything else is an *other change*. A
  command left running in the background counts as running until its turn
  ends: what it writes in a later turn is an *other change*.

## License

MIT
