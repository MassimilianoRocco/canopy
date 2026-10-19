import type { Lang } from '../types'

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const en = {
  title: 'Canopy',
  command: 'Show the project tree with the files Claude reads and changes, turn by turn',

  // The turn
  noTurn: 'No turns yet: as Claude works, the files it touches light up here.',
  turn: (n: number) => `Turn ${n}`,
  running: 'running…',
  interrupted: (took: string) => `interrupted after ${took}`,
  failedIn: (took: string) => `ended with an error in ${took}`,
  // A turn that ended well: its time says it
  finishedIn: (took: string) => took,

  // Controls
  modeTurn: 'Turn',
  modeCommit: 'Commit',
  refresh: 'Refresh',
  collapse: 'Collapse',
  search: 'Search files…',
  // What Enter does in the search: the first of the results opens
  searchOpen: 'Open first match',

  // The summary above the lists
  files: (n: number) => count(n, 'file', 'files'),
  commands: (n: number) => count(n, 'command', 'commands'),
  others: (n: number) => count(n, 'other change', 'other changes'),
  elsewhere: (n: number) => `${n} outside the project`,
  sinceCommit: 'since the last commit',

  // Notices
  askingGit: 'Asking git…',
  noRepo: 'No git repository here.',
  noChangesCommit: 'No changes since the last commit.',
  nothingTouched: 'No files changed in this turn.',

  // Sections and lists
  changes: 'Changes',
  otherChanges: 'Other changes',
  outsideProject: 'Outside the project',
  project: 'Project',
  more: (n: number) => `… ${n} more`,
  cut: '… list cut short: close a few folders',
  indexing: 'Indexing the project…',
  noMatch: (query: string) => `No file matches “${query}”.`,
  matches: (n: number) => count(n, 'file', 'files'),
  moreMatches: (n: number) => `… ${n} more: narrow the search`,

  // A file's state
  badgeRunning: 'running…',
  created: 'created',
  createdThen: (n: number) => `created, then edited ×${n}`,
  createdByCommand: 'created by a command',
  modified: 'modified',
  modifiedTimes: (n: number) => `modified ×${n}`,
  plusCommand: ' + a command',
  modifiedByCommand: 'changed by a command',
  failed: 'failed',
  outside: 'changed during the turn, outside Claude’s edits and commands',
  outsideShort: 'changed during the turn',
  // What a change's colour says, in a word
  stateNew: 'new',
  stateUntracked: 'untracked',
  stateDeleted: 'deleted',
  stateRenamed: 'renamed',
  stateFailed: 'failed',
  stateConflict: 'conflict',

  // The file view
  back: '◀ Tree',
  emptyFile: 'Empty file.',
  tooLarge: 'Too large or unreadable to show here.',
  gone: 'The file no longer exists.',
  newFile: 'new file',
  sinceTurn: 'since the turn',
  sinceHead: 'since the last commit',
  noDiffTurn: 'no difference since the turn',
  noDiffHead: 'no difference since the last commit',
  lines: (ranges: string) => `lines ${ranges}`,
  hunk: (from: number, to: number) => (from === to ? `Line ${from}` : `Lines ${from}–${to}`),
  wholeFile: 'Whole file',
  onlyChanges: 'Only changes',
  wholeTooLarge: 'too large to draw whole: only its changes',
  restNotDrawn: '… the rest of the changes is not drawn here',
  restOfFile: '… the rest of the file is not drawn here',
  noCompare: 'no comparison available',
  unchangedHead: 'unchanged since the last commit',
  unchangedTurn: 'not changed in this turn',
  open: (editor: string) => `Open in ${editor}`,
  compare: (editor: string) => `Compare in ${editor}`,
  openHere: '↗',
  editorFailed: (editor: string) => `Could not start ${editor}. Set its launcher in Canopy’s options.`,
  copyPath: 'Copy path',
  pathCopied: (path: string) => `Copied: ${path}`,
  copyFailed: 'Could not copy the path here.',
  // The desktop's coloured list failed: why, as the surface said it
  listFallback: (reason: string) => `The coloured list could not be drawn here (${reason}): this is the plain one.`,
  editorRefused: (editor: string) =>
    `${editor} starts through a script that would misread this file’s name. Set its .exe as the launcher in Canopy’s options.`,
  // A comparison's sides as their files are named: one name each, written over, so they never pile up
  sideBefore: 'before the turn',
  sideAfter: 'after the turn',
  lastCommit: 'last commit',
}

export type Strings = typeof en

