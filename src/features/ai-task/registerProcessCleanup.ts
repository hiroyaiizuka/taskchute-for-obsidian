import { Platform, type Plugin } from 'obsidian'
import type { AiTaskManager } from './services/AiTaskManager'
import {
  AI_TASK_TERMINAL_SHUTDOWN_GRACE_MS,
  fenceLegacyManager,
  forgetRetainedAiTaskManager,
  retireLegacyRetainedAiTaskManager,
  speaksCurrentBrokerProtocol,
  getAiTaskRuntimeTerminalLeaseIdentity,
  prepareRetainedAiTaskManagerForRendererTransition,
} from './services/AiTaskRuntimeLease'

export const AI_TASK_APP_RESTART_GRACE_MS =
  AI_TASK_TERMINAL_SHUTDOWN_GRACE_MS

type AiTaskProcessCleanupHost = Pick<
  Plugin,
  'app' | 'registerEvent'
> & {
  aiTaskManager?: Pick<
    AiTaskManager,
    | 'dispose'
    | 'disposeAndWait'
    | 'isDisposed'
    | 'persistSessionStateForRendererReload'
    | 'prepareForRendererReload'
  > &
    Partial<
      Pick<
        AiTaskManager,
        | 'scheduleTerminalShutdownAfterGrace'
        | 'stopNonPersistentRunsForRendererTransitionAndWait'
      >
    >
  aiTaskManagersPendingDisposal?: Set<
    Pick<AiTaskManager, 'dispose' | 'disposeAndWait'>
  >
}

type DisposableAiTaskManager = Pick<AiTaskManager, 'dispose' | 'disposeAndWait'>

const AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY =
  '__taskchutePlusAiTaskPendingDisposalRegistryV1__'
/** Set on a registry this release (or a later one) created. */
const REGISTRY_PROOF_MARK = '__taskchutePlusBrokerProofProtocol__'
/** Set once a release before LEV-391 has used the registry. */
const REGISTRY_LEGACY_MARK = '__taskchutePlusLegacyReleaseRan__'

type PendingDisposalRegistry = WeakMap<object, Set<AiTaskManager>> & {
  [REGISTRY_PROOF_MARK]?: true
  [REGISTRY_LEGACY_MARK]?: true
}

interface PendingDisposalRegistryRoot {
  [AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY]?: PendingDisposalRegistry
}

function registryGet(
  registry: WeakMap<object, Set<AiTaskManager>>,
  app: object,
): Set<AiTaskManager> | undefined {
  return WeakMap.prototype.get.call(registry, app) as Set<AiTaskManager> | undefined
}

function registrySet(
  registry: WeakMap<object, Set<AiTaskManager>>,
  app: object,
  pending: Set<AiTaskManager>,
): void {
  WeakMap.prototype.set.call(registry, app, pending)
}

/**
 * Every release with a terminal broker (2.1.0 to 3.0.1) builds or reads this
 * registry when its plugin is constructed, through the registry's own
 * methods. This release reads it through WeakMap.prototype instead, and gives
 * the registry it creates methods that record any other caller. So the
 * registry tells whether a release before LEV-391 ever ran in this renderer,
 * even after its runtime has left every registry and slot (LEV-391).
 */
function createPendingDisposalRegistry(): PendingDisposalRegistry {
  const registry: PendingDisposalRegistry = new WeakMap()
  for (const name of ['get', 'set', 'has', 'delete'] as const) {
    const method = Reflect.get(WeakMap.prototype, name) as (...args: unknown[]) => unknown
    Object.defineProperty(registry, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        registry[REGISTRY_LEGACY_MARK] = true
        return method.apply(registry, args)
      },
    })
  }
  Object.defineProperty(registry, REGISTRY_PROOF_MARK, { value: true })
  return registry
}

/**
 * Settings-OFF disposal may outlive the Plugin instance that initiated it.
 * Keep the retry set on the renderer, keyed by Obsidian App identity, so a
 * same-renderer hot reload and its newly registered quit hook can still
 * finish an unconfirmed broker shutdown.
 */
export function getSharedAiTaskManagersPendingDisposal(
  app: object,
  root: object = window,
): Set<AiTaskManager> {
  const registryRoot = root as PendingDisposalRegistryRoot
  const found = registryRoot[AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY]
  let registry = found
  if (!registry || registry[REGISTRY_PROOF_MARK] !== true) {
    // None yet, or one a release before LEV-391 built: move this app's set
    // into a registry of our own, remembering who built the old one.
    registry = createPendingDisposalRegistry()
    if (found) {
      registry[REGISTRY_LEGACY_MARK] = true
      const inherited = registryGet(found, app)
      if (inherited) registrySet(registry, app, inherited)
    }
    registryRoot[AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY] = registry
  }
  let pending = registryGet(registry, app)
  if (!pending) {
    pending = new Set<AiTaskManager>()
    registrySet(registry, app, pending)
  }
  if (retireLegacyPendingDisposals(pending) > 0) reloadRendererOnce(app)
  return pending
}

/** Whether a release before LEV-391 ran in this renderer (see above). */
function legacyReleaseRanHere(root: object): boolean {
  const registry = (root as PendingDisposalRegistryRoot)[
    AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY
  ]
  if (!registry) return false
  return registry[REGISTRY_PROOF_MARK] !== true || registry[REGISTRY_LEGACY_MARK] === true
}

