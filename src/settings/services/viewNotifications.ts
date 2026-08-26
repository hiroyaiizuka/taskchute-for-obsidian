import { App } from "obsidian"
import { VIEW_TYPE_TASKCHUTE } from "../../types"

/**
 * Settings changes that open TaskChute views have to react to.
 *
 * Every view exposes a specific hook and falls back to a full re-render when
 * it does not, so a view built before the hook existed still picks the change
 * up. Test hosts frequently omit getLeavesOfType entirely; treat that as "no
 * views open" rather than an error.
 */

interface LeafLike {
  view?: unknown
}

function taskChuteLeaves(app: App): LeafLike[] {
  const workspace = app.workspace as {
    getLeavesOfType?: (type: string) => LeafLike[]
  }
  return typeof workspace.getLeavesOfType === "function"
    ? workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
    : []
}

/** Calls `hook` on every open view, or renderTaskList() where it is absent. */
function notifyOrRerender(
  app: App,
  hook: "onRecipeFeatureSettingsChanged" | "onAiTaskSettingsChanged",
): void {
  taskChuteLeaves(app).forEach((leaf) => {
    const view = leaf.view as
      | (Partial<Record<typeof hook, () => void>> & {
          renderTaskList?: () => void
        })
      | undefined
    const handler = view?.[hook]
    if (typeof handler === "function") {
      handler.call(view)
      return
    }
    view?.renderTaskList?.()
  })
}

export function notifyRecipeFeatureSettingsChanged(app: App): void {
  notifyOrRerender(app, "onRecipeFeatureSettingsChanged")
}

export function notifyAiTaskSettingsChanged(app: App): void {
  notifyOrRerender(app, "onAiTaskSettingsChanged")
}

/** Used where the change only affects layout, so a plain re-render suffices. */
export function rerenderTaskLists(app: App): void {
  taskChuteLeaves(app).forEach((leaf) => {
    const view = leaf.view as { renderTaskList?: () => void } | undefined
    if (typeof view?.renderTaskList === "function") {
      view.renderTaskList()
    }
  })
}

/**
 * Section boundaries moved, so every view has to recompute slot assignments.
 * Awaited as a batch: one view failing must not stop the others.
 */
export async function notifySectionSettingsChanged(app: App): Promise<void> {
  const results = await Promise.allSettled(
    taskChuteLeaves(app).map((leaf) => {
      const view = leaf.view as {
        onSectionSettingsChanged?: () => Promise<void>
      }
      if (typeof view?.onSectionSettingsChanged === "function") {
        return view.onSectionSettingsChanged()
      }
      return Promise.resolve()
    }),
  )
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[SettingsTab] section update failed", result.reason)
    }
  }
}
