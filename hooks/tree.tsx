import type { ClientModule, RenderElement } from 'claude-code'

/**
 * The pane's clickable list as a modern IDE draws it: a changed file's NAME
 * in blue, a new one in green, one git doesn't know in orange, a deleted one
 * struck through, a refused or conflicting one in red, one changed outside
 * Claude's tools dimmed; its lines added and removed at the right edge, a dot
 * on the folders holding a change, quiet chevrons and indent guides, the
 * search's match marked, a row lit under the pointer and the selected one
 * tinted.
 *
 * A Client, because a desktop draws a Button as a native control and drops
 * the colour of the label inside it. Here every row is plain Text and a click
 * (or Enter, once a click gave the list the focus) comes back as a post
 * naming the row: `{ gen, row }`.
 */
export type Tone = 'changed' | 'created' | 'untracked' | 'deleted' | 'failed' | 'outside' | 'heavy' | ''

export type TreeRow = {
  /** The name: a file's, a folder's, a section's title, a note's words. */
  t: string
  /** How it reads. */
  c: Tone
  /**
   * `d` folder, `f` file, `g` a section heading that folds: a click answers.
   * `x` a dim note: nothing does.
   */
  k: 'd' | 'f' | 'g' | 'x'
  /** Indent guides before it: the tree's depth. */
  d?: number
  /** One plain indent step, no guide: a section's row. */
  i?: 1
  /** Dim words after the name: its folder, `new`, `read`, a section's count. */
  n?: string
  /** At the right edge: ● for a folder holding a change, ! for a refused edit. */
  m?: string
  /** At the right edge: the lines added and removed. */
  s?: [number, number]
  /** A file's badge, as an IDE's icon: its letters and their colour; absent, its room left blank. */
  b?: [string, string]
  /** An open folder or section. */
  o?: 1
  /** Where in `t` the search matched: start and end. */
  h?: [number, number]
}

/**
 * `sel` the row tinted as selected until a click or a key moves it; `note`
 * the words that close a list cut short, `cut` when the pane cut it already.
 * `from` the first row to draw, a little above the pane's window over the
 * list: the rows before it, and those past the drawing's room, stand as blank
 * room of their height, and the pane asks again as the window moves. Absent,
 * the list draws from its top and says where the room ran out.
 */
export type TreeProps = { gen: number; rows: TreeRow[]; sel?: number; note?: string; cut?: 1; from?: number }

// `cursor` the row the keys move, by what it is (see idsOf), so a row drawn
// above it moves it along; `hover` the one under the pointer, by its place;
// `byKeys` while the keys put the cursor where it is, not a click
type State = { cursor?: string | null; hover?: number | null; byKeys?: boolean }

const COLOR: Partial<Record<Tone, string>> = {
  changed: 'suggestion',
  created: 'success',
  untracked: 'warning',
  failed: 'error',
}
// The chrome around the names: chevrons, a section's title
const QUIET = 'subtle'
// The indent guides, fainter still: the depth reads without a grid drawn over the tree
const GUIDE = '#8080804d'
// A folder never opened by itself (`node_modules`) or one git ignores, and what is in it:
// a grey of its own, as a desktop's dim alone reads close to the names around it
const HEAVY = '#8a8a8a'

const isDim = (row: TreeRow) =>
  row.c === 'heavy' || row.c === 'deleted' || row.c === 'outside' || row.k === 'x'

// Translucent, so either theme shows them: a grey wash under the pointer, a
// blue one on the selected row, an amber one on the search's match. The
// pointer's row is the module's own state, from its moves: a desktop applies
// no Box `hover` inside a Client
const HOVER = '#8080801f'
const SELECTED = '#4c8dff33'
const MATCH = '#e8a31747'

const isActive = (row: TreeRow) => row.k === 'd' || row.k === 'f' || row.k === 'g'

/** A file's lines added and removed, each as its column draws it: empty for nothing to count. */
const sidesOf = (row: TreeRow): [string, string] =>
  row.k !== 'f' || row.s === undefined ? ['', ''] : [row.s[0] > 0 ? `+${row.s[0]}` : '', row.s[1] > 0 ? `−${row.s[1]}` : '']

