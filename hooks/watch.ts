// ---- Whether anyone sees the pane ----
// Canopy's work with git (a status after the commands and as a turn begins,
// the files git ignores listed) serves the pane alone. Where nothing draws it,
// that work waits: a run with no surface (`claude -p`, the SDK, a desktop
// session no window shows), a terminal too narrow for it, a pane closed. The
// bookkeeping of Claude's own file tools goes on, git asked for nothing.
// Unknown counts as seen; the next drawing wakes it, and one scan then catches
// up with what the commands wrote meanwhile

let isSeen = true
let isBehind = false

export const isPaneSeen = () => isSeen

/** What `$.ui.open` answered: a pane not placed waits undrawn. */
export const noteOpened = (opened: { isPlaced: boolean }) => {
  if (!opened.isPlaced) isSeen = false
}

/** The pane closed, or no surface places it any more. */
export const noteUnseen = () => {
  isSeen = false
}

/** Work put off while nobody saw the pane: a scan is owed. */
export const owe = () => {
  isBehind = true
}

/** The pane is drawn: seen again. True once when a scan is owed. */
export const noteDrawn = () => {
  isSeen = true
  const isOwed = isBehind
  isBehind = false

  return isOwed
}
