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
  finishedIn: (took: string) => `finished in ${took}`,

  // Controls
  modeTurn: 'Turn',
  modeCommit: 'Since last commit',
  refresh: 'Refresh',
  collapse: 'Collapse',
  search: 'Search files…',
  searchOpen: 'open',

  // Counts: a letter's words, one and many
  words: {
    M: ['modified', 'modified'],
    A: ['new', 'new'],
    U: ['untracked', 'untracked'],
    D: ['deleted', 'deleted'],
    R: ['renamed', 'renamed'],
    '!': ['failed', 'failed'],
  } as Record<string, [string, string]>,
  reads: (n: number) => count(n, 'read', 'read'),
  commands: (n: number) => count(n, 'shell command', 'shell commands'),
  others: (n: number) => count(n, 'other change', 'other changes'),
  sinceCommit: 'since the last commit',

  // Notices
  askingGit: 'Asking git…',
  noRepo: 'No git repository here.',
  noChangesCommit: 'No changes since the last commit.',
  nothingTouched: 'No files touched in this turn.',

  // Sections and lists
  changes: 'CHANGES',
  otherChanges: 'OTHER CHANGES',
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
  read: 'read',
  readTimes: (n: number) => `read ×${n}`,
  failed: 'failed',
  outside: 'changed during the turn, outside Claude’s edits and commands',
  outsideShort: 'changed during the turn',
  notes: {
    R: 'renamed',
    '?': 'untracked',
    D: 'deleted',
    U: 'conflict',
  } as Record<string, string>,

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
  noCompare: 'no comparison available',
  unchangedHead: 'unchanged since the last commit',
  unchangedTurn: 'not changed in this turn',
  open: (editor: string) => `Open in ${editor}`,
  compare: (editor: string) => `Compare in ${editor}`,
  openHere: '↗',
  editorFailed: (editor: string) => `Could not start ${editor}. Set its launcher in Canopy’s options.`,
  beforeTurn: (n: number) => `before turn ${n}`,
  afterTurn: (n: number) => `after turn ${n}`,
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
  finishedIn: took => `finito in ${took}`,

  modeTurn: 'Turno',
  modeCommit: 'Dall’ultimo commit',
  refresh: 'Aggiorna',
  collapse: 'Comprimi',
  search: 'Cerca file…',
  searchOpen: 'apri',

  words: {
    M: ['modificato', 'modificati'],
    A: ['nuovo', 'nuovi'],
    U: ['non in git', 'non in git'],
    D: ['eliminato', 'eliminati'],
    R: ['rinominato', 'rinominati'],
    '!': ['non riuscito', 'non riusciti'],
  },
  reads: n => count(n, 'letto', 'letti'),
  commands: n => count(n, 'comando shell', 'comandi shell'),
  others: n => count(n, 'altra modifica', 'altre modifiche'),
  sinceCommit: 'dall’ultimo commit',

  askingGit: 'Interrogo git…',
  noRepo: 'Qui non c’è un repository git.',
  noChangesCommit: 'Nessuna modifica dall’ultimo commit.',
  nothingTouched: 'Nessun file toccato in questo turno.',

  changes: 'MODIFICHE',
  otherChanges: 'ALTRE MODIFICHE',
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
  read: 'letto',
  readTimes: n => `letto ×${n}`,
  failed: 'non riuscito',
  outside: 'cambiato durante il turno, fuori dalle modifiche e dai comandi di Claude',
  outsideShort: 'cambiato durante il turno',
  notes: {
    R: 'rinominato',
    '?': 'non in git',
    D: 'eliminato',
    U: 'conflitto',
  },

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
  noCompare: 'confronto non disponibile',
  unchangedHead: 'invariato dall’ultimo commit',
  unchangedTurn: 'non modificato in questo turno',
  open: editor => `Apri in ${editor}`,
  compare: editor => `Confronta in ${editor}`,
  openHere: '↗',
  editorFailed: editor => `Non riesco ad avviare ${editor}. Indica il suo launcher nelle opzioni di Canopy.`,
  beforeTurn: n => `prima del turno ${n}`,
  afterTurn: n => `dopo il turno ${n}`,
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
