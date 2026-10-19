// Paths as Canopy compares and shows them

export const slashes = (path: string) => path.replace(/\\/g, '/')

/** A path's identity: forward slashes, lowercased, no trailing slash. */
export const keyOf = (path: string) => slashes(path).toLowerCase().replace(/(.)\/+$/, '$1')

export const joinPath = (dir: string, name: string) =>
  /[\\/]$/.test(dir) ? dir + name : dir + (dir.includes('\\') ? '\\' : '/') + name

/** A path under `base` from its forward-slashed relative one, in `base`'s own slashes. */
export const pathIn = (base: string, rel: string) => joinPath(base, rel.replace(/\//g, base.includes('\\') ? '\\' : '/'))

/** A path relative to `base` when under it, else whole, with forward slashes. */
export const labelOf = (path: string, base: string) => {
  const file = slashes(path)
  const prefix = slashes(base).replace(/\/+$/, '') + '/'

  return base !== '' && file.toLowerCase().startsWith(prefix.toLowerCase()) ? file.slice(prefix.length) : file
}

/** A path as shown: the home folder as `~`. */
export const tidy = (path: string) =>
  path.replace(/^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i, '~').replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

/** A label's file name and the folders before it. */
export const splitLabel = (label: string) => {
  const at = label.lastIndexOf('/')

  return at === -1 ? { name: label, dir: '' } : { name: label.slice(at + 1), dir: label.slice(0, at) }
}

export const isUnder = (key: string, dirKey: string) => key.startsWith(dirKey.endsWith('/') ? dirKey : dirKey + '/')

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** A short stable name for a path, for files Canopy writes on its behalf. */
export const hashOf = (text: string) => {
  let hash = 2166136261
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(36)
}
