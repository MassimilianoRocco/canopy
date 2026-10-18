/**
 * A file's badge, as an IDE's file icon: two letters on a tint of their
 * colour, by the file's extension or its whole name. The letters are
 * empty for a file with no extension Canopy knows of a name it doesn't
 * either: its row keeps the badge's room, blank.
 */
export type Badge = [letters: string, color: string]

// Mid tones, so either theme reads them: the badge's text, and its tint behind it
const BLUE = '#4a8fe0'
const YELLOW = '#c9a227'
const ORANGE = '#e07b39'
const PURPLE = '#9d6ae0'
const RED = '#e05252'
const GREEN = '#3fa66b'
const TEAL = '#2aa3a3'
const GREY = '#8a8a8a'

// A Map, not an object: a name such as `x.constructor` finds nothing of Object's
const BY_EXTENSION = new Map<string, Badge>([
  ...['ts', 'mts', 'cts', 'tsx'].map((ext): [string, Badge] => [ext, ['TS', BLUE]]),
  ...['js', 'mjs', 'cjs', 'jsx'].map((ext): [string, Badge] => [ext, ['JS', YELLOW]]),
  ...['json', 'jsonc', 'json5'].map((ext): [string, Badge] => [ext, ['{}', ORANGE]]),
  ...['md', 'mdx', 'markdown'].map((ext): [string, Badge] => [ext, ['MD', GREY]]),
  ['txt', ['TX', GREY]],
  ['log', ['LG', GREY]],
  ['css', ['CS', PURPLE]],
  ['scss', ['SC', PURPLE]],
  ['sass', ['SA', PURPLE]],
  ['less', ['LE', PURPLE]],
  ['html', ['HT', ORANGE]],
  ['htm', ['HT', ORANGE]],
  ['xml', ['XM', ORANGE]],
  ['svg', ['SV', ORANGE]],
  ['vue', ['VU', GREEN]],
  ['svelte', ['SE', ORANGE]],
  ['py', ['PY', BLUE]],
  ['ipynb', ['NB', ORANGE]],
  ['java', ['JV', RED]],
  ['kt', ['KT', PURPLE]],
  ['kts', ['KT', PURPLE]],
  ['gradle', ['GR', TEAL]],
  ['go', ['GO', TEAL]],
  ['rs', ['RS', ORANGE]],
  ['rb', ['RB', RED]],
  ['php', ['PH', PURPLE]],
  ['c', ['C', BLUE]],
  ['h', ['H', PURPLE]],
  ...['cpp', 'cc', 'cxx'].map((ext): [string, Badge] => [ext, ['C+', BLUE]]),
  ...['hpp', 'hh', 'hxx'].map((ext): [string, Badge] => [ext, ['H+', PURPLE]]),
  ['cs', ['C#', PURPLE]],
  ['swift', ['SW', ORANGE]],
  ['dart', ['DA', TEAL]],
  ...['sh', 'bash', 'zsh', 'fish'].map((ext): [string, Badge] => [ext, ['SH', GREEN]]),
  ...['ps1', 'psm1', 'psd1'].map((ext): [string, Badge] => [ext, ['PS', BLUE]]),
  ...['bat', 'cmd'].map((ext): [string, Badge] => [ext, ['BT', GREY]]),
  ['sql', ['SQ', ORANGE]],
  ['yml', ['YM', RED]],
  ['yaml', ['YM', RED]],
  ['toml', ['TM', GREY]],
  ['ini', ['IN', GREY]],
  ['lock', ['LK', GREY]],
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'].map((ext): [string, Badge] => [ext, ['IM', TEAL]]),
])

// Files known by their whole name, lowercased
const BY_NAME = new Map<string, Badge>([
  ['dockerfile', ['DK', BLUE]],
  ['makefile', ['MK', GREY]],
  ['license', ['LI', GREY]],
  ['.gitignore', ['GI', ORANGE]],
  ['.gitattributes', ['GI', ORANGE]],
  ['.editorconfig', ['EC', GREY]],
])

/**
 * A file's badge by its name: its whole name, then its extension; any other
 * extension's first two letters, grey; none for a file with no extension.
 */
export const fileBadgeOf = (name: string): Badge => {
  const low = name.toLowerCase()
  const named = BY_NAME.get(low) ?? (low === '.env' || low.startsWith('.env.') ? (['EN', YELLOW] as Badge) : undefined)
  if (named !== undefined) return named
  const dot = low.lastIndexOf('.')
  const extension = dot > 0 ? low.slice(dot + 1) : ''
  const known = BY_EXTENSION.get(extension)
  if (known !== undefined) return known

  return extension === '' ? ['', GREY] : [extension.slice(0, 2).toUpperCase(), GREY]
}

// Narrower than this, the badges give their room to the names (tree.tsx keeps its own copy)
export const BADGE_MIN_COLUMNS = 40
