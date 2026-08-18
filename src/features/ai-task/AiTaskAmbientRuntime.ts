import type { TaskChutePluginLike } from '../../types'
import type { TaskChuteViewController } from '../../app/taskchute/TaskChuteViewController'
import {
  findAiTaskAmbientCandidates,
  type AiTaskAmbientCandidate,
} from './services/AiTaskAmbientCandidateFinder'
import { AiTaskAmbientScheduler } from './services/AiTaskAmbientScheduler'
import { AiTaskAmbientScheduleStateStore } from './services/AiTaskAmbientScheduleStateStore'

type LocalStorageApp = {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
}

/**
 * Wire the plugin-owned scheduler to vault discovery and the existing
 * TaskChuteView execution pipeline. Keeping this composition outside main.ts
 * leaves the plugin entry point responsible only for lifecycle start/stop.
 */
export function createAiTaskAmbientScheduler(
  plugin: TaskChutePluginLike,
  viewController: TaskChuteViewController,
): AiTaskAmbientScheduler {
  const appStorage = plugin.app as unknown as LocalStorageApp
  const stateStore = new AiTaskAmbientScheduleStateStore({
    loadLocalStorage: (key) => appStorage.loadLocalStorage?.(key),
    saveLocalStorage: (key, value) => {
      appStorage.saveLocalStorage?.(key, value)
    },
  })

  return new AiTaskAmbientScheduler({
    stateStore,
    findCandidates: (now) => {
      if (
        plugin.settings.aiTaskEnabled !== true ||
        !plugin.aiTaskManager
      ) {
        return []
      }
      return findAiTaskAmbientCandidates(
        plugin.app,
        plugin.pathManager.getTaskFolderPath(),
        now,
      )
    },
    executeCandidates: async (candidates, now) => {
      if (!plugin.aiTaskManager || candidates.length === 0) {
        return []
      }
      const session = await viewController.createBackgroundView([
        'runDueAmbientAiTasks',
      ])
      if (!session || !plugin.aiTaskManager) {
        session?.close()
        return []
      }

      try {
        const result = await session.view.runDueAmbientAiTasks(
          candidates.map((candidate) => candidate.path),
          now,
        )
        const satisfiedPaths = new Set(result.satisfiedPaths)

        // All finder candidates currently belong to local "today", but group
        // by date key defensively so this composition remains correct if a
        // future catch-up finder returns more than one day.
        const dateKeyByPath = new Map(
          candidates.map((candidate) => [candidate.path, candidate.dateKey]),
        )
        const startedRunsByDate = new Map<
          string,
          typeof result.startedRuns
        >()
        for (const startedRun of result.startedRuns) {
          const dateKey = dateKeyByPath.get(startedRun.path)
          if (!dateKey) continue
          const runs = startedRunsByDate.get(dateKey) ?? []
          runs.push(startedRun)
          startedRunsByDate.set(dateKey, runs)
        }
        for (const [dateKey, startedRuns] of startedRunsByDate) {
          viewController.syncAmbientAiTaskRuns(
            session.view,
            startedRuns,
            dateKey,
          )
        }

        return candidates
          .filter((candidate) => satisfiedPaths.has(candidate.path))
          .map((candidate: AiTaskAmbientCandidate) => candidate.identity)
      } finally {
        session.close()
      }
    },
    focusTarget:
      typeof activeWindow === 'undefined' ? undefined : activeWindow,
    visibilityTarget:
      typeof activeDocument === 'undefined' ? undefined : activeDocument,
    isDocumentVisible: () =>
      typeof activeDocument === 'undefined' ||
      activeDocument.visibilityState !== 'hidden',
    log: (level, ...args) => plugin._log?.(level, ...args),
  })
}
