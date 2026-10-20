import { requestsSkipPermissions } from '../config/AiTaskArgsCodec'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'

/**
 * This device's consent to run AI tasks in skip-permissions mode (LEV-386).
 *
 * A task note can come from anyone who can write to a synced or shared vault,
 * so the note only asks for skip-permissions; this device decides. The
 * consent lives in Obsidian's per-vault local storage, which is never synced,
 * so a shared vault cannot turn it on here.
 */
export const AI_SKIP_PERMISSIONS_STORAGE_KEY = 'taskchute-plus-ai-skip-permissions'

/** App#loadLocalStorage / App#saveLocalStorage: device-local, not synced. */
export interface DeviceLocalStorage {
  loadLocalStorage?(key: string): unknown
  saveLocalStorage?(key: string, value: unknown): void
}

export function isSkipPermissionsAllowedOnThisDevice(
  storage: DeviceLocalStorage,
): boolean {
  try {
    return storage.loadLocalStorage?.(AI_SKIP_PERMISSIONS_STORAGE_KEY) === true
  } catch {
    return false
  }
}

export function setSkipPermissionsAllowedOnThisDevice(
  storage: DeviceLocalStorage,
  allowed: boolean,
): void {
  try {
    storage.saveLocalStorage?.(AI_SKIP_PERMISSIONS_STORAGE_KEY, allowed ? true : null)
  } catch {
    // Best effort: without storage the next run asks again.
  }
}

/** Who started the run: the user (▶), or the plugin (schedule, link). */
export type AiRunTrigger = 'manual' | 'automatic'

/**
 * Whether this run may use skip-permissions. A task that asks for it on a
 * device that has not allowed it asks once when the user starts it, and the
 * answer is kept for the device. An automatic start cannot ask, so the run
 * uses auto mode instead.
 */
export async function resolveSkipPermissionsForRun(input: {
  storage: DeviceLocalStorage
  frontmatter: Record<string, unknown> | null | undefined
  trigger: AiRunTrigger
  confirm: () => Promise<boolean>
}): Promise<boolean> {
  if (isSkipPermissionsAllowedOnThisDevice(input.storage)) return true
  const config = readAiTaskConfig(input.frontmatter)
  if (!config || !requestsSkipPermissions(config.host, config.args)) return false
  if (input.trigger !== 'manual') return false
  if (!(await input.confirm())) return false
  setSkipPermissionsAllowedOnThisDevice(input.storage, true)
  return true
}