/**
 * The widths of the two count columns, the widest of each: every file's lines
 * added stand under one another, its lines removed too, as an IDE's do.
 */
const widthsOf = (rows: readonly TreeRow[]) => {
  let plus = 0
  let minus = 0
  for (const row of rows) {
    const [added, removed] = sidesOf(row)
    plus = Math.max(plus, added.length)
    minus = Math.max(minus, removed.length)
  }

  return { plus, minus }
}

type Widths = ReturnType<typeof widthsOf>

// The room the counts take at a row's end: each column and the space before it
const countsRoom = (widths: Widths) => (widths.plus > 0 ? widths.plus + 1 : 0) + (widths.minus > 0 ? widths.minus + 1 : 0)

// What stands before the name: a chevron and a space for what folds; two spaces
// for a file in the tree, so its name stands under a folder's; nothing in a section
const leadOf = (row: TreeRow) =>
  row.k === 'd' || row.k === 'g' ? `${row.o === 1 ? '▾' : '▸'} ` : row.k === 'f' && row.i !== 1 ? '  ' : ''

// A file's badge: its letters a size under the name's, on a light tint of
// their colour, so it stands as tall as the text rather than the row. At most
// this much room with the space after it; narrower than BADGE_MIN_COLUMNS
// (filetype.ts keeps the same) the badges give their room to the names
const BADGE_ROOM = 5
const BADGE_MIN_COLUMNS = 40
const tintOf = (color: string) => `${color}24`
const hasBadges = (columns: number) => columns <= 0 || columns >= BADGE_MIN_COLUMNS

// The pointer's row is its `y` only while every row is one line, one cell
// tall (see rowOf): a row the surface wrapped would shift every row below it.
// So a row is cut to the region's width here, the dim words first (from their
// start, keeping a path's end), then the name. Proportional glyphs run
// narrower than a cell on average; the margin covers the wide ones.
const ROOM = 0.9

const fit = (row: TreeRow, columns: number, widths: Widths): { t: string; n: string | undefined } => {
  const hasCounts = sidesOf(row).some(side => side !== '')
  const right = (row.m === undefined ? 0 : row.m.length + 2) + (hasCounts ? countsRoom(widths) + 1 : 0)
  const badge = row.k === 'f' && hasBadges(columns) ? BADGE_ROOM : 0
  const lead = (row.d ?? 0) * 2 + (row.i === 1 ? 2 : 0) + leadOf(row).length + badge + right
  const room = Math.floor(columns * ROOM) - 1 - lead
  let { t, n } = row
  const gap = row.k === 'g' ? 3 : 2
  if (columns <= 0 || t.length + (n === undefined ? 0 : n.length + gap) <= room) return { t, n }

  if (n !== undefined) {
    const left = room - t.length - gap
    n = left >= 8 ? `…${n.slice(n.length - left + 1)}` : undefined
  }
  if (t.length > room) t = `${t.slice(0, Math.max(1, room - 1))}…`

  return { t, n }
}

/**
 * Each row's identity, the same from one drawing to the next while the row
 * stands: a heading by its title, a section's file by its section and its
 * words, a tree's row by the folders above it. Empty for a note.
 */
export const idsOf = (rows: readonly TreeRow[]) => {
  const ids: string[] = []
  let section = ''
  const folders: string[] = []
  for (const row of rows) {
    if (row.k === 'g') {
      section = row.t
      folders.length = 0
      ids.push(`g|${row.t}`)
    } else if (row.k === 'x') {
      ids.push('')
    } else if (row.i === 1) {
      ids.push(`s|${section}|${row.t}|${row.n ?? ''}`)
    } else {
      const depth = row.d ?? 0
      folders.length = depth
      ids.push(`t|${section}|${[...folders, row.t].join('/')}`)
      if (row.k === 'd') folders[depth] = row.t
    }
  }

  return ids
}

// The engine refuses a Client's drawing past 100,000 characters serialized, and
// the whole list goes: the rows are drawn while their own serialized size
// leaves this much, the rest left out under a note, as many as fit
const DRAWN_ROOM = 85_000

