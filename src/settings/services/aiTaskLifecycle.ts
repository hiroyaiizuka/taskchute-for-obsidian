import { App, Notice } from "obsidian"
import { t } from "../../i18n"
import { createAiTaskManager } from "../../features/ai-task"
import { disposeAiTaskManagerTracked } from "../../features/ai-task/registerProcessCleanup"
import type { PluginWithSettings } from "../pluginWithSettings"
import { notifyAiTaskSettingsChanged } from "./viewNotifications"

/**
 * One in-flight toggle of the AI task setting.
 *
 * Captured before the first await so a completion that lands after a newer
 * toggle — or after a hot reload swapped the Plugin instance — can be
 * recognised as stale and dropped.
 */
export interface AiTaskToggleRequest {
  readonly operation: number
  readonly lifecycleGeneration: number | undefined
  readonly enabled: boolean
}

/**
 * Owns the toggle sequence number. Lives on the settings tab, so it is scoped
 * to one tab instance the same way the old private field was.
 */
export class AiTaskToggleGuard {
  private operation = 0

  begin(plugin: PluginWithSettings, enabled: boolean): AiTaskToggleRequest {
    this.operation += 1
    return {
      operation: this.operation,
      lifecycleGeneration: plugin.aiTaskLifecycleGeneration,
      enabled,
    }
  }

  isCurrent(plugin: PluginWithSettings, request: AiTaskToggleRequest): boolean {
    return (
      this.operation === request.operation &&
      plugin.settings.aiTaskEnabled === request.enabled &&
      isCurrentPluginInstance(plugin, request.lifecycleGeneration)
    )
  }
}

/**
 * Obsidian keeps the current Plugin instance in its internal registry.
 * Use it only as a stale-callback guard; lightweight test hosts without the
 * registry retain the normal behavior.
 */
export function isCurrentPluginInstance(
  plugin: PluginWithSettings,
  expectedLifecycleGeneration: number | undefined,
): boolean {
  if (plugin.aiTaskLifecycleActive === false) return false
  if (
    expectedLifecycleGeneration !== undefined &&
    plugin.aiTaskLifecycleGeneration !== expectedLifecycleGeneration
  ) {
    return false
  }
  const appWithPlugins = plugin.app as App & {
    plugins?: { plugins?: Record<string, unknown> }
  }
  const registry = appWithPlugins.plugins?.plugins
  if (!registry) return true
  const pluginId = plugin.manifest?.id
  return typeof pluginId === "string" && registry[pluginId] === plugin
}

/**
 * Creates or tears down the AI task runtime to match the saved setting.
 * Returns false when the change was abandoned — either it went stale mid-flight
 * or the previous runtime refused to shut down.
 */
export async function applyAiTaskEnabledChange(
  plugin: PluginWithSettings,
  guard: AiTaskToggleGuard,
  request: AiTaskToggleRequest,
): Promise<boolean> {
  if (request.enabled) {
    const pending = plugin.aiTaskManagersPendingDisposal
    const disposingManagers = Array.from(pending ?? [])
    if (disposingManagers.length > 0) {
      const results = await Promise.allSettled(
        disposingManagers.map(async (manager) => {
          await manager.disposeAndWait()
          pending?.delete(manager)
        }),
      )
      if (!guard.isCurrent(plugin, request)) return false
      if (results.some((result) => result.status === "rejected")) {
        // A new manager uses the same vault-scoped broker identity. Starting
        // it while the previous manager still owns an in-flight shutdown
        // lets that old shutdown kill the new run. Fail closed and persist
        // the actual disabled runtime state instead.
        plugin.settings.aiTaskEnabled = false
        await plugin.saveSettings()
        new Notice(
          t(
            "settings.aiTask.previousRuntimeShutdownFailed",
            "The previous AI runtime could not be stopped safely. AI tasks remain disabled; please try again.",
          ),
        )
        return false
      }
    }
    if (!plugin.aiTaskManager) {
      // Returns undefined off-desktop; the factory owns the platform gate.
      plugin.aiTaskManager = createAiTaskManager(plugin)
    }
    return true
  }
  const manager = plugin.aiTaskManager
  if (manager) disposeAiTaskManagerTracked(plugin, manager)
  plugin.aiTaskManager = undefined
  plugin.aiTaskRuntimeLeaseGeneration = undefined
  return true
}

/**
 * The whole toggle: persist, then bring the runtime in line, dropping out at
 * every point where a newer toggle or a replaced plugin instance has won.
 */
export async function handleAiTaskEnabledToggle(
  plugin: PluginWithSettings,
  guard: AiTaskToggleGuard,
  enabled: boolean,
): Promise<void> {
  const request = guard.begin(plugin, enabled)
  plugin.settings.aiTaskEnabled = enabled
  await plugin.saveSettings()
  // Settings tabs belong to one Plugin instance. A hot reload can replace that
  // instance while saveSettings is pending; the old callback must never
  // dispose or re-adopt the new owner's manager.
  if (!guard.isCurrent(plugin, request)) return
  const applied = await applyAiTaskEnabledChange(plugin, guard, request)
  if (!applied || !guard.isCurrent(plugin, request)) return
  notifyAiTaskSettingsChanged(plugin.app)
}
