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
export const AI_TASK_TERMINAL_SHUTDOWN_GRACE_MS = 60_000
export const AI_TASK_TERMINAL_RENDERER_LEASE_GENERATION_STORAGE_KEY =
  'taskchute-plus-ai-terminal-renderer-lease-generation-v1'
export const AI_TASK_TERMINAL_RENDERER_LEASE_OWNER_ID =
  'taskchute-plus-ai-terminal'
const AI_TASK_RUNTIME_SLOT_KEY = '__taskchutePlusAiTaskRuntimeLeaseV1__'

interface RuntimeAppIdentity {
  readonly app: object
}

export interface AiTaskTerminalRendererLeaseIdentity {
  readonly token: string
  readonly ownerId: string
  readonly generation: number
}

export interface AiTaskTerminalRendererLeaseGenerationStore {
  load(): unknown
  save(generation: number): void
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
  /** True once workspace quit/pagehide proves a renderer transition. */
  rendererTransitionCommitted: boolean
  /** Invalidates a canceled/stale beforeunload reset callback. */
  rendererTransitionEpoch: number
  rendererUnloadResetTimer: number | null
  /** Plugin-instance lease used to reject delayed old-renderer broker IPC. */
  terminalRendererLeaseToken: string
  /** Stable identity for every plugin generation that adopts this manager. */
  terminalRendererLeaseOwnerId: string
  /** Monotonic generation within terminalRendererLeaseOwnerId. */
  terminalRendererLeaseGeneration: number
  terminalRendererLeaseGenerationStore?:
    AiTaskTerminalRendererLeaseGenerationStore
  readonly beforeUnload: () => void
  readonly pageHide: () => void
}

/**
 * Intermediate slot shape shipped under the same V1 storage key. It listened
 * only to pagehide, so workspace/plugin unload could run first.
 */
interface PageHideOnlyAiTaskRuntimeSlot extends RuntimeAppIdentity {
  readonly manager: AiTaskManager
  generation: number
  releaseTimer: number | null
  rendererUnloading: boolean
  readonly pageHide: () => void
}

/** Original slot shape, retained only for live hot-upgrade migration. */
interface LegacyAiTaskRuntimeSlot extends RuntimeAppIdentity {
  readonly manager: AiTaskManager
  releaseTimer: number | null
  readonly beforeUnload: () => void
}

type AnyAiTaskRuntimeSlot =
  | AiTaskRuntimeSlot
  | PageHideOnlyAiTaskRuntimeSlot
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
let terminalRendererLeaseSequence = 0
let terminalRendererLeaseFallbackGeneration = 0

function createTerminalRendererLeaseToken(): string {
  terminalRendererLeaseSequence += 1
  return [
    Date.now().toString(36),
    terminalRendererLeaseSequence.toString(36),
    Math.random().toString(36).slice(2, 14),
  ].join('-')
}

/**
 * Reserve the lease before constructing AiTaskManager. Its constructor may
 * restore and attach persisted sessions synchronously, so assigning an
 * identity only in retainAiTaskManager would leave a short-lived random
 * BrokerClient owner able to arrive after the retained owner and roll it
 * back.
 */
function normalizeTerminalRendererLeaseGeneration(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : 0
}

function reserveTerminalRendererLeaseGeneration(
  store?: AiTaskTerminalRendererLeaseGenerationStore,
  floor = 0,
): number {
  const wallClockFloor = Math.min(
    Number.MAX_SAFE_INTEGER - 1,
    Date.now() * 1_024 + (terminalRendererLeaseSequence % 1_024),
  )
  let persisted = 0
  if (store) {
    try {
      persisted = normalizeTerminalRendererLeaseGeneration(store.load())
    } catch {
      // The wall-clock floor still prevents a stale lower generation in the
      // ordinary renderer-replacement path when storage is temporarily
      // unavailable.
    }
  }
  const next =
    Math.max(
      normalizeTerminalRendererLeaseGeneration(floor),
      persisted,
      terminalRendererLeaseFallbackGeneration,
      wallClockFloor - 1,
    ) + 1
  terminalRendererLeaseFallbackGeneration = next
  if (store) {
    try {
      store.save(next)
    } catch {
      // Fail closed: the current renderer still uses the new generation.
      // A later renderer with stale storage cannot supersede it with an
      // equal/lower generation at the broker.
    }
  }
  return next
}

