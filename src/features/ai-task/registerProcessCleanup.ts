import type { Plugin } from 'obsidian'
import type { AiTaskManager } from './services/AiTaskManager'
import { forgetRetainedAiTaskManager } from './services/AiTaskRuntimeLease'

type AiTaskProcessCleanupHost = Pick<
  Plugin,
  'app' | 'registerEvent'
> & {
  aiTaskManager?: Pick<
    AiTaskManager,
    'dispose' | 'disposeAndWait'
  >
  aiTaskManagersPendingDisposal?: Set<
    Pick<AiTaskManager, 'dispose' | 'disposeAndWait'>
  >
}

type DisposableAiTaskManager = Pick<AiTaskManager, 'dispose' | 'disposeAndWait'>

const AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY =
  '__taskchutePlusAiTaskPendingDisposalRegistryV1__'

interface PendingDisposalRegistryRoot {
  [AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY]?: WeakMap<
    object,
    Set<AiTaskManager>
  >
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
  let registry = registryRoot[AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY]
  if (!registry) {
    registry = new WeakMap<object, Set<AiTaskManager>>()
    registryRoot[AI_TASK_PENDING_DISPOSAL_REGISTRY_KEY] = registry
  }
  let pending = registry.get(app)
  if (!pending) {
    pending = new Set<AiTaskManager>()
    registry.set(app, pending)
  }
  return pending
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

function collectManagers(host: AiTaskProcessCleanupHost): Set<DisposableAiTaskManager> {
  const managers = new Set<DisposableAiTaskManager>(
    host.aiTaskManagersPendingDisposal ?? [],
  )
  if (host.aiTaskManager) managers.add(host.aiTaskManager)
  return managers
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
      for (const manager of collectManagers(host)) {
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
    }),
  )
}
