/**
 * Renderer-local handoff for live AI terminal processes.
 *
 * Obsidian plugin hot reload creates a new Plugin instance in the same
 * renderer. Killing the manager synchronously from the old instance makes
 * the restored terminal read-only because no process handle remains. This
 * short lease keeps the manager on the owning renderer window, where the next instance
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
  /** Plugin-instance ownership generation; incremented on every adoption. */
  generation: number
  releaseTimer: number | null
  /**
   * Set when the window fired pagehide: the renderer itself is being
   * torn down (reload/close), not just this plugin instance. The unload
   * sequence still runs Plugin.onunload -> the hot-reload handoff, which
   * must NOT dispose then: dispose would race a broker stop op against
   * renderer teardown and sometimes kill the live CLI the next renderer is
   * about to re-attach. Broker-owned sessions survive; the next renderer
   * restores them from the persisted session state.
   */
  rendererUnloading: boolean
  readonly pageHide: () => void
}

/**
 * Slot shape shipped by the previous bundle under the same V1 storage key.
 * Keep this reader until every live renderer has had a chance to hot-upgrade:
 * an old beforeunload listener must be removed before the new pagehide lease
 * is installed, otherwise the old callback can delete the new slot during
 * the next renderer reload.
 */
interface LegacyAiTaskRuntimeSlot extends RuntimeAppIdentity {
  readonly manager: AiTaskManager
  releaseTimer: number | null
  readonly beforeUnload: () => void
}

type AnyAiTaskRuntimeSlot =
  | AiTaskRuntimeSlot
  | LegacyAiTaskRuntimeSlot

export interface AiTaskRuntimeWindow {
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(handle: number): void
  addEventListener(
    type: 'pagehide' | 'beforeunload',
    listener: () => void,
  ): void
  removeEventListener(
    type: 'pagehide' | 'beforeunload',
    listener: () => void,
  ): void
  [AI_TASK_RUNTIME_SLOT_KEY]?: AnyAiTaskRuntimeSlot
}

/**
 * Remember the renderer that owns each manager. `activeWindow` follows the
 * currently focused Obsidian popout, so resolving it again during unload can
 * target a different window and lose the lease. The global `window` is stable
 * for the lifetime of this plugin renderer; the WeakMap also lets adopted
 * managers keep using the window from which they were acquired.
 */
const managerRuntimeWindows = new WeakMap<object, AiTaskRuntimeWindow>()

function runtimeWindow(): AiTaskRuntimeWindow {
  return window as unknown as AiTaskRuntimeWindow
}

function legacyFocusedRuntimeWindow(): AiTaskRuntimeWindow | undefined {
  try {
    if (typeof activeWindow === 'undefined') return undefined
    return activeWindow as unknown as AiTaskRuntimeWindow
  } catch {
    return undefined
  }
}

function isCurrentSlot(
  slot: AnyAiTaskRuntimeSlot,
): slot is AiTaskRuntimeSlot {
  return (
    'pageHide' in slot &&
    typeof slot.pageHide === 'function' &&
    'rendererUnloading' in slot
  )
}

function resolveRuntimeWindow(
  manager: object,
  explicitWindow?: AiTaskRuntimeWindow,
): AiTaskRuntimeWindow {
  return explicitWindow ?? managerRuntimeWindows.get(manager) ?? runtimeWindow()
}

function clearSlot(
  win: AiTaskRuntimeWindow,
  slot: AnyAiTaskRuntimeSlot,
): void {
  if (slot.releaseTimer !== null) {
    win.clearTimeout(slot.releaseTimer)
    slot.releaseTimer = null
  }
  if (isCurrentSlot(slot)) {
    win.removeEventListener('pagehide', slot.pageHide)
  } else {
    win.removeEventListener('beforeunload', slot.beforeUnload)
  }
  if (win[AI_TASK_RUNTIME_SLOT_KEY] === slot) {
    delete win[AI_TASK_RUNTIME_SLOT_KEY]
  }
  if (managerRuntimeWindows.get(slot.manager) === win) {
    managerRuntimeWindows.delete(slot.manager)
  }
}

