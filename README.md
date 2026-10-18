# Canopy

A live project tree beside your Claude Code conversation. Every file Claude
reads or changes lights up in the tree, turn by turn, and a click shows that
turn's diff — or sends you to the exact line in IntelliJ or VS Code.

Like a cockpit canopy, it is the glass you look through while Claude flies:
the whole project under it, and what each turn touched marked on it.

## What it shows

- **The project tree**, IDE style: a changed file's name in blue, a new one in
  green, one git doesn't track in orange, a deleted one struck through, a
  refused edit in red, with the status letter at the right edge
  (`M A U D R !`) and a dot on every folder holding a change.
- **Each turn's footprint**: the files Claude edited or created, the ones it
  only read, and the ones its shell commands wrote (`sed`, `npm install`,
  code generators) — which file-tool-only views miss.
- **Other changes**, in their own folded section: files that changed during the
  turn outside Claude's edits and commands (you in your IDE, a formatter run by
  a hook, a watcher left running).
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
  editable, each block revertible from the editor.
- What git ignores (`node_modules/`, `dist/`, `.env`) is dimmed and never opened
  by itself.
- On a desktop: hover highlight, keyboard navigation (↑ ↓ Enter ← →) after a click
  in the list.

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

Then open the pane with `/canopy`. Turn it off and on from the app's plugin
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
- Files over 1 MB are listed but not diffed.
- A file changed by a command is attributed by time: written while one of
  Claude's commands ran is Claude's, anything else is an *other change*.

## License

MIT
