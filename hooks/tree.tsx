import type { ClientModule } from 'claude-code'

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
export type Tone = 'changed' | 'created' | 'untracked' | 'deleted' | 'failed' | 'outside' | 'read' | 'heavy' | ''

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

export type TreeProps = { gen: number; rows: TreeRow[]; sel?: number }

// `cursor` the row the keys move, `hover` the one under the pointer
type State = { cursor?: number | null; hover?: number | null }

const COLOR: Partial<Record<Tone, string>> = {
  changed: 'suggestion',
  created: 'success',
  untracked: 'warning',
  failed: 'error',
}
// The chrome around the names: chevrons, guides, a section's title
const QUIET = 'subtle'

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

/** The counts as drawn: a side with nothing to count left out. */
export const countsText = (s: readonly [number, number] | undefined) =>
  s === undefined ? [] : [...(s[0] > 0 ? [`+${s[0]}`] : []), ...(s[1] > 0 ? [`−${s[1]}`] : [])]

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

// The pointer's row is its `y` only while every row is one line: a row the
// surface wrapped would shift every row below it. So a row is cut to the
// region's width here, the dim words first (from their start, keeping a
// path's end), then the name. Proportional glyphs run narrower than a cell
// on average; the margin covers the wide ones.
const ROOM = 0.9

const fit = (row: TreeRow, columns: number): { t: string; n: string | undefined } => {
  const counts = countsText(row.s).join(' ')
  const right = (row.m === undefined ? 0 : row.m.length + 2) + (counts === '' ? 0 : counts.length + 2)
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

const Tree: ClientModule<TreeProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { rows } = props
  const isBadged = hasBadges(surface.columns)
  const state = surface.state ?? {}
  const cursor = state.cursor ?? props.sel ?? null
  const hover = state.hover ?? null
  const set = (next: State) => surface.setState({ ...state, ...next })

  // The next row a key can land on, upward or downward
  const step = (from: number | null, by: 1 | -1) => {
    for (let at = (from ?? (by === 1 ? -1 : rows.length)) + by; at >= 0 && at < rows.length; at += by) {
      if (isActive(rows[at]!)) return at
    }

    return from
  }
  const press = (at: number) => surface.post({ gen: props.gen, row: at })

  surface.onPointer(event => {
    const row = rows[event.y]
    const over = event.type !== 'leave' && row !== undefined && isActive(row) ? event.y : null
    if (event.type === 'down' && event.button === 'left' && over !== null) {
      set({ cursor: over, hover: over })
      press(over)
    } else if (over !== hover) set({ hover: over })
  })

  surface.onKey(event => {
    if (event.key === 'down' || event.key === 'up') {
      const at = step(cursor, event.key === 'down' ? 1 : -1)
      if (at !== cursor) set({ cursor: at })

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
      {rows.map((row, at) => {
        const { t, n } = fit(row, surface.columns)
        const active = isActive(row)
        const lit = active && at === hover
        const tint = active && at === cursor ? SELECTED : lit ? HOVER : undefined
        const counts = row.k === 'f' ? countsText(row.s) : []
        const plus = counts.find(one => one.startsWith('+'))
        const minus = counts.find(one => one.startsWith('−'))
        const isHeading = row.k === 'g'
        // The match, where the cut left it
        const [from, to] = row.h === undefined ? [0, 0] : [Math.min(row.h[0], t.length), Math.min(row.h[1], t.length)]

        return (
          <Box
            key={String(at)}
            flexDirection="row"
            justifyContent="space-between"
            {...(tint === undefined ? {} : { backgroundColor: tint })}
          >
            <Text
              color={isHeading ? QUIET : COLOR[row.c]}
              dimColor={!isHeading && isDim(row)}
              bold={isHeading}
              wrap="truncate-end"
            >
              {/* What stands before the name is monospaced: a guide, a chevron, an indent and a
                  badge take one width on every row, and the names start in one column */}
              {(row.d ?? 0) > 0 && (
                <Text mono color={QUIET} bold={false}>
                  {'│ '.repeat(row.d ?? 0)}
                </Text>
              )}
              {row.i === 1 && <Text mono>{'  '}</Text>}
              {leadOf(row) !== '' && (
                <Text mono color={QUIET} bold={false}>
                  {leadOf(row)}
                </Text>
              )}
              {isBadged && row.k === 'f' && (
                <Text bold={false}>
                  {/* The badge, or its room left blank: monospaced letters between two small
                      spaces, a width the same for every badge and its blank */}
                  <Text
                    size="caption"
                    weight="medium"
                    dimColor={isDim(row)}
                    {...(row.b === undefined || row.b[0] === ''
                      ? {}
                      : { color: row.b[1], backgroundColor: tintOf(row.b[1]) })}
                  >
                    {' '}
                    <Text mono>{row.b === undefined || row.b[0] === '' ? '  ' : row.b[0].padEnd(2)}</Text>{' '}
                  </Text>{' '}
                </Text>
              )}
              <Text strikethrough={row.c === 'deleted'} underline={lit}>
                {t.slice(0, from)}
                {to > from && (
                  <Text bold backgroundColor={MATCH}>
                    {t.slice(from, to)}
                  </Text>
                )}
                {t.slice(to)}
              </Text>
              {n !== undefined && (
                <Text dimColor bold={false}>
                  {`${isHeading ? ' · ' : '  '}${n}`}
                </Text>
              )}
            </Text>
            {(plus !== undefined || minus !== undefined || row.m !== undefined) && (
              <Text>
                {/* Digits of one width, so the counts stacked down the edge line up */}
                {plus !== undefined && (
                  <Text tabular color="success" dimColor={isDim(row)}>
                    {` ${plus}`}
                  </Text>
                )}
                {minus !== undefined && (
                  <Text tabular color="error" dimColor={isDim(row)}>
                    {` ${minus}`}
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
      })}
    </Box>
  )
}

export default Tree
