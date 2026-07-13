import type { Plugin } from 'obsidian'
import type { AiTaskManager } from './services/AiTaskManager'

type AiTaskProcessCleanupHost = Pick<
  Plugin,
  'app' | 'registerDomEvent' | 'registerEvent'
> & {
  aiTaskManager?: Pick<AiTaskManager, 'dispose' | 'disposeAndWait'>
  aiTaskManagersPendingDisposal?: Set<
    Pick<AiTaskManager, 'dispose' | 'disposeAndWait'>
  >
}

type DisposableAiTaskManager = Pick<AiTaskManager, 'dispose' | 'disposeAndWait'>

/**
 * Start disposing a manager removed by the settings toggle, but keep it
 * discoverable by the app-quit hook until its force-kill phase completes.
 */
export function disposeAiTaskManagerTracked(
  host: Pick<AiTaskProcessCleanupHost, 'aiTaskManagersPendingDisposal'>,
  manager: DisposableAiTaskManager,
): void {
  const pending = host.aiTaskManagersPendingDisposal
  pending?.add(manager)
  const completion = manager.disposeAndWait()
  void completion.then(
    () => pending?.delete(manager),
    () => pending?.delete(manager),
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
 * quitting. Register a renderer beforeunload guard as a second synchronous
 * stop path so detached PTY process groups cannot be orphaned with PPID 1.
 *
 * Managers are resolved when the event fires because the settings toggle can
 * replace them after startup. Managers already removed by an OFF toggle stay
 * tracked until their force-kill phase completes. AiTaskManager.dispose is
 * idempotent, so running quit, beforeunload, and onunload paths is safe.
 */
export function registerAiTaskAppShutdownCleanup(
  host: AiTaskProcessCleanupHost,
  win: Window = activeWindow,
): void {
  host.registerEvent(
    host.app.workspace.on('quit', (tasks) => {
      for (const manager of collectManagers(host)) {
        tasks.addPromise(manager.disposeAndWait())
      }
    }),
  )
  host.registerDomEvent(win, 'beforeunload', () => {
    for (const manager of collectManagers(host)) manager.dispose()
  })
}