/**
 * On every plugin start, whether or not AI tasks can start: let go of a
 * runtime a release before LEV-391 retained across this update, and reload
 * the window once to end its unreachable clients too.
 *
 * A runtime can also have left every registry and slot and still keep
 * clients alive: one whose handoff expired while its plugin was off, for
 * example, after a hot reload had given its terminal handles their own
 * client. Nothing reaches those, so the window is reloaded whenever a release
 * before LEV-391 ran in it at all. Only the desktop app runs a broker.
 */
export function retirePreviousReleaseAiTaskRuntime(
  app: object,
  root: object = window,
): void {
  const retired = retireLegacyRetainedAiTaskManager(app)
  if (retired || (Platform.isDesktop && legacyReleaseRanHere(root))) {
    reloadRendererOnce(app)
  }
}

const reloadRequested = new WeakSet<object>()

/**
 * Reload the window to end a release before LEV-391 for good. Terminal
 * handles from an earlier hot reload keep broker clients that cannot be
 * reached and fenced from here; a reload ends them all, and broker sessions
 * are restored by the next renderer as on any reload. Deferred so the plugin
 * that asks finishes loading first. Asked at most once per app.
 */
export function reloadRendererOnce(app: object): void {
  if (reloadRequested.has(app)) return
  reloadRequested.add(app)
  const commands = (app as { commands?: { executeCommandById?(id: string): unknown } }).commands
  window.setTimeout(() => {
    commands?.executeCommandById?.('app:reload')
  }, 0)
}

/**
 * A release before LEV-391 can leave a manager here whose settings-OFF
 * shutdown failed. Retrying it runs that release's code, which sends the
 * broker token without asking the broker to prove itself. So it is dropped
 * and fenced instead, without calling anything that talks to the broker, and
 * the window is reloaded once (see reloadRendererOnce), even while AI tasks
 * stay off. Its broker, left with no clients, stops itself and its sessions
 * after its idle TTL.
 */
function retireLegacyPendingDisposals(pending: Set<AiTaskManager>): number {
  let retired = 0
  for (const manager of Array.from(pending)) {
    if (speaksCurrentBrokerProtocol(manager)) continue
    pending.delete(manager)
    fenceLegacyManager(manager)
    retired += 1
  }
  return retired
}

/**
 * Start disposing a manager removed by the settings toggle, but keep it
 * discoverable by the app-quit hook until its force-kill phase completes.
 */
export function disposeAiTaskManagerTracked(
  host: Pick<AiTaskProcessCleanupHost, 'aiTaskManagersPendingDisposal'>,
  manager: DisposableAiTaskManager,
): void {
  forgetRetainedAiTaskManager(manager)
  const pending = host.aiTaskManagersPendingDisposal
  pending?.add(manager)
  const completion = manager.disposeAndWait()
  void completion.then(
    () => pending?.delete(manager),
    () => {
      // Keep an unconfirmed broker shutdown discoverable. A later workspace
      // quit retries disposeAndWait(); dropping it here would lose the only
      // reference while a broker-owned CLI may still be alive.
    },
  )
}

/**
 * Obsidian does not reliably call Plugin.onunload while the desktop app is
 * quitting. App quit awaits full broker shutdown; renderer replacement only
 * detaches IPC so broker-owned PTYs remain available to the next renderer.
 *
 * Managers are resolved when the event fires because the settings toggle can
 * replace them after startup. Managers already removed by an OFF toggle stay
 * tracked until their force-kill phase completes. AiTaskManager.dispose is
 * idempotent, so running quit and onunload paths is safe.
 *
 * Renderer page lifecycle deliberately belongs to AiTaskRuntimeLease alone.
 * Registering a second pagehide listener here used Obsidian's focus-sensitive
 * activeWindow in the past: closing a popout could detach the main terminal,
 * and a normal reload called prepareForRendererReload twice.
 */
export function registerAiTaskAppShutdownCleanup(
  host: AiTaskProcessCleanupHost,
): void {
  host.registerEvent(
    host.app.workspace.on('quit', (tasks) => {
      // Managers already removed by settings OFF are unambiguously shutting
      // down and must keep their force-kill completion attached to app quit.
      for (const manager of host.aiTaskManagersPendingDisposal ?? []) {
        const completion = manager.disposeAndWait()
        tasks.addPromise(completion)
        void completion.then(
          () => host.aiTaskManagersPendingDisposal?.delete(manager),
          () => {
            // Keep it discoverable if the app cancels quit and another retry
            // becomes possible.
          },
        )
      }

      const activeManager = host.aiTaskManager
      if (!activeManager) return
      const retained =
        prepareRetainedAiTaskManagerForRendererTransition(
          activeManager as AiTaskManager,
        )
      if (!retained) {
        const completion = activeManager.disposeAndWait()
        tasks.addPromise(completion)
        return
      }

      // Obsidian's app:reload and a true application exit emit the same
      // workspace quit event. The broker owns this short deadline: a new
      // renderer connection cancels it, while a genuine exit has no
      // reconnect and is cleaned up after the grace window.
      // Do not stop renderer-owned/headless runs at this ambiguous boundary:
      // workspace quit is also emitted for a cancelable app-close attempt.
      // The non-cancelable pagehide path performs their bounded stop, while
      // NodeProcessGateway's renderer-exit reaper covers a missing pagehide.
      if (
        typeof activeManager.scheduleTerminalShutdownAfterGrace === 'function'
      ) {
        const rendererLease =
          getAiTaskRuntimeTerminalLeaseIdentity(
            activeManager as AiTaskManager,
          )
        tasks.addPromise(
          activeManager.scheduleTerminalShutdownAfterGrace(
            AI_TASK_APP_RESTART_GRACE_MS,
            rendererLease?.token,
            rendererLease?.ownerId,
            rendererLease?.generation,
          ),
        )
      }
    }),
  )
}
