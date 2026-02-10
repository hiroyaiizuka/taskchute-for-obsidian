import { Notice } from "obsidian";

import { t } from "../../i18n";
import { VIEW_TYPE_TASKCHUTE } from "../../types";

import type { TaskChutePluginLike } from "../../types";
import type { TaskChuteView } from "../../features/core/views/TaskChuteView";

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

  async activateView(): Promise<void> {
    const { workspace } = this.plugin.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE);

    if (leaves.length > 0) {
      await workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_TASKCHUTE, active: true });
    await workspace.revealLeaf(leaf);
  }

  async getOrCreateView(requiredMethods: Array<keyof TaskChuteView> = []): Promise<TaskChuteView | null> {
    let view = this.getView();
    const hasAll = (candidate: TaskChuteView | null): candidate is TaskChuteView =>
      Boolean(candidate && requiredMethods.every((method) => typeof candidate[method] === "function"));

    if (hasAll(view)) return view;

    try {
      this.plugin.app.workspace.detachLeavesOfType(VIEW_TYPE_TASKCHUTE);
    } catch {
      // Ignore workspace detach failures (e.g., during tests)
    }

    await this.activateView();
    await new Promise((resolve) => setTimeout(resolve, 50));

    view = this.getView();
    if (hasAll(view)) return view;
    return view;
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
