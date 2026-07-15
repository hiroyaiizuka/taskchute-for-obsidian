import { Notice, Plugin } from 'obsidian'

import type { TaskChuteSettings } from "./types"
import type { PathService } from "./services/PathService"
import type { RoutineAliasService } from "./features/routine/services/RoutineAliasService"
import type DayStatePersistenceService from "./services/DayStatePersistenceService"
import type { LocaleCoordinatorHandle } from "./app/context/PluginContext"
import type { TaskChuteViewController } from "./app/taskchute/TaskChuteViewController"
import type { ReminderSystemManager } from "./features/reminder/services/ReminderSystemManager"
import type { AiTaskManager } from "./features/ai-task/services/AiTaskManager"
import { registerAiTaskAppShutdownCleanup } from "./features/ai-task/registerProcessCleanup"
import { createAiTaskAmbientScheduler } from "./features/ai-task/AiTaskAmbientRuntime"
import type { AiTaskAmbientScheduler } from "./features/ai-task/services/AiTaskAmbientScheduler"
import { VIEW_TYPE_TASKCHUTE } from "./types"
import { openSettingsModal } from "./ui/modals/PathSettingsModal"
import { bootstrapPlugin, prepareSettings } from "./app/bootstrap"
import type { PluginContext } from "./app/context/PluginContext"

export default class TaskChutePlusPlugin extends Plugin {
  settings!: TaskChuteSettings
  pathManager!: PathService
  routineAliasService!: RoutineAliasService
  dayStateService!: DayStatePersistenceService
  globalTimerInterval?: ReturnType<typeof setInterval> | null
  private viewController!: TaskChuteViewController
  private localeCoordinator?: LocaleCoordinatorHandle
  /** Reminder manager for notification scheduling (exposed for TaskChuteView) */
  reminderManager?: ReminderSystemManager
  /** AI task run manager (present only when enabled on desktop) */
  aiTaskManager?: AiTaskManager
  /** Plugin-owned Ambient routine clock (one instance, independent of views). */
  private aiTaskAmbientScheduler?: AiTaskAmbientScheduler
  /** Disabled managers whose SIGTERM -> SIGKILL disposal is still pending */
  readonly aiTaskManagersPendingDisposal = new Set<AiTaskManager>()

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
    this.reminderManager = context.reminderManager
    registerAiTaskAppShutdownCleanup(this)
    const ambientScheduler = createAiTaskAmbientScheduler(
      this,
      this.viewController,
    )
    this.aiTaskAmbientScheduler = ambientScheduler
    // Leaf creation is reliable only after Obsidian has restored the layout.
    // If the plugin unloads first, dispose() makes the callback a no-op.
    this.app.workspace.onLayoutReady(() => {
      if (this.aiTaskAmbientScheduler !== ambientScheduler) return
      void ambientScheduler.start().catch((error) => {
        this._log('warn', '[AiTaskAmbientScheduler] Startup failed', error)
      })
    })
  }

  onunload(): void {
    // Clear timer intervals
    if (this.globalTimerInterval) {
      activeWindow.clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
    }

    this.localeCoordinator?.dispose()

    // Dispose reminder system
    this.reminderManager?.dispose()

    // Stop Ambient checks and resume/focus listeners.
    this.aiTaskAmbientScheduler?.dispose()
    this.aiTaskAmbientScheduler = undefined

    // Stop all AI runs (SIGTERM now, SIGKILL escalation on a window timer)
    this.aiTaskManager?.dispose()

    // Clear boundary check timeout
    const view = this.viewController?.getView?.()
    if (view && view.boundaryCheckTimeout) {
      const timeout = view.boundaryCheckTimeout
      const timeoutWindow = view.boundaryCheckWindow ?? activeWindow
      view.boundaryCheckTimeout = null
      view.boundaryCheckWindow = null
      timeoutWindow.clearTimeout(timeout)
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