export function createAiTaskTerminalRendererLeaseIdentity(
  store?: AiTaskTerminalRendererLeaseGenerationStore,
): AiTaskTerminalRendererLeaseIdentity {
  return {
    token: createTerminalRendererLeaseToken(),
    ownerId: AI_TASK_TERMINAL_RENDERER_LEASE_OWNER_ID,
    generation: reserveTerminalRendererLeaseGeneration(store),
  }
}

function terminalRendererLeaseIdentity(
  slot: AiTaskRuntimeSlot,
): AiTaskTerminalRendererLeaseIdentity {
  return {
    token: slot.terminalRendererLeaseToken,
    ownerId: slot.terminalRendererLeaseOwnerId,
    generation: slot.terminalRendererLeaseGeneration,
  }
}

function runtimeWindow(): AiTaskRuntimeWindow {
  return window
}

function legacyFocusedRuntimeWindow(): AiTaskRuntimeWindow | undefined {
  try {
    if (typeof activeWindow === 'undefined') return undefined
    return activeWindow
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
    'beforeUnload' in slot &&
    typeof slot.beforeUnload === 'function' &&
    'rendererUnloadResetTimer' in slot &&
    'rendererTransitionCommitted' in slot &&
    'rendererTransitionEpoch' in slot &&
    'terminalRendererLeaseToken' in slot &&
    'terminalRendererLeaseOwnerId' in slot &&
    'terminalRendererLeaseGeneration' in slot
  )
}

function isPageHideSlot(
  slot: AnyAiTaskRuntimeSlot,
): slot is AiTaskRuntimeSlot | PageHideOnlyAiTaskRuntimeSlot {
  return 'pageHide' in slot && typeof slot.pageHide === 'function'
}

function resolveRuntimeWindow(
  manager: object,
  explicitWindow?: AiTaskRuntimeWindow,
): AiTaskRuntimeWindow {
  return explicitWindow ?? managerRuntimeWindows.get(manager) ?? runtimeWindow()
}

function persistManagerForRendererTransition(manager: AiTaskManager): void {
  const maybeLegacyManager = manager as AiTaskManager & {
    persistSessionStateForRendererReload?: () => void
  }
  if (
    typeof maybeLegacyManager.persistSessionStateForRendererReload ===
    'function'
  ) {
    maybeLegacyManager.persistSessionStateForRendererReload()
    return
  }
  // A live manager retained from the immediately preceding bundle lacks the
  // save-only API. Full preparation is still safer than disposing its broker
  // session during the one-time hot-upgrade boundary.
  manager.prepareForRendererReload()
}

function cancelManagerTerminalShutdownGrace(
  manager: AiTaskManager,
  rendererLease: AiTaskTerminalRendererLeaseIdentity,
): void {
  const maybeLegacyManager = manager as AiTaskManager & {
    cancelTerminalShutdownAfterGrace?: (
      rendererLeaseToken?: string,
      rendererLeaseOwnerId?: string,
      rendererLeaseGeneration?: number,
    ) => void | Promise<void>
  }
  if (
    typeof maybeLegacyManager.cancelTerminalShutdownAfterGrace !== 'function'
  ) {
    return
  }
  try {
    void Promise.resolve(
      // Keep the token captured by the renderer generation that scheduled
      // this callback, even if the manager is adopted while IPC is pending.
      maybeLegacyManager.cancelTerminalShutdownAfterGrace(
        rendererLease.token,
        rendererLease.ownerId,
        rendererLease.generation,
      ),
    ).catch(() => undefined)
  } catch {
    // A manager retained from an older bundle may expose a partial adapter.
    // Its broker TTL remains the safe compatibility fallback.
  }
}

