import { Notice } from 'obsidian'
;

import { t } from "../../i18n";
import { VIEW_TYPE_TASKCHUTE } from "../../types";

import type { TaskChutePluginLike } from "../../types";
import type {
  AmbientAiTaskStartedRun,
  TaskChuteView,
} from "../../features/core/views/TaskChuteView";

export interface TaskChuteBackgroundViewSession {
  view: TaskChuteView
  close(): void
}

export class TaskChuteViewController {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  isViewActive(): boolean {
    const activeView = this.plugin.app.workspace.getMostRecentLeaf()?.view
    if (!activeView) return false

    const candidate = activeView as { getViewType?: () => string }
    if (typeof candidate.getViewType !== "function") return false

    return candidate.getViewType() === VIEW_TYPE_TASKCHUTE
  }

  getView(): TaskChuteView | null {
    const leaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)[0]
    if (!leaf || !leaf.view) return null

    const candidate = leaf.view
    if (typeof (candidate as { getViewType?: () => string }).getViewType === "function") {
      if ((candidate as { getViewType: () => string }).getViewType() === VIEW_TYPE_TASKCHUTE) {
        return candidate as TaskChuteView
      }
    }
    return null
  }

  async activateView(options: { reveal?: boolean } = {}): Promise<void> {
    const reveal = options.reveal !== false
    const { workspace } = this.plugin.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE);

    if (leaves.length > 0) {
      if (reveal) {
        await workspace.revealLeaf(leaves[0]);
      }
      return;
    }

    // Ambient execution must keep working when the user has closed the
    // TaskChute view, without stealing focus from the note they are editing.
    const leaf = workspace.getLeaf(reveal ? false : 'tab');
    await leaf.setViewState({ type: VIEW_TYPE_TASKCHUTE, active: reveal });
    if (reveal) {
      await workspace.revealLeaf(leaf);
    }
  }

  async getOrCreateView(
    requiredMethods: Array<keyof TaskChuteView> = [],
    options: { reveal?: boolean } = {},
  ): Promise<TaskChuteView | null> {
    let view = this.getView();
    const hasAll = (candidate: TaskChuteView | null): candidate is TaskChuteView =>
      Boolean(candidate && requiredMethods.every((method) => typeof candidate[method] === "function"));

    if (hasAll(view)) return view;

    try {
      this.plugin.app.workspace.detachLeavesOfType(VIEW_TYPE_TASKCHUTE);
    } catch {
      // Ignore workspace detach failures (e.g., during tests)
    }

    await this.activateView(options);
    await new Promise((resolve) => activeWindow.setTimeout(resolve, 50));

    view = this.getView();
    if (hasAll(view)) return view;
    return view;
  }

  /**
   * Create a short-lived, non-active TaskChute view for automation. Ambient
   * work must never borrow a visible view because changing/reloading its date
   * can race with the user's navigation.
   */
  async createBackgroundView(
    requiredMethods: Array<keyof TaskChuteView> = [],
  ): Promise<TaskChuteBackgroundViewSession | null> {
    const { workspace } = this.plugin.app
    const originalActiveLeaf = workspace.getMostRecentLeaf()
    const leaf = workspace.getLeaf('tab')
    let closed = false
    const restoreOriginalIfBackgroundActive = (): void => {
      if (
        originalActiveLeaf === null ||
        workspace.getMostRecentLeaf() !== leaf
      ) {
        return
      }
      try {
        // focus:false restores workspace selection without pulling keyboard
        // focus away from the user's current control inside TaskChute.
        workspace.setActiveLeaf(originalActiveLeaf, { focus: false })
      } catch (error) {
        this.plugin._log?.(
          'warn',
          '[TaskChute] Failed to restore the active view after Ambient execution',
          error,
        )
      }
    }
    const close = (): void => {
      if (closed) return
      closed = true
      // getLeaf('tab') can become the most-recent leaf even when its view
      // state is requested with active:false. Decide before detach: detaching
      // that leaf makes Obsidian choose an adjacent tab, losing the user's
      // original TaskChute view. If the user selected another leaf while the
      // Ambient run was starting, respect that selection and do not steal it.
      restoreOriginalIfBackgroundActive()
      try {
        ;(leaf as { detach?: () => void }).detach?.()
      } catch (error) {
        this.plugin._log?.(
          'warn',
          '[TaskChute] Failed to detach Ambient background view',
          error,
        )
      }
    }

    try {
      await leaf.setViewState({
        type: VIEW_TYPE_TASKCHUTE,
        active: false,
      })
      // Obsidian still activates a newly-created 'tab' leaf even when the
      // requested view state says active:false. Restore immediately so the
      // user's visible TaskChute pane receives and displays the new run while
      // the isolated view performs its background reload.
      restoreOriginalIfBackgroundActive()
      await new Promise((resolve) => activeWindow.setTimeout(resolve, 50))

      const candidate = leaf.view as TaskChuteView | undefined
      const usable = Boolean(
        candidate &&
          candidate.getViewType?.() === VIEW_TYPE_TASKCHUTE &&
          requiredMethods.every(
            (method) => typeof candidate[method] === 'function',
          ),
      )
      if (!usable || !candidate) {
        close()
        return null
      }
      return { view: candidate, close }
    } catch (error) {
      close()
      this.plugin._log?.(
        'warn',
        '[TaskChute] Failed to create Ambient background view',
        error,
      )
      return null
    }
  }

  /**
   * Mirror runs started by a short-lived Ambient background view into every
   * already-open user TaskChute view. The source is explicitly excluded: it
   * already owns the authoritative start transition and will be detached by
   * its session owner immediately after this fan-out.
   */
  syncAmbientAiTaskRuns(
    sourceView: TaskChuteView,
    startedRuns: readonly AmbientAiTaskStartedRun[],
    dateKey: string,
  ): void {
    if (startedRuns.length === 0) return

    const visited = new Set<TaskChuteView>()
    const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
    for (const leaf of leaves) {
      const candidate = leaf.view as TaskChuteView | undefined
      if (!candidate || candidate === sourceView || visited.has(candidate)) {
        continue
      }
      if (candidate.getViewType?.() !== VIEW_TYPE_TASKCHUTE) continue
      if (typeof candidate.syncAmbientAiTaskRuns !== 'function') continue

      visited.add(candidate)
      try {
        candidate.syncAmbientAiTaskRuns(startedRuns, dateKey)
      } catch (error) {
        this.plugin._log?.(
          'warn',
          '[TaskChute] Failed to sync Ambient run into an open view',
          error,
        )
      }
    }
  }

  async triggerShowTodayTasks(): Promise<void> {
    const view = await this.getOrCreateView(["showTodayTasks"]);
    if (!view) {
      await this.activateView();
      return;
    }
    view.showTodayTasks();
  }

  async triggerDuplicateSelectedTask(): Promise<void> {
    const view = await this.getOrCreateView(["duplicateSelectedTask"]);
    if (!view) {
      new Notice(t("notices.viewNotOpen", "TaskChute view is not open"));
      return;
    }
    await view.duplicateSelectedTask();
  }

  async triggerDeleteSelectedTask(): Promise<void> {
    const view = await this.getOrCreateView(["deleteSelectedTask"]);
    if (!view) {
      new Notice(t("notices.viewNotOpen", "TaskChute view is not open"));
      return;
    }
    view.deleteSelectedTask();
  }

  async triggerResetSelectedTask(): Promise<void> {
    const view = await this.getOrCreateView(["resetSelectedTask"]);
    if (!view) {
      new Notice(t("notices.viewNotOpen", "TaskChute view is not open"));
      return;
    }
    await view.resetSelectedTask();
  }

  reorganizeIdleTasks(): void {
    const view = this.getView();
    if (!view) {
      new Notice(t("notices.viewNotOpen", "TaskChute view is not open"));
      return;
    }
    view.reorganizeIdleTasks();
  }

  applyLocaleToActiveView(): void {
    const view = this.getView();
    const viewWithLocale = view as TaskChuteView & { applyLocale?: () => void };
    if (viewWithLocale && typeof viewWithLocale.applyLocale === "function") {
      try {
        viewWithLocale.applyLocale();
      } catch (error) {
        console.warn("Failed to apply locale to TaskChuteView", error);
      }
    }
  }
}