// A prop set only where it says something: every row repeats its props, and
// what a row costs is what the drawing has room for
const only = <K extends string, V>(isOn: boolean, key: K, value: V) =>
  (isOn ? { [key]: value } : {}) as Partial<Record<K, V>>

const Tree: ClientModule<TreeProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { rows } = props
  const isBadged = hasBadges(surface.columns)
  const state = surface.state ?? {}
  const ids = idsOf(rows)
  const widths = widthsOf(rows)
  const set = (next: State) => surface.setState({ ...state, ...next })

  const rowOf = (row: TreeRow, at: number, cursor: number | null, hover: number | null): RenderElement => {
    const { t, n } = fit(row, surface.columns, widths)
    const active = isActive(row)
    const lit = active && at === hover
    // The cursor tinted where the keys put it; after a click, on a file alone, as an
    // editor marks the file it shows: a heading or a folder clicked only folds
    const isSelected = active && at === cursor && (row.k === 'f' || state.byKeys === true)
    const tint = isSelected ? SELECTED : lit ? HOVER : undefined
    const [plus, minus] = sidesOf(row)
    const hasCounts = plus !== '' || minus !== ''
    const isHeading = row.k === 'g'
    const isHeavy = row.c === 'heavy'
    const dim = isDim(row)
    // A heading's title is bold: what stands around it is not
    const plain = only(isHeading, 'bold', false)
    // The match, where the cut left it
    const [from, to] = row.h === undefined ? [0, 0] : [Math.min(row.h[0], t.length), Math.min(row.h[1], t.length)]
    // What stands before the name is monospaced, the guides, then a section's indent and a
    // chevron: they take one width on every row, and the names start in one column
    const guides = '│ '.repeat(row.d ?? 0)
    const lead = (row.i === 1 ? '  ' : '') + leadOf(row)
    const color = isHeading ? QUIET : isHeavy ? HEAVY : COLOR[row.c]
    const hasBadge = row.b !== undefined && row.b[0] !== ''
    const hasRight = hasCounts || row.m !== undefined
    // The name as drawn: in a Text of its own only where it is struck, lit or matched
    const isStyled = row.c === 'deleted' || lit || to > from
    const name =
      to > from
        ? [
            t.slice(0, from),
            <Text key="match" bold backgroundColor={MATCH}>
              {t.slice(from, to)}
            </Text>,
            t.slice(to),
          ].filter(part => part !== '')
        : t

    // One cell tall, whatever it holds: a badge's chip or a monospaced run draws a line a
    // little taller than the cell the pointer's `y` counts in, and down a long list the
    // rows would drift from the pointer, a click landing on the row below
    return (
      <Box
        key={String(at)}
        height={1}
        overflow="hidden"
        {...(hasRight ? { flexDirection: 'row' as const, justifyContent: 'space-between' as const } : {})}
        {...(tint === undefined ? {} : { backgroundColor: tint })}
      >
        <Text
          {...(color === undefined ? {} : { color })}
          {...only(!isHeading && dim && !isHeavy, 'dimColor', true)}
          {...only(isHeading, 'bold', true)}
          wrap="truncate-end"
        >
          {guides !== '' && (
            <Text mono color={GUIDE} {...plain}>
              {guides}
            </Text>
          )}
          {lead !== '' && (
            <Text mono color={QUIET} {...plain}>
              {lead}
            </Text>
          )}
          {/* The badge, or its room left blank: monospaced, a size under the name's, its letters
              between two spaces, a width the same for every badge and its blank */}
          {isBadged && row.k === 'f' && (
            <Text
              mono
              size="caption"
              weight="medium"
              {...only(dim, 'dimColor', true)}
              {...(hasBadge ? { color: row.b![1], backgroundColor: tintOf(row.b![1]) } : {})}
            >
              {` ${hasBadge ? row.b![0].padEnd(2) : '  '} `}
            </Text>
          )}
          {isBadged && row.k === 'f' && ' '}
          {isStyled ? (
            <Text {...only(row.c === 'deleted', 'strikethrough', true)} {...only(lit, 'underline', true)}>
              {name}
            </Text>
          ) : (
            name
          )}
          {n !== undefined && (
            <Text dimColor {...plain}>
              {`${isHeading ? ' · ' : '  '}${n}`}
            </Text>
          )}
        </Text>
        {hasRight && (
          <Text>
            {/* Two columns of one width each, monospaced: every file's lines added stand
                under one another, its lines removed too, a side with none left blank */}
            {hasCounts && widths.plus > 0 && (
              <Text mono color="success" {...only(dim, 'dimColor', true)}>
                {` ${plus.padStart(widths.plus)}`}
              </Text>
            )}
            {hasCounts && widths.minus > 0 && (
              <Text mono color="error" {...only(dim, 'dimColor', true)}>
                {` ${minus.padStart(widths.minus)}`}
              </Text>
            )}
            {row.m !== undefined && (
              <Text bold color={row.m === '●' ? COLOR.changed : COLOR.failed}>
                {` ${row.m}`}
              </Text>
            )}{' '}
          </Text>
        )}
      </Box>
    )
  }

  // The selected row, followed by what it is: rows drawn above it, or gone below, leave it where it is
  const wanted = state.cursor !== undefined ? state.cursor : props.sel === undefined ? null : (ids[props.sel] ?? null)
  const found = wanted === null || wanted === '' ? -1 : ids.indexOf(wanted)
  const hover = state.hover ?? null

  // The rows the room holds, measured as drawn, from the first the window asks for
  const isWindowed = props.from !== undefined
  const first = Math.max(0, Math.min(props.from ?? 0, rows.length))
  const draw = (cursor: number | null) => {
    const drawn: RenderElement[] = []
    let size = 0
    for (let at = first; at < rows.length; at++) {
      const element = rowOf(rows[at]!, at, cursor, hover)
      size += JSON.stringify(element).length
      if (size > DRAWN_ROOM) break
      drawn.push(element)
    }

    return drawn
  }
  const drawn = draw(found === -1 ? null : found)
  // The rows drawn are `first` to `end`, by their place in the list
  const end = first + drawn.length
  const isDrawn = (at: number) => at >= first && at < end
  const cursor = found !== -1 && isDrawn(found) ? found : null
  // Windowed, the rows past the room are reached by scrolling to them: only the pane's own cut is said
  const isCut = props.cut === 1 || (!isWindowed && end < rows.length)

  // The next row a key can land on, upward or downward, among those drawn
  const step = (from: number | null, by: 1 | -1) => {
    for (let at = (from ?? (by === 1 ? first - 1 : end)) + by; isDrawn(at); at += by) {
      if (isActive(rows[at]!)) return at
    }

    return from
  }
  const press = (at: number) => surface.post({ gen: props.gen, row: at })

  surface.onPointer(event => {
    const row = isDrawn(event.y) ? rows[event.y] : undefined
    const over = event.type !== 'leave' && row !== undefined && isActive(row) ? event.y : null
    if (event.type === 'down' && event.button === 'left' && over !== null) {
      set({ cursor: ids[over] ?? null, hover: over, byKeys: false })
      press(over)
    } else if (over !== hover) set({ hover: over })
  })

  surface.onKey(event => {
    if (event.key === 'down' || event.key === 'up') {
      const at = step(cursor, event.key === 'down' ? 1 : -1)
      if (at !== cursor && at !== null) set({ cursor: ids[at] ?? null, byKeys: true })

      return
    }
    const row = cursor === null ? undefined : rows[cursor]
    if (cursor === null || row === undefined || !isActive(row)) return
    const isFolder = row.k !== 'f'
    if (event.key === 'return' || event.key === ' ') press(cursor)
    else if (event.key === 'right' && isFolder && row.o !== 1) press(cursor)
    else if (event.key === 'left' && isFolder && row.o === 1) press(cursor)
  })

  return (
    <Box flexDirection="column">
      {first > 0 && <Box key="above" height={first} />}
      {drawn}
      {isWindowed && end < rows.length && <Box key="below" height={rows.length - end} />}
      {isCut && (
        <Box key="cut">
          <Text dimColor wrap="truncate-end">
            {props.note ?? '…'}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default Tree