function armManagerTerminalShutdownGrace(
  manager: AiTaskManager,
  rendererLease: AiTaskTerminalRendererLeaseIdentity,
): void {
  const maybeLegacyManager = manager as AiTaskManager & {
    scheduleTerminalShutdownAfterGrace?: (
      graceMs: number,
      rendererLeaseToken?: string,
      rendererLeaseOwnerId?: string,
      rendererLeaseGeneration?: number,
    ) => void | Promise<void>
  }
  if (
    typeof maybeLegacyManager.scheduleTerminalShutdownAfterGrace !== 'function'
  ) {
    return
  }
  try {
    void Promise.resolve(
      maybeLegacyManager.scheduleTerminalShutdownAfterGrace(
        AI_TASK_TERMINAL_SHUTDOWN_GRACE_MS,
        rendererLease.token,
        rendererLease.ownerId,
        rendererLease.generation,
      ),
    ).catch(() => undefined)
  } catch {
    // Older retained brokers use their normal clientless TTL.
  }
}

function activateManagerTerminalRendererLease(
  manager: AiTaskManager,
  rendererLease: AiTaskTerminalRendererLeaseIdentity,
): void {
  const maybeLegacyManager = manager as AiTaskManager & {
    setTerminalRendererLeaseToken?: (
      rendererLeaseToken: string,
      rendererLeaseOwnerId?: string,
      rendererLeaseGeneration?: number,
    ) => void | Promise<void>
  }
  if (
    typeof maybeLegacyManager.setTerminalRendererLeaseToken !== 'function'
  ) {
    return
  }
  try {
    void Promise.resolve(
      maybeLegacyManager.setTerminalRendererLeaseToken(
        rendererLease.token,
        rendererLease.ownerId,
        rendererLease.generation,
      ),
    ).catch(() => undefined)
  } catch {
    // A manager from the previous bundle can lack the new dispatcher hook.
  }
}

function stopManagerNonPersistentRunsForCommittedTransition(
  manager: AiTaskManager,
): void {
  const maybeLegacyManager = manager as AiTaskManager & {
    stopNonPersistentRunsForRendererTransitionAndWait?: () => Promise<void>
  }
  if (
    typeof maybeLegacyManager.stopNonPersistentRunsForRendererTransitionAndWait !==
    'function'
  ) {
    return
  }
  try {
    void Promise.resolve(
      maybeLegacyManager.stopNonPersistentRunsForRendererTransitionAndWait(),
    ).catch(() => undefined)
  } catch {
    // prepareForRendererReload below still performs the synchronous stop pass.
  }
}

function clearSlot(
  win: AiTaskRuntimeWindow,
  slot: AnyAiTaskRuntimeSlot,
): void {
  if (slot.releaseTimer !== null) {
    win.clearTimeout(slot.releaseTimer)
    slot.releaseTimer = null
  }
  if (isCurrentSlot(slot) && slot.rendererUnloadResetTimer !== null) {
    win.clearTimeout(slot.rendererUnloadResetTimer)
    slot.rendererUnloadResetTimer = null
  }
  if (isPageHideSlot(slot)) {
    win.removeEventListener('pagehide', slot.pageHide)
  }
  if (isCurrentSlot(slot) || !isPageHideSlot(slot)) {
    win.removeEventListener('beforeunload', slot.beforeUnload)
  }
  if (win[AI_TASK_RUNTIME_SLOT_KEY] === slot) {
    delete win[AI_TASK_RUNTIME_SLOT_KEY]
  }
  if (managerRuntimeWindows.get(slot.manager) === win) {
    managerRuntimeWindows.delete(slot.manager)
  }
}

