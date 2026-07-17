/**
 * Renderer-local handoff for live AI terminal processes.
 *
 * Obsidian plugin hot reload creates a new Plugin instance in the same
 * renderer. Killing the manager synchronously from the old instance makes
 * the restored terminal read-only because no process handle remains. This
 * short lease keeps the manager on `activeWindow`, where the next instance
 * can adopt it and rebind its plugin-owned dependencies.
 *
 * A real renderer reload detaches from the external terminal broker. App
 * quit and the settings OFF transition still call disposeAndWait, which
 * shuts the broker down after killing every owned session.
 */

import type { AiTaskManager, AiTaskManagerDeps } from './AiTaskManager'

export const AI_TASK_RUNTIME_HANDOFF_GRACE_MS = 10_000
const AI_TASK_RUNTIME_SLOT_KEY = '__taskchutePlusAiTaskRuntimeLeaseV1__'

interface RuntimeAppIdentity {
  readonly app: object
}

interface AiTaskRuntimeSlot extends RuntimeAppIdentity {
  readonly manager: AiTaskManager
  releaseTimer: number | null
  readonly beforeUnload: () => void
}

export interface AiTaskRuntimeWindow {
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(handle: number): void
  addEventListener(type: 'beforeunload', listener: () => void): void
  removeEventListener(type: 'beforeunload', listener: () => void): void
  [AI_TASK_RUNTIME_SLOT_KEY]?: AiTaskRuntimeSlot
}

function runtimeWindow(): AiTaskRuntimeWindow {
  return activeWindow as unknown as AiTaskRuntimeWindow
}

function clearSlot(
  win: AiTaskRuntimeWindow,
  slot: AiTaskRuntimeSlot,
): void {
  if (slot.releaseTimer !== null) {
    win.clearTimeout(slot.releaseTimer)
    slot.releaseTimer = null
  }
  win.removeEventListener('beforeunload', slot.beforeUnload)
  if (win[AI_TASK_RUNTIME_SLOT_KEY] === slot) {
    delete win[AI_TASK_RUNTIME_SLOT_KEY]
  }
}

/** Adopt a manager retained by the immediately preceding plugin instance. */
export function acquireRetainedAiTaskManager(
  app: object,
  deps: AiTaskManagerDeps,
  win: AiTaskRuntimeWindow = runtimeWindow(),
): AiTaskManager | undefined {
  const slot = win[AI_TASK_RUNTIME_SLOT_KEY]
  if (!slot) return undefined
  if (slot.app !== app || slot.manager.isDisposed()) {
    clearSlot(win, slot)
    if (!slot.manager.isDisposed()) slot.manager.dispose()
    return undefined
  }
  if (slot.releaseTimer !== null) {
    win.clearTimeout(slot.releaseTimer)
    slot.releaseTimer = null
  }
  try {
    slot.manager.rebindRuntimeDependencies(deps)
    return slot.manager
  } catch {
    clearSlot(win, slot)
    slot.manager.dispose()
    return undefined
  }
}

/** Publish a newly created manager as the renderer's one live AI runtime. */
export function retainAiTaskManager(
  app: object,
  manager: AiTaskManager,
  win: AiTaskRuntimeWindow = runtimeWindow(),
): void {
  const existing = win[AI_TASK_RUNTIME_SLOT_KEY]
  if (existing?.manager === manager) return
  if (existing) {
    clearSlot(win, existing)
    if (!existing.manager.isDisposed()) existing.manager.dispose()
  }

  const slot: AiTaskRuntimeSlot = {
    app,
    manager,
    releaseTimer: null,
    beforeUnload: () => {
      manager.prepareForRendererReload()
      clearSlot(win, slot)
    },
  }
  win[AI_TASK_RUNTIME_SLOT_KEY] = slot
  // This listener is intentionally not plugin-registered: it must remain
  // alive during the brief gap between old unload and new onload.
  win.addEventListener('beforeunload', slot.beforeUnload)
}

/**
 * Give the next plugin instance a bounded chance to adopt the live manager.
 * If no instance arrives (plugin disabled/deleted), processes are stopped.
 */
export function scheduleAiTaskManagerHotReloadHandoff(
  manager: AiTaskManager,
  win: AiTaskRuntimeWindow = runtimeWindow(),
  graceMs = AI_TASK_RUNTIME_HANDOFF_GRACE_MS,
): void {
  const slot = win[AI_TASK_RUNTIME_SLOT_KEY]
  if (!slot || slot.manager !== manager || manager.isDisposed()) {
    manager.dispose()
    return
  }
  if (slot.releaseTimer !== null) win.clearTimeout(slot.releaseTimer)
  slot.releaseTimer = win.setTimeout(() => {
    slot.releaseTimer = null
    if (win[AI_TASK_RUNTIME_SLOT_KEY] !== slot) return
    manager.dispose()
    clearSlot(win, slot)
  }, Math.max(0, graceMs))
}

/**
 * Explicit feature disable is not a hot reload: remove the lease before the
 * normal tracked SIGTERM -> SIGKILL disposal begins.
 */
export function forgetRetainedAiTaskManager(
  manager: Pick<AiTaskManager, 'dispose'>,
  win: AiTaskRuntimeWindow = runtimeWindow(),
): void {
  const slot = win[AI_TASK_RUNTIME_SLOT_KEY]
  if (!slot || slot.manager !== manager) return
  clearSlot(win, slot)
}
