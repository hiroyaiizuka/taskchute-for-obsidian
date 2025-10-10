import { Notice, Plugin } from "obsidian"

import type { TaskChuteSettings } from "./types"
import type { PathManager } from "./managers/PathManager"
import type { RoutineAliasManager } from "./managers/RoutineAliasManager"
import type DayStateService from "./services/DayStateService"
import type { LocaleCoordinatorHandle } from "./app/context/PluginContext"
import type { TaskChuteViewController } from "./app/taskchute/TaskChuteViewController"
import { VIEW_TYPE_TASKCHUTE } from "./types"
import { openSettingsModal } from "./ui/modals/PathSettingsModal"
import { bootstrapPlugin, prepareSettings } from "./app/bootstrap"
import type { PluginContext } from "./app/context/PluginContext"

export default class TaskChutePlusPlugin extends Plugin {
  settings!: TaskChuteSettings
  pathManager!: PathManager
  routineAliasManager!: RoutineAliasManager
  dayStateService!: DayStateService
  globalTimerInterval?: ReturnType<typeof setInterval> | null
  private viewController!: TaskChuteViewController
  private localeCoordinator?: LocaleCoordinatorHandle

  // Simple logger/notification wrapper
  _log(level: keyof Console | undefined, ...args: unknown[]): void {
    try {
      if (level === "warn") {
        console.warn(...args)
      } else if (level === "error") {
        console.error(...args)
      } else {
        console.debug(...args)
      }
    } catch {
      // Ignore logging errors in production builds
    }
  }

  _notify(message: string, timeout?: number): void {
    try {
      new Notice(message, timeout)
    } catch (error) {
      this._log("warn", "[Notice]", message, error)
    }
  }

  async onload(): Promise<void> {
    this.settings = await prepareSettings(this)

    const context: PluginContext = await bootstrapPlugin(this)
    this.viewController = context.viewController
    this.localeCoordinator = context.localeCoordinator
  }

  async onunload(): Promise<void> {
    // Clear timer intervals
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
    }

    this.localeCoordinator?.dispose()

    // Clear boundary check timeout
    const view = this.viewController?.getView?.()
    if (view && view.boundaryCheckTimeout) {
      clearTimeout(view.boundaryCheckTimeout)
      view.boundaryCheckTimeout = null
    }

    // Clean up views
    this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE).forEach((leaf) => {
      if (leaf.view && leaf.view.onunload) {
        leaf.view.onunload()
      }
    })
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  showSettingsModal(): void {
    openSettingsModal(this)
  }
}
