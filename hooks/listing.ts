import type { EngineInterface, FsEntry } from 'claude-code'

// The folders the tree shows, as last listed. Every tool call, count and
// scroll tick draws the pane again: a drawing reads the disk only for a folder
// listed longer ago than this, or once something came or went (a file Claude
// made, a scan that found one). The time covers what nothing tells Canopy: a
// file made in an editor shows within it
const LISTING_TTL = 2000
const MAX_LISTINGS = 500
const listings = new Map<string, { at: number; entries: readonly FsEntry[] }>()

/** A folder's entries, read again only when its listing is older than LISTING_TTL. */
export async function listingOf($: EngineInterface, path: string): Promise<readonly FsEntry[]> {
  const now = performance.now()
  const kept = listings.get(path)
  if (kept !== undefined && now - kept.at < LISTING_TTL) return kept.entries
  const entries = await $.fs.list(path).catch((): FsEntry[] => [])
  if (listings.size >= MAX_LISTINGS) listings.clear()
  listings.set(path, { at: now, entries })

  return entries
}

/** Forgets every listing: a file came or went. */
export const forgetListings = () => listings.clear()
