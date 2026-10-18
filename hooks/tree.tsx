import type { ClientModule } from 'claude-code'

/**
 * The pane's clickable list as a modern IDE draws it: a changed file's NAME
 * in blue, a new one in green, one git doesn't know in orange, a deleted one
 * struck through, a refused or conflicting one in red, one changed outside
 * Claude's tools dimmed; a status letter at the right edge, a dot on the
 * folders holding a change, indent guides, the search's match marked, a row
 * lit under the pointer and the selected one tinted.
 *
 * A Client, because a desktop draws a Button as a native control and drops
 * the colour of the label inside it. Here every row is plain Text and a click
 * (or Enter, once a click gave the list the focus) comes back as a post
 * naming the row: `{ gen, row }`.
 */
export type Tone = 'changed' | 'created' | 'untracked' | 'deleted' | 'failed' | 'outside' | 'read' | 'heavy' | ''

export type TreeRow = {
  /** The text: arrow and name for a folder or a section, two spaces and name for a file. */
  t: string
  /** How it reads. */
  c: Tone
  /**
   * `d` folder, `f` file, `g` a section heading that folds: a click answers.
   * `h` a heading, `x` a dim note: nothing does.
   */
  k: 'd' | 'f' | 'g' | 'h' | 'x'
  /** Indent guides before it: the tree's depth. */
  d?: number
  /** One plain indent step, no guide: a section's row. */
  i?: 1
  /** Dim words after the name: its folder, `read`, a count. */
  n?: string
  /** At the right edge: a status letter (M A U D R !), or ● for a folder. */
  m?: string
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

// The pointer's row is its `y` only while every row is one line: a row the
// surface wrapped would shift every row below it. So a row is cut to the
// region's width here, the dim words first (from their start, keeping a
// path's end), then the name. Proportional glyphs run narrower than a cell
// on average; the margin covers the wide ones.
const ROOM = 0.9

const fit = (row: TreeRow, columns: number): { t: string; n: string | undefined } => {
  const lead = (row.d ?? 0) * 2 + (row.i === 1 ? 2 : 0) + (row.m === undefined ? 0 : 3)
  const room = Math.floor(columns * ROOM) - 1 - lead
  let { t, n } = row
  if (columns <= 0 || t.length + (n === undefined ? 0 : n.length + 2) <= room) return { t, n }

  if (n !== undefined) {
    const left = room - t.length - 2
    n = left >= 8 ? `…${n.slice(n.length - left + 1)}` : undefined
  }
  if (t.length > room) t = `${t.slice(0, Math.max(1, room - 1))}…`

  return { t, n }
}

const Tree: ClientModule<TreeProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { rows } = props
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
        // The match, where the cut left it
        const [from, to] = row.h === undefined ? [0, 0] : [Math.min(row.h[0], t.length), Math.min(row.h[1], t.length)]

        return (
          <Box
            key={String(at)}
            flexDirection="row"
            justifyContent="space-between"
            {...(tint === undefined ? {} : { backgroundColor: tint })}
          >
            <Text color={COLOR[row.c]} dimColor={isDim(row)} bold={row.k === 'h' || row.k === 'g'} wrap="truncate-end">
              {(row.d ?? 0) > 0 && <Text dimColor bold={false}>{'│ '.repeat(row.d ?? 0)}</Text>}
              {row.i === 1 && '  '}
              {to > from ? (
                <Text strikethrough={row.c === 'deleted'} underline={lit}>
                  {t.slice(0, from)}
                  <Text bold backgroundColor={MATCH}>
                    {t.slice(from, to)}
                  </Text>
                  {t.slice(to)}
                </Text>
              ) : (
                <Text strikethrough={row.c === 'deleted'} underline={lit}>
                  {t}
                </Text>
              )}
              {n !== undefined && <Text dimColor bold={false}>{`  ${n}`}</Text>}
            </Text>
            {row.m !== undefined && (
              <Text color={COLOR[row.c]} dimColor={row.c === 'deleted' || row.c === 'outside'} bold>
                {` ${row.m} `}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

export default Tree
