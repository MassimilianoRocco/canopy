import { expect, test } from 'claude-code/testing'

import { changesOf, clipHunk, diffLines, hunksOf, hunksSource, linesOf } from '../hooks/diff'

const sides = (before: string[], after: string[]) => {
  const lines = diffLines(before, after)

  return {
    lines,
    before: lines.filter(line => line.op !== '+').map(line => line.text),
    after: lines.filter(line => line.op !== '-').map(line => line.text),
    edits: lines.filter(line => line.op !== ' ').length,
  }
}

test('a diff rebuilds both sides with the fewest edits', async () => {
  const before = ['a', 'b', 'c', 'd', 'e']
  const after = ['a', 'x', 'c', 'e', 'f']
  const diff = sides(before, after)

  expect(diff.before).toEqual(before)
  expect(diff.after).toEqual(after)
  expect(diff.edits).toBe(4)
})

test('scattered changes in a longer file stay small', async () => {
  const before = Array.from({ length: 400 }, (_, i) => `line ${i}`)
  const after = [...before]
  after.splice(300, 1, 'changed 300')
  after.splice(120, 0, 'inserted')
  after.splice(10, 2)
  const diff = sides(before, after)

  expect(diff.before).toEqual(before)
  expect(diff.after).toEqual(after)
  expect(diff.edits).toBe(5)
})

test('a new file is all added, and changes report their lines', async () => {
  const created = diffLines([], ['one', 'two'])
  expect(created.map(line => line.op)).toEqual(['+', '+'])

  const changes = changesOf(diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']))
  expect(changes).toEqual({ added: 2, removed: 1, ranges: [[2, 2], [5, 5]] })
})

test('lines drop CRs, the final newline and control characters', async () => {
  expect(linesOf('a\r\nb\u0007\r\n')).toEqual(['a', 'b�'])
})

test('only the changes: hunks with three lines of context, numbered as in each file', () => {
  const before = Array.from({ length: 30 }, (_, at) => `l${at + 1}`)
  const after = [...before]
  after[0] = 'L1'
  after.splice(25, 1)

  expect(hunksSource(diffLines(before, after))).toBe(
    [
      '@@ -1,4 +1,4 @@', '-l1', '+L1', ' l2', ' l3', ' l4',
      '@@ -23,7 +23,6 @@', ' l23', ' l24', ' l25', '-l26', ' l27', ' l28', ' l29',
    ].join('\n'),
  )
})

test('a hunk with no old lines names the line before it, and no change makes none', () => {
  expect(hunksSource(diffLines([], ['a', 'b']))).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
  expect(hunksSource(diffLines(['x'], ['x']))).toBe('')
})

test('a hunk cut to the room keeps a header that counts what is left', () => {
  const before = Array.from({ length: 10 }, (_, at) => `l${at + 1}`)
  const [hunk] = hunksOf(diffLines(before, before.map(line => line.toUpperCase())))
  const cut = clipHunk(hunk!, 40)!
  const [header, ...rows] = cut.source.split('\n')
  const [, oldCount, newCount] = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(header!) ?? []

  expect(cut.source.length).toBeLessThanOrEqual(40)
  expect(hunk!.source.split('\n').slice(1, rows.length + 1)).toEqual(rows)
  expect(Number(oldCount)).toBe(rows.filter(row => !row.startsWith('+')).length)
  expect(Number(newCount)).toBe(rows.filter(row => !row.startsWith('-')).length)
  expect(cut.at).toBe(hunk!.at)
})

test('a side a cut leaves empty names the line before, and no room for a change cuts nothing', () => {
  // Lines added before the first: cut to the additions, the old side is empty
  const [hunk] = hunksOf(diffLines(['x'], ['a', 'b', 'c', 'd', 'x']))
  expect(hunk!.source.split('\n')[0]).toBe('@@ -1,1 +1,5 @@')
  expect(clipHunk(hunk!, 26)?.source).toBe('@@ -0,0 +1,3 @@\n+a\n+b\n+c')
  expect(clipHunk(hunk!, 10)).toBeUndefined()
})
