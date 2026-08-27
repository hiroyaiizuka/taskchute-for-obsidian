/**
 * Push an AI availability change into every open TaskChute view.
 *
 * Tearing the runtime down is not enough on its own: an already rendered view
 * keeps its AI run pane, board switch and row controls until something asks it
 * to re-render. The settings toggle had this wired up, but a background license
 * refresh that revoked the entitlement did not, so the AI UI stayed on screen
 * for a feature that could no longer run. Both paths now call this.
 */
import type { App } from 'obsidian'
import { VIEW_TYPE_TASKCHUTE } from '../../types'

export function notifyAiTaskSettingsChanged(app: App): void {
  const workspace = app.workspace as {
    getLeavesOfType?: (type: string) => Array<{ view?: unknown }>
  }
  const leaves = typeof workspace.getLeavesOfType === 'function'
    ? workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
    : []
  leaves.forEach((leaf) => {
    const view = leaf.view as {
      onAiTaskSettingsChanged?: () => void
      renderTaskList?: () => void
    } | undefined
    if (typeof view?.onAiTaskSettingsChanged === 'function') {
      view.onAiTaskSettingsChanged()
      return
    }
    view?.renderTaskList?.()
  })
}
