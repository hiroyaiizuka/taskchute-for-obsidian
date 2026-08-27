/**
 * Keeps the AiTaskManager in step with the license state.
 *
 * The settings toggle has its own path (SettingsTab#applyAiTaskEnabledChange)
 * because a user-driven change can report failures interactively. This one runs
 * unattended, when a background token refresh flips the entitlement, so it
 * stays silent and errs toward tearing the runtime down.
 */
import { canStartAiTaskRuntime, isAiTaskLicensed } from './availability'
import { createAiTaskManager, type AiTaskPluginLike } from './index'
import { disposeAiTaskManagerTracked } from './registerProcessCleanup'
import type { AiTaskManager } from './services/AiTaskManager'

export interface AiTaskLicenseGateHost extends AiTaskPluginLike {
  aiTaskManager?: AiTaskManager
  aiTaskManagersPendingDisposal?: Set<AiTaskManager>
}

/**
 * Create or dispose the manager so it matches the current gates. Returns true
 * when a manager is running afterwards.
 */
export async function syncAiTaskManagerToLicense(
  plugin: AiTaskLicenseGateHost,
): Promise<boolean> {
  if (!isAiTaskLicensed(plugin)) {
    const manager = plugin.aiTaskManager
    if (manager) {
      // Revocation must take effect now, not at the next restart: an already
      // running CLI keeps its process, but no new run can be started.
      plugin._log?.('debug', '[AiTask] License no longer active; disposing runtime')
      disposeAiTaskManagerTracked(plugin, manager)
      plugin.aiTaskManager = undefined
      plugin.aiTaskRuntimeLeaseGeneration = undefined
    }
    return false
  }

  if (plugin.aiTaskManager) return true
  // Checked before the pending-disposal wait below: there is no point draining
  // a previous runtime for a manager the factory would refuse to build.
  if (!canStartAiTaskRuntime(plugin)) return false

  // A new manager reuses the vault-scoped broker identity, so it must not start
  // while a previous one is still shutting down or that shutdown would kill it.
  const pending = plugin.aiTaskManagersPendingDisposal
  if (pending && pending.size > 0) {
    const results = await Promise.allSettled(
      Array.from(pending).map(async (manager) => {
        await manager.disposeAndWait()
        pending.delete(manager)
      }),
    )
    if (results.some((result) => result.status === 'rejected')) {
      plugin._log?.(
        'warn',
        '[AiTask] Previous runtime did not stop cleanly; leaving AI tasks off',
      )
      return false
    }
  }

  plugin.aiTaskManager = createAiTaskManager(plugin)

  return plugin.aiTaskManager !== undefined
}
