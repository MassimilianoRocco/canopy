/** One file a turn touched, with what happened to it. */
export type TouchedFile = {
  /** The path lowercased with forward slashes: one row per file. */
  key: string
  /** The path as the tool was given it, to read the file again. */
  path: string
  /** The path as shown: relative to the project when under it. */
  label: string
  reads: number
  edits: number
  isCreated: boolean
  /** Calls on the file still running, and the kind of the last one started. */
  running: number
  pending: 'read' | 'edit' | null
  failures: number
  /**
   * Changed with no file tool, seen through git: while one of Claude's shell
   * commands ran (`shell`), or at another moment of the turn (`outside`: the
   * person, an editor, a hook, a process left running).
   */
  via?: 'shell' | 'outside'
  /** Lines added and removed since the turn began, once counted: absent until then. */
  added?: number
  removed?: number
}

/** One turn of the main conversation: the prompt and the files it touched. */
export type TurnRecord = {
  id: string
  number: number
  prompt: string
  startedAt: number
  /** Null while the turn runs. */
  durationMs: number | null
  endReason: 'answer' | 'aborted' | 'refusal' | 'error' | null
  files: TouchedFile[]
  searches: number
  commands: number
  /** When each of its shell commands ran, from start to return. */
  runs: [number, number][]
}

/** A file's text at one moment, or why there is none. */
export type FileText =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'too-large' }

/**
 * A changed file before the turn's first change and once the turn ended.
 * `base: 'head'` when `before` is the last commit's text, not the turn's: a
 * command changed the file before anything could read it.
 */
export type Snapshot = { before?: FileText; after?: FileText; base?: 'turn' | 'head' }

/** The file the pane shows in place of the tree. */
export type OpenedFile = { key: string; path: string; label: string }

/** What the colours say: what the shown turn touched, or what differs from the last commit. */
export type Mode = 'turn' | 'commit'

/** A file's diff drawn whole, or only its changes with a little context. */
export type DiffView = 'full' | 'hunks'

/** The pane's language. */
export type Lang = 'en' | 'it'

/**
 * One path `git status` lists: modified (`M`), added (`A`), deleted (`D`),
 * renamed or copied (`R`), unknown to git (`?`), or in conflict (`U`).
 * `from` is a rename's or copy's source, where its last commit's text is.
 */
export type GitFile = {
  rel: string
  code: 'M' | 'A' | 'D' | 'R' | '?' | 'U'
  from?: string
  /** Lines added and removed since the last commit; absent for a file git doesn't track, or a binary one. */
  added?: number
  removed?: number
}

/** The last `git status`, its paths relative to `top`, the repository's root. */
export type GitStatus = { at: number; top: string; files: GitFile[] }

/**
 * What git ignores under the repository (`node_modules/`, `.env`), folders
 * ending in `/`, and every file it would show: the search's catalogue.
 */
export type Catalog = { at: number; top: string; ignored: string[]; count: number; isCut: boolean }

declare module 'claude-code' {
  interface PluginState {
    canopy: {
      /** The last turns, oldest first. */
      history: TurnRecord[]
      /** The turn the pane shows; null follows the latest. */
      shown: string | null
      /** The project's folder: the root of the tree. */
      root: string
      /** Folders and sections the person opened (true) or closed (false) by hand. */
      toggled: Record<string, boolean>
      /** The file open in the pane; null shows the tree. */
      opened: OpenedFile | null
      /** Per `<turnId>|<file key>`: the texts a turn's diff is drawn from. */
      snapshot: StateFamily<Snapshot>
      mode: Mode
      diffView: DiffView
      /** Null before the first scan, or outside a repository. */
      git: GitStatus | null
      /** What the search field holds; empty shows the tree. */
      query: string
      lang: Lang
      /** Null before the first read of it, or outside a repository. */
      catalog: Catalog | null
      /** The editor Open and Compare reach, by name; null when none was found. */
      editor: string | null
    }
  }
}