function scheduleRendererTransitionReset(
  win: AiTaskRuntimeWindow,
  slot: AiTaskRuntimeSlot,
  transitionEpoch: number,
  delayMs: number,
): void {
  if (slot.rendererUnloadResetTimer !== null) {
    win.clearTimeout(slot.rendererUnloadResetTimer)
  }
  slot.rendererUnloadResetTimer = win.setTimeout(() => {
    slot.rendererUnloadResetTimer = null
    if (
      win[AI_TASK_RUNTIME_SLOT_KEY] !== slot ||
      slot.rendererTransitionEpoch !== transitionEpoch
    ) {
      return
    }
    // workspace `quit` is also emitted for cancelable app-close attempts.
    // If no non-cancelable pagehide followed, return to ordinary hot-reload
    // handoff instead of suppressing disposal for the rest of the renderer.
    // Explicitly cancel the broker deadline: ordinary traffic on this old
    // renderer socket is deliberately NOT allowed to keep a true quit alive.
    slot.rendererUnloading = false
    slot.rendererTransitionCommitted = false
    cancelManagerTerminalShutdownGrace(
      slot.manager,
      terminalRendererLeaseIdentity(slot),
    )
  }, delayMs)
}

function installCurrentSlot(
  win: AiTaskRuntimeWindow,
  app: object,
  manager: AiTaskManager,
  generation = 1,
  rendererLease: AiTaskTerminalRendererLeaseIdentity =
    createAiTaskTerminalRendererLeaseIdentity(),
  rendererLeaseGenerationStore?:
    AiTaskTerminalRendererLeaseGenerationStore,
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
    rendererTransitionCommitted: false,
    rendererTransitionEpoch: 0,
    rendererUnloadResetTimer: null,
    terminalRendererLeaseToken: rendererLease.token,
    terminalRendererLeaseOwnerId: rendererLease.ownerId,
    terminalRendererLeaseGeneration: rendererLease.generation,
    terminalRendererLeaseGenerationStore: rendererLeaseGenerationStore,
    beforeUnload: () => {
      if (slot.releaseTimer !== null) {
        win.clearTimeout(slot.releaseTimer)
        slot.releaseTimer = null
      }
      slot.rendererUnloading = true
      slot.rendererTransitionEpoch += 1
      const transitionEpoch = slot.rendererTransitionEpoch
      persistManagerForRendererTransition(manager)

      // beforeunload is cancelable. Persist synchronously, but never detach
      // the terminal transport until pagehide commits the navigation. If the
      // browser keeps this renderer alive, restore ordinary handoff behavior
      // on the next task without touching the live session.
      scheduleRendererTransitionReset(
        win,
        slot,
        transitionEpoch,
        slot.rendererTransitionCommitted
          ? AI_TASK_RUNTIME_HANDOFF_GRACE_MS
          : 0,
      )
    },
    pageHide: () => {
      // `pagehide` is non-cancelable and fires only once navigation/close is
      // committed. `beforeunload` can be canceled; detaching there would leave
      // the still-visible renderer with no terminal listeners or broker IPC.
      if (slot.releaseTimer !== null) {
        win.clearTimeout(slot.releaseTimer)
        slot.releaseTimer = null
      }
      if (slot.rendererUnloadResetTimer !== null) {
        win.clearTimeout(slot.rendererUnloadResetTimer)
        slot.rendererUnloadResetTimer = null
      }
      slot.rendererUnloading = true
      slot.rendererTransitionCommitted = true
      slot.rendererTransitionEpoch += 1
      // A slow true quit can reach pagehide after the cancelable-workspace
      // transition reset already canceled its first broker deadline. Re-arm
      // at the non-cancelable boundary before detaching the old transport.
      const currentRendererLease = terminalRendererLeaseIdentity(slot)
      armManagerTerminalShutdownGrace(manager, currentRendererLease)
      stopManagerNonPersistentRunsForCommittedTransition(manager)
      manager.prepareForRendererReload()
    },
  }
  win[AI_TASK_RUNTIME_SLOT_KEY] = slot
  managerRuntimeWindows.set(manager, win)
  activateManagerTerminalRendererLease(
    manager,
    terminalRendererLeaseIdentity(slot),
  )
  // This listener is intentionally not plugin-registered: it must remain
  // alive during the brief gap between old unload and new onload.
  win.addEventListener('beforeunload', slot.beforeUnload)
  win.addEventListener('pagehide', slot.pageHide)
  return slot
}

