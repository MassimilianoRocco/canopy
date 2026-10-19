import { keyOf } from './paths'

/** A file the search found: its path from the tree's root, and where the first word is in its name. */
export type Match = { rel: string; at: number }

/**
 * The files whose path holds every word of `text`, best first: the name
 * holding them all, then the shorter path. `at` marks the first word in the
 * name, where it is there.
 */
export const search = (files: readonly string[], text: string): Match[] => {
  const words = text.toLowerCase().replace(/\\/g, '/').split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return []
  const found: (Match & { score: number })[] = []
  for (const rel of files) {
    const low = rel.toLowerCase()
    if (!words.every(word => low.includes(word))) continue
    const name = low.slice(low.lastIndexOf('/') + 1)
    const inName = words.every(word => name.includes(word))
    found.push({ rel, at: name.indexOf(words[0]!), score: (inName ? 0 : 1_000_000) + rel.length })
  }

  return found.sort((a, b) => a.score - b.score || (a.rel < b.rel ? -1 : 1))
}

/** A row of the search's results: a folder (the keys that open it in the tree), or a file. */
export type Found =
  | { kind: 'dir'; name: string; rel: string; keys: string[]; depth: number }
  | { kind: 'file'; name: string; rel: string; depth: number; at: number }

/**
 * The matches as a small tree, folders first, a folder holding only one
 * folder merged into it (`src/app/core`) as an IDE's compact folders are.
 */
export const treeOf = (matches: readonly Match[], baseKey: string): Found[] => {
  type Node = { dirs: Map<string, Node>; files: Match[]; name: string; rel: string }
  const top: Node = { dirs: new Map(), files: [], name: '', rel: '' }
  for (const match of matches) {
    const parts = match.rel.split('/')
    let node = top
    for (const part of parts.slice(0, -1)) {
      const rel = node.rel === '' ? part : `${node.rel}/${part}`
      let next = node.dirs.get(part)
      if (next === undefined) {
        next = { dirs: new Map(), files: [], name: part, rel }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(match)
  }

  const rows: Found[] = []
  const emit = (node: Node, depth: number, opens: string[]) => {
    const byName = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)
    for (const name of [...node.dirs.keys()].sort(byName)) {
      let dir = node.dirs.get(name)!
      let label = dir.name
      const keys = [...opens, keyOf(`${baseKey}/${dir.rel}`)]
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        dir = [...dir.dirs.values()][0]!
        label = `${label}/${dir.name}`
        keys.push(keyOf(`${baseKey}/${dir.rel}`))
      }
      rows.push({ kind: 'dir', name: label, rel: dir.rel, keys, depth })
      emit(dir, depth + 1, keys)
    }
    for (const match of [...node.files].sort((a, b) => byName(a.rel, b.rel))) {
      rows.push({ kind: 'file', name: match.rel.slice(match.rel.lastIndexOf('/') + 1), rel: match.rel, depth, at: match.at })
    }
  }
  emit(top, 0, [])

  return rows
}