const it: Strings = {
  title: 'Canopy',
  command: 'Mostra l’albero del progetto con i file che Claude legge e modifica, turno per turno',

  noTurn: 'Ancora nessun turno: quando Claude lavora, i file che tocca si colorano qui.',
  turn: n => `Turno ${n}`,
  running: 'in corso…',
  interrupted: took => `interrotto dopo ${took}`,
  failedIn: took => `finito con errore in ${took}`,
  finishedIn: took => took,

  modeTurn: 'Turno',
  modeCommit: 'Commit',
  refresh: 'Aggiorna',
  collapse: 'Comprimi',
  search: 'Cerca file…',
  searchOpen: 'Apri il primo',

  files: n => count(n, 'file', 'file'),
  commands: n => count(n, 'comando', 'comandi'),
  others: n => count(n, 'altra modifica', 'altre modifiche'),
  elsewhere: n => `${n} fuori dal progetto`,
  sinceCommit: 'dall’ultimo commit',

  askingGit: 'Interrogo git…',
  noRepo: 'Qui non c’è un repository git.',
  noChangesCommit: 'Nessuna modifica dall’ultimo commit.',
  nothingTouched: 'Nessun file modificato in questo turno.',

  changes: 'Modifiche',
  otherChanges: 'Altre modifiche',
  outsideProject: 'Fuori dal progetto',
  project: 'Progetto',
  more: n => `… altri ${n}`,
  cut: '… elenco troncato: chiudi qualche cartella',
  indexing: 'Indicizzo il progetto…',
  noMatch: query => `Nessun file corrisponde a “${query}”.`,
  matches: n => count(n, 'file', 'file'),
  moreMatches: n => `… altri ${n}: affina la ricerca`,

  badgeRunning: 'in corso…',
  created: 'creato',
  createdThen: n => `creato, poi modificato ×${n}`,
  createdByCommand: 'creato da un comando',
  modified: 'modificato',
  modifiedTimes: n => `modificato ×${n}`,
  plusCommand: ' + un comando',
  modifiedByCommand: 'modificato da un comando',
  failed: 'non riuscito',
  outside: 'cambiato durante il turno, fuori dalle modifiche e dai comandi di Claude',
  outsideShort: 'cambiato durante il turno',
  stateNew: 'nuovo',
  stateUntracked: 'non in git',
  stateDeleted: 'eliminato',
  stateRenamed: 'rinominato',
  stateFailed: 'non riuscito',
  stateConflict: 'conflitto',

  back: '◀ Albero',
  emptyFile: 'File vuoto.',
  tooLarge: 'File troppo grande o illeggibile per mostrarlo qui.',
  gone: 'Il file non esiste più.',
  newFile: 'file nuovo',
  sinceTurn: 'dal turno',
  sinceHead: 'dall’ultimo commit',
  noDiffTurn: 'nessuna differenza dal turno',
  noDiffHead: 'nessuna differenza dall’ultimo commit',
  lines: ranges => `righe ${ranges}`,
  hunk: (from, to) => (from === to ? `Riga ${from}` : `Righe ${from}–${to}`),
  wholeFile: 'File intero',
  onlyChanges: 'Solo modifiche',
  wholeTooLarge: 'troppo grande per mostrarlo intero: solo le modifiche',
  restNotDrawn: '… il resto delle modifiche non è mostrato qui',
  restOfFile: '… il resto del file non è mostrato qui',
  noCompare: 'confronto non disponibile',
  unchangedHead: 'invariato dall’ultimo commit',
  unchangedTurn: 'non modificato in questo turno',
  open: editor => `Apri in ${editor}`,
  compare: editor => `Confronta in ${editor}`,
  openHere: '↗',
  editorFailed: editor => `Non riesco ad avviare ${editor}. Indica il suo launcher nelle opzioni di Canopy.`,
  copyPath: 'Copia percorso',
  pathCopied: path => `Copiato: ${path}`,
  copyFailed: 'Non riesco a copiare il percorso qui.',
  listFallback: reason => `La lista colorata non si è potuta disegnare qui (${reason}): questa è quella semplice.`,
  editorRefused: editor =>
    `${editor} si avvia tramite uno script che leggerebbe male il nome di questo file. Indica il suo .exe come launcher nelle opzioni di Canopy.`,
  sideBefore: 'prima del turno',
  sideAfter: 'dopo il turno',
  lastCommit: 'ultimo commit',
}

export const STRINGS: Record<Lang, Strings> = { en, it }

type Probe = {
  env: { get: (name: string) => Promise<string | undefined> }
  process: {
    run: (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }>
  }
}

const langOf = (locale: string | undefined): Lang | undefined => {
  if (locale === undefined || locale === '' || locale === 'C' || locale === 'POSIX') return undefined

  return /^it(?:[-_.]|$)/i.test(locale) ? 'it' : 'en'
}

/**
 * The system's language: a Unix locale variable, else Windows' own setting,
 * read once off the startup path. English for anything Canopy doesn't speak.
 */
export async function detectLang($: Probe): Promise<Lang> {
  const fromEnv =
    langOf(await $.env.get('LC_ALL')) ?? langOf(await $.env.get('LC_MESSAGES')) ?? langOf(await $.env.get('LANG'))
  if (fromEnv !== undefined) return fromEnv
  if ((await $.env.get('OS')) !== 'Windows_NT') return 'en'

  const out = await $.process
    .run(['reg', 'query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { timeoutMs: 3000 })
    .catch(() => undefined)
  const locale = out?.exitCode === 0 ? /LocaleName\s+REG_SZ\s+(\S+)/.exec(out.stdout)?.[1] : undefined

  return langOf(locale) ?? 'en'
}