function moveSlotToCurrentSchema(
  sourceWindow: AiTaskRuntimeWindow,
  targetWindow: AiTaskRuntimeWindow,
  slot: AnyAiTaskRuntimeSlot,
  rendererLeaseGenerationStore?:
    AiTaskTerminalRendererLeaseGenerationStore,
): AiTaskRuntimeSlot {
  const generation = 'generation' in slot ? slot.generation : 1
  const rendererLease = isCurrentSlot(slot)
    ? terminalRendererLeaseIdentity(slot)
    : createAiTaskTerminalRendererLeaseIdentity()
  clearSlot(sourceWindow, slot)
  return installCurrentSlot(
    targetWindow,
    slot.app,
    slot.manager,
    generation,
    rendererLease,
    isCurrentSlot(slot)
      ? slot.terminalRendererLeaseGenerationStore ??
          rendererLeaseGenerationStore
      : rendererLeaseGenerationStore,
  )
}

/** Adopt a manager retained by the immediately preceding plugin instance. */
export function acquireRetainedAiTaskManager(
  app: object,
  deps: AiTaskManagerDeps,
  win: AiTaskRuntimeWindow = runtimeWindow(),
  legacyFocusedWindow: AiTaskRuntimeWindow | undefined =
    legacyFocusedRuntimeWindow(),
  rendererLeaseGenerationStore?:
    AiTaskTerminalRendererLeaseGenerationStore,
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
  let currentSlot: AiTaskRuntimeSlot
  if (!isCurrentSlot(slot) || sourceWindow !== win) {
    currentSlot = moveSlotToCurrentSchema(
      sourceWindow,
      win,
      slot,
      rendererLeaseGenerationStore,
    )
    sourceWindow = win
  } else {
    currentSlot = slot
  }
  if (currentSlot.releaseTimer !== null) {
    sourceWindow.clearTimeout(currentSlot.releaseTimer)
    currentSlot.releaseTimer = null
  }
  if (currentSlot.rendererUnloadResetTimer !== null) {
    sourceWindow.clearTimeout(currentSlot.rendererUnloadResetTimer)
    currentSlot.rendererUnloadResetTimer = null
  }
  currentSlot.generation =
    Number.isSafeInteger(currentSlot.generation) && currentSlot.generation >= 0
      ? currentSlot.generation + 1
      : 1
  if (
    currentSlot.rendererUnloading ||
    currentSlot.rendererTransitionCommitted
  ) {
    cancelManagerTerminalShutdownGrace(
      currentSlot.manager,
      terminalRendererLeaseIdentity(currentSlot),
    )
  }
  // Adoption after a same-renderer plugin reload re-arms normal handoff
  // semantics. A canceled beforeunload never reaches pagehide, so it leaves
  // this flag and the live terminal transport untouched.
  currentSlot.rendererUnloading = false
  currentSlot.rendererTransitionCommitted = false
  currentSlot.rendererTransitionEpoch += 1
  if (rendererLeaseGenerationStore) {
    currentSlot.terminalRendererLeaseGenerationStore =
      rendererLeaseGenerationStore
  }
  currentSlot.terminalRendererLeaseToken = createTerminalRendererLeaseToken()
  currentSlot.terminalRendererLeaseGeneration =
    reserveTerminalRendererLeaseGeneration(
      currentSlot.terminalRendererLeaseGenerationStore,
      currentSlot.terminalRendererLeaseGeneration,
    )
  const nextRendererLease = terminalRendererLeaseIdentity(currentSlot)
  managerRuntimeWindows.set(currentSlot.manager, win)
  try {
    // Existing TerminalRunHandle closures retain the prior BrokerClient.
    // Rotate that client first so a later socket reconnect authenticates as
    // the adopted generation rather than being rejected as the old renderer.
    activateManagerTerminalRendererLease(
      currentSlot.manager,
      nextRendererLease,
    )
    currentSlot.manager.rebindRuntimeDependencies(deps)
    activateManagerTerminalRendererLease(
      currentSlot.manager,
      nextRendererLease,
    )
    return currentSlot.manager
  } catch {
    clearSlot(win, currentSlot)
    currentSlot.manager.dispose()
    return undefined
  }
}

