import { App, Plugin } from "obsidian"
import { TaskChuteSettings, PathManagerLike } from "../types"
import type { AiTaskManager } from "../features/ai-task/services/AiTaskManager"
import type { LicenseManager } from "../features/license/services/LicenseManager"

/**
 * The slice of the plugin the settings tab and its services depend on.
 *
 * Kept separate from the tab so the extracted services can be exercised
 * without constructing a settings tab.
 */
export interface PluginWithSettings extends Plugin {
  app: App
  settings: TaskChuteSettings
  pathManager: PathManagerLike
  aiTaskManager?: AiTaskManager
  aiTaskManagersPendingDisposal?: Set<AiTaskManager>
  aiTaskLifecycleActive?: boolean
  aiTaskLifecycleGeneration?: number
  aiTaskRuntimeLeaseGeneration?: number
  licenseManager?: LicenseManager
  saveSettings(): Promise<void>
  _log?(level?: string, ...args: unknown[]): void
}
