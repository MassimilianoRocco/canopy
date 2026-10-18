/** One line of a line diff: kept, removed or added. */
export type DiffLine = { op: ' ' | '-' | '+'; text: string }

// Past this many removed plus added lines the middle is drawn as replaced whole
const MAX_EDITS = 1500

const kept = (text: string): DiffLine => ({ op: ' ', text })
const removed = (text: string): DiffLine => ({ op: '-', text })
const added = (text: string): DiffLine => ({ op: '+', text })

/** A text's lines, with the CRs and control characters a Code element refuses gone. */
export const linesOf = (text: string): string[] => {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�')
    .split('\n')

  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

// Myers' walk back from the end: `trace[d]` holds the furthest x per diagonal
// k as round d began, for k from -d-1 to d+1
const walkBack = (
  trace: readonly Int32Array[],
  before: readonly string[],
  after: readonly string[],
): DiffLine[] => {
  const lines: DiffLine[] = []
  let x = before.length
  let y = after.length

  for (let d = trace.length - 1; d >= 0; d--) {
    const round = trace[d]!
    const at = (k: number) => round[k + d + 1]!
    const k = x - y
    const isDown = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = isDown ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      lines.push(kept(before[x - 1]!))
      x -= 1
      y -= 1
    }
    if (d > 0) lines.push(isDown ? added(after[y - 1]!) : removed(before[x - 1]!))
    x = prevX
    y = prevY
  }

  return lines.reverse()
}

// The shortest edit script, or undefined past MAX_EDITS
const shortest = (before: readonly string[], after: readonly string[]): DiffLine[] | undefined => {
  const n = before.length
  const m = after.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []

  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const isDown = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
      let x = isDown ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return walkBack(trace, before, after)
    }
  }

  return undefined
}

/** The lines of `before` and `after` as kept, removed and added, in order. */
export const diffLines = (before: readonly string[], after: readonly string[]): DiffLine[] => {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1
  }
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }

  const gone = before.slice(start, endBefore)
  const come = after.slice(start, endAfter)
  const middle = shortest(gone, come) ?? [...gone.map(removed), ...come.map(added)]

  return [...before.slice(0, start).map(kept), ...middle, ...before.slice(endBefore).map(kept)]
}

/** The whole file as one unified-diff hunk, for a Code element's `format: 'diff'`. */
export const unifiedSource = (lines: readonly DiffLine[]) => {
  const oldCount = lines.filter(line => line.op !== '+').length
  const newCount = lines.filter(line => line.op !== '-').length
  const header = `@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@`

  return [header, ...lines.map(line => line.op + line.text)].join('\n')
}

/** Lines added and removed, and where the changes sit in the new file. */
export const changesOf = (lines: readonly DiffLine[]) => {
  const at: number[] = []
  let line = 0
  let addedCount = 0
  let removedCount = 0

  for (const one of lines) {
    if (one.op !== '-') line += 1
    if (one.op === '+') {
      addedCount += 1
      at.push(line)
    }
    // A removed line sits where the next new line now stands
    if (one.op === '-') {
      removedCount += 1
      at.push(line + 1)
    }
  }

  const ranges: [number, number][] = []
  for (const number of at) {
    const last = ranges.at(-1)
    if (last !== undefined && number <= last[1] + 1) last[1] = Math.max(last[1], number)
    else ranges.push([number, number])
  }

  return { added: addedCount, removed: removedCount, ranges }
}

/** One hunk: its unified-diff text, the new file's lines it spans, and its first change there. */
export type Hunk = { source: string; from: number; to: number; at: number }

/**
 * Only the changes, each with `context` kept lines around it, one hunk at a
 * time: numbered as in the two files, and where each sits in the new file.
 */
export const hunksOf = (lines: readonly DiffLine[], context = 3): Hunk[] => {
  const source = hunksSource(lines, context)
  if (source === '') return []

  return source.split(/\n(?=@@ )/).map(text => {
    const [, start = '1', count = '1'] = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text) ?? []
    const from = Math.max(1, Number(start))
    const to = Math.max(from, Number(start) + Number(count) - 1)
    // The first added or removed line, counted in the new file
    let line = Number(start)
    let at = from
    for (const row of text.split('\n').slice(1)) {
      if (row.startsWith('+') || row.startsWith('-')) {
        at = Math.max(1, line)
        break
      }
      line += 1
    }

    return { source: text, from, to, at }
  })
}

/**
 * A hunk cut to the lines that fit in `max` characters, its header counting
 * what is left, so it still parses as a diff; undefined when no changed line fits.
 */
export const clipHunk = (hunk: Hunk, max: number): Hunk | undefined => {
  const [header = '', ...rows] = hunk.source.split('\n')
  const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header)
  if (match === null) return undefined
  const kept: string[] = []
  let size = header.length
  for (const row of rows) {
    if (size + 1 + row.length > max) break
    kept.push(row)
    size += 1 + row.length
  }
  if (!kept.some(row => row.startsWith('+') || row.startsWith('-'))) return undefined

  const oldCount = kept.filter(row => !row.startsWith('+')).length
  const newCount = kept.filter(row => !row.startsWith('-')).length
  // A side left with no lines names the line before the hunk, as diff does
  const startOf = (start: string, count: string, left: number) => Number(start) - (Number(count) > 0 && left === 0 ? 1 : 0)
  const newStart = startOf(match[3]!, match[4]!, newCount)
  const from = Math.max(1, newStart)

  return {
    source: [`@@ -${startOf(match[1]!, match[2]!, oldCount)},${oldCount} +${newStart},${newCount} @@`, ...kept].join('\n'),
    from,
    to: Math.max(from, newStart + newCount - 1),
    at: hunk.at,
  }
}

/**
 * Only the changes, each with `context` kept lines around it: unified-diff
 * hunks numbered as in the two files. Empty when nothing changed.
 */
export const hunksSource = (lines: readonly DiffLine[], context = 3) => {
  // Each line's number in the old and in the new file
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const line of lines) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (line.op !== '+') oldLine += 1
    if (line.op !== '-') newLine += 1
  }

  // Changed lines widened by the context, overlapping spans merged
  const spans: [number, number][] = []
  lines.forEach((line, at) => {
    if (line.op === ' ') return
    const from = Math.max(0, at - context)
    const to = Math.min(lines.length - 1, at + context)
    const last = spans.at(-1)
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else spans.push([from, to])
  })

  return spans
    .map(([from, to]) => {
      const part = lines.slice(from, to + 1)
      const oldCount = part.filter(line => line.op !== '+').length
      const newCount = part.filter(line => line.op !== '-').length
      // A side with no lines names the line before the hunk, as diff does
      const header = `@@ -${oldAt[from]! - (oldCount === 0 ? 1 : 0)},${oldCount} +${newAt[from]! - (newCount === 0 ? 1 : 0)},${newCount} @@`

      return [header, ...part.map(line => line.op + line.text)].join('\n')
    })
    .join('\n')
}
