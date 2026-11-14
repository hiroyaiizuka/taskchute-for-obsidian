import type { WorkspaceLeaf } from 'obsidian'

/** The two workspace calls showLeaf needs; test hosts may lack either. */
export interface ShowLeafWorkspace {
  revealLeaf?: (leaf: WorkspaceLeaf) => Promise<void> | void
  setActiveLeaf?: (leaf: WorkspaceLeaf, params?: { focus?: boolean }) => void
}

/**
 * Switches the user to a leaf, the way clicking its tab does.
 *
 * Opening a tab decides two separate things: which tab is in front of its
 * group (`revealLeaf`), and which leaf is the current one — the one commands,
 * ribbon actions and the next opened note act on (`setActiveLeaf`).
 * `revealLeaf` does only the first. Calling it alone leaves the current leaf
 * on a tab now hidden behind this one, so the next note the user opens goes
 * into that hidden tab and nothing seems to happen (LEV-410).
 */
export async function showLeaf(
  workspace: ShowLeafWorkspace,
  leaf: WorkspaceLeaf,
  options: { focus?: boolean } = {},
): Promise<void> {
  if (typeof workspace.revealLeaf === 'function') {
    await workspace.revealLeaf(leaf)
  }
  if (typeof workspace.setActiveLeaf === 'function') {
    workspace.setActiveLeaf(leaf, { focus: options.focus ?? true })
  }
}