function installCurrentSlot(
  win: AiTaskRuntimeWindow,
  app: object,
  manager: AiTaskManager,
  generation = 1,
): AiTaskRuntimeSlot {
  const slot: AiTaskRuntimeSlot = {
    app,
    manager,
    generation:
      Number.isSafeInteger(generation) && generation >= 1
        ? generation
        : 1,
    releaseTimer: null,
    rendererUnloading: false,
    pageHide: () => {
      // `pagehide` is non-cancelable and fires only once navigation/close is
      // committed. `beforeunload` can be canceled; detaching there would leave
      // the still-visible renderer with no terminal listeners or broker IPC.
      if (slot.releaseTimer !== null) {
        win.clearTimeout(slot.releaseTimer)
        slot.releaseTimer = null
      }
      slot.rendererUnloading = true
      manager.prepareForRendererReload()
    },
  }
  win[AI_TASK_RUNTIME_SLOT_KEY] = slot
  managerRuntimeWindows.set(manager, win)
  // This listener is intentionally not plugin-registered: it must remain
  // alive during the brief gap between old unload and new onload.
  win.addEventListener('pagehide', slot.pageHide)
  return slot
}

function moveSlotToCurrentSchema(
  sourceWindow: AiTaskRuntimeWindow,
  targetWindow: AiTaskRuntimeWindow,
  slot: AnyAiTaskRuntimeSlot,
): AiTaskRuntimeSlot {
  const generation = isCurrentSlot(slot) ? slot.generation : 1
  clearSlot(sourceWindow, slot)
  return installCurrentSlot(
    targetWindow,
    slot.app,
    slot.manager,
    generation,
  )
}

/** Adopt a manager retained by the immediately preceding plugin instance. */
export function acquireRetainedAiTaskManager(
  app: object,
  deps: AiTaskManagerDeps,
  win: AiTaskRuntimeWindow = runtimeWindow(),
  legacyFocusedWindow: AiTaskRuntimeWindow | undefined =
    legacyFocusedRuntimeWindow(),
): AiTaskManager | undefined {
  let sourceWindow = win
  let slot = win[AI_TASK_RUNTIME_SLOT_KEY]

  // The previous release stored its V1 slot on focus-sensitive activeWindow.
  // During a hot upgrade that may be a popout rather than the root renderer.
  // Discover it once, remove its old beforeunload listener, and move the live
  // manager onto the stable root window.
  if (
    !slot &&
    legacyFocusedWindow !== undefined &&
    legacyFocusedWindow !== win
  ) {
    slot = legacyFocusedWindow[AI_TASK_RUNTIME_SLOT_KEY]
    sourceWindow = legacyFocusedWindow
  }
  if (!slot) return undefined
  if (slot.app !== app || slot.manager.isDisposed()) {
    clearSlot(sourceWindow, slot)
    if (!slot.manager.isDisposed()) slot.manager.dispose()
    return undefined
  }
  if (!isCurrentSlot(slot) || sourceWindow !== win) {
    slot = moveSlotToCurrentSchema(sourceWindow, win, slot)
    sourceWindow = win
  }
  if (slot.releaseTimer !== null) {
    sourceWindow.clearTimeout(slot.releaseTimer)
    slot.releaseTimer = null
  }
  slot.generation =
    Number.isSafeInteger(slot.generation) && slot.generation >= 0
      ? slot.generation + 1
      : 1
  // Adoption after a same-renderer plugin reload re-arms normal handoff
  // semantics. A canceled beforeunload never reaches pagehide, so it leaves
  // this flag and the live terminal transport untouched.
  slot.rendererUnloading = false
  managerRuntimeWindows.set(slot.manager, win)
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
  if (existing?.manager === manager) {
    if (!isCurrentSlot(existing)) {
      moveSlotToCurrentSchema(win, win, existing)
    }
    return
  }
  if (existing) {
    clearSlot(win, existing)
    if (!existing.manager.isDisposed()) existing.manager.dispose()
  }

  installCurrentSlot(win, app, manager)
}