/** Publish a newly created manager as the renderer's one live AI runtime. */
export function retainAiTaskManager(
  app: object,
  manager: AiTaskManager,
  win: AiTaskRuntimeWindow = runtimeWindow(),
  rendererLease: AiTaskTerminalRendererLeaseIdentity =
    createAiTaskTerminalRendererLeaseIdentity(),
  rendererLeaseGenerationStore?:
    AiTaskTerminalRendererLeaseGenerationStore,
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

  installCurrentSlot(
    win,
    app,
    manager,
    1,
    rendererLease,
    rendererLeaseGenerationStore,
  )
}

/**
 * `workspace.quit` is emitted before DOM lifecycle for both true app exit
 * and Obsidian's Page.reload. Fence plugin onunload immediately and persist
 * the broker identity, while leaving the live transport/process untouched.
 */
export function prepareRetainedAiTaskManagerForRendererTransition(
  manager: AiTaskManager,
  win?: AiTaskRuntimeWindow,
): boolean {
  const targetWindow = resolveRuntimeWindow(manager, win)
  const slot = targetWindow[AI_TASK_RUNTIME_SLOT_KEY]
  if (!slot || slot.manager !== manager || manager.isDisposed()) return false
  const currentSlot = isCurrentSlot(slot)
    ? slot
    : moveSlotToCurrentSchema(targetWindow, targetWindow, slot)
  if (currentSlot.releaseTimer !== null) {
    targetWindow.clearTimeout(currentSlot.releaseTimer)
    currentSlot.releaseTimer = null
  }
  if (currentSlot.rendererUnloadResetTimer !== null) {
    targetWindow.clearTimeout(currentSlot.rendererUnloadResetTimer)
    currentSlot.rendererUnloadResetTimer = null
  }
  currentSlot.rendererUnloading = true
  currentSlot.rendererTransitionCommitted = true
  currentSlot.rendererTransitionEpoch += 1
  scheduleRendererTransitionReset(
    targetWindow,
    currentSlot,
    currentSlot.rendererTransitionEpoch,
    AI_TASK_RUNTIME_HANDOFF_GRACE_MS,
  )
  persistManagerForRendererTransition(manager)
  return true
}

export function getAiTaskRuntimeTerminalLeaseToken(
  manager: AiTaskManager,
  win?: AiTaskRuntimeWindow,
): string | undefined {
  return getAiTaskRuntimeTerminalLeaseIdentity(manager, win)?.token
}

export function getAiTaskRuntimeTerminalLeaseIdentity(
  manager: AiTaskManager,
  win?: AiTaskRuntimeWindow,
): AiTaskTerminalRendererLeaseIdentity | undefined {
  const targetWindow = resolveRuntimeWindow(manager, win)
  const slot = targetWindow[AI_TASK_RUNTIME_SLOT_KEY]
  if (!slot || slot.manager !== manager || !isCurrentSlot(slot)) {
    return undefined
  }
  return terminalRendererLeaseIdentity(slot)
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
  const storedSlot = targetWindow[AI_TASK_RUNTIME_SLOT_KEY]
  if (
    !storedSlot ||
    storedSlot.manager !== manager ||
    manager.isDisposed()
  ) {
    manager.dispose()
    return
  }
  // A caller from the new bundle can race acquisition during a hot update.
  // Migrate in place before consulting generation/pagehide state. Bind the
  // result to its own const: reassigning the union-typed variable would widen
  // it back (every legacy shape is a structural subset of the current one),
  // and a `let` also loses its narrowing inside the timer callback below.
  const slot: AiTaskRuntimeSlot = isCurrentSlot(storedSlot)
    ? storedSlot
    : moveSlotToCurrentSchema(targetWindow, targetWindow, storedSlot)
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