/**
 * Give the next plugin instance a bounded chance to adopt the live manager.
 * If no instance arrives (plugin disabled/deleted), processes are stopped.
 */
export function scheduleAiTaskManagerHotReloadHandoff(
  manager: AiTaskManager,
  win?: AiTaskRuntimeWindow,
  graceMs = AI_TASK_RUNTIME_HANDOFF_GRACE_MS,
  expectedGeneration?: number,
): void {
  const targetWindow = resolveRuntimeWindow(manager, win)
  let slot = targetWindow[AI_TASK_RUNTIME_SLOT_KEY]
  if (!slot || slot.manager !== manager || manager.isDisposed()) {
    manager.dispose()
    return
  }
  if (!isCurrentSlot(slot)) {
    // A caller from the new bundle can race acquisition during a hot update.
    // Migrate in place before consulting generation/pagehide state.
    slot = moveSlotToCurrentSchema(targetWindow, targetWindow, slot)
  }
  // Obsidian normally unloads the old plugin before loading the new one, but
  // keep the lease correct even if those callbacks are interleaved: an old
  // instance must never arm a disposal timer after a newer instance adopted
  // the same manager.
  if (
    expectedGeneration !== undefined &&
    slot.generation !== expectedGeneration
  ) {
    return
  }
  if (slot.rendererUnloading) {
    // Renderer reload in progress: prepareForRendererReload already
    // persisted the session state and detached the broker transport.
    // Neither dispose nor a grace timer may run — the window (and this
    // slot) dies with the reload, and broker-owned processes must outlive
    // it for the next renderer to re-attach.
    if (slot.releaseTimer !== null) {
      targetWindow.clearTimeout(slot.releaseTimer)
      slot.releaseTimer = null
    }
    return
  }
  if (slot.releaseTimer !== null) targetWindow.clearTimeout(slot.releaseTimer)
  const releaseTimer = targetWindow.setTimeout(() => {
    // clearTimeout normally prevents a stale callback, but a callback that
    // was already queued can still run after pagehide/adoption. The handle
    // and committed-renderer guards make that race a no-op.
    if (
      slot.releaseTimer !== releaseTimer ||
      slot.rendererUnloading ||
      targetWindow[AI_TASK_RUNTIME_SLOT_KEY] !== slot
    ) {
      return
    }
    slot.releaseTimer = null
    manager.dispose()
    clearSlot(targetWindow, slot)
  }, Math.max(0, graceMs))
  slot.releaseTimer = releaseTimer
}

/** Capture the ownership generation for the current plugin instance. */
export function getAiTaskRuntimeLeaseGeneration(
  manager: AiTaskManager,
  win?: AiTaskRuntimeWindow,
): number | undefined {
  const targetWindow = resolveRuntimeWindow(manager, win)
  const slot = targetWindow[AI_TASK_RUNTIME_SLOT_KEY]
  return slot?.manager === manager && isCurrentSlot(slot)
    ? slot.generation
    : undefined
}

/**
 * Explicit feature disable is not a hot reload: remove the lease before the
 * normal tracked SIGTERM -> SIGKILL disposal begins.
 */
export function forgetRetainedAiTaskManager(
  manager: Pick<AiTaskManager, 'dispose'>,
  win?: AiTaskRuntimeWindow,
): void {
  const targetWindow = resolveRuntimeWindow(manager, win)
  const slot = targetWindow[AI_TASK_RUNTIME_SLOT_KEY]
  if (!slot || slot.manager !== manager) return
  clearSlot(targetWindow, slot)
}
