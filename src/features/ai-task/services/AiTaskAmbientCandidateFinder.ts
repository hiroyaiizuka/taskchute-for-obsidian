import type { App } from 'obsidian'

import { RoutineService } from '../../routine/services/RoutineService'
import { extractTaskIdFromFrontmatter } from '../../../services/TaskIdManager'
import { getScheduledTime } from '../../../utils/fieldMigration'
import { listFilesInFolder } from '../../../utils/vaultFiles'
import { normalizeReminderTime } from '../../reminder/services/ReminderFrontmatterService'
import { readAiTaskConfig } from './AiTaskFrontmatterReader'
import { readObsidianTaskLinkConfig } from './ObsidianTaskLinkConfig'
import {
  formatAiTaskAmbientDateKey,
  resolveAiTaskAmbientIdentity,
} from './AiTaskAmbientScheduleStateStore'

export interface AiTaskAmbientCandidate {
  identity: string
  path: string
  dateKey: string
  scheduledTime: string
  taskId?: string
}

export type AiTaskAmbientCandidateApp = Pick<App, 'vault' | 'metadataCache'>

function resolveMovedTargetDate(frontmatter: Record<string, unknown>): string | undefined {
  const targetDate = frontmatter['target_date']
  if (typeof targetDate !== 'string') return undefined
  const trimmed = targetDate.trim()
  if (!trimmed || trimmed === frontmatter['routine_start']) return undefined
  return trimmed
}

/**
 * Scan only the configured TaskChute task folder for due Ambient AI routines.
 * The metadata cache is sufficient; task notes are never read or modified.
 */
export function findAiTaskAmbientCandidates(
  app: AiTaskAmbientCandidateApp,
  taskFolderPath: string,
  now: Date,
): AiTaskAmbientCandidate[] {
  if (!Number.isFinite(now.getTime())) return []

  const dateKey = formatAiTaskAmbientDateKey(now)
  const currentMinute = now.getHours() * 60 + now.getMinutes()
  const files = listFilesInFolder(app, taskFolderPath, {
    markdownOnly: true,
  })
  const seen = new Set<string>()
  const candidates: AiTaskAmbientCandidate[] = []

  for (const file of files) {
    try {
      const cached = app.metadataCache.getFileCache(file)
      const rawFrontmatter = cached?.frontmatter
      if (!rawFrontmatter || typeof rawFrontmatter !== 'object') continue
      const frontmatter = rawFrontmatter as Record<string, unknown>

      if (!readAiTaskConfig(frontmatter)) continue
      if (readObsidianTaskLinkConfig(frontmatter)) continue

      const rule = RoutineService.parseFrontmatter(frontmatter)
      if (!RoutineService.isDue(dateKey, rule, resolveMovedTargetDate(frontmatter))) {
        continue
      }

      const scheduledTime = normalizeReminderTime(
        getScheduledTime(frontmatter),
      )
      if (!scheduledTime) continue
      const [hour, minute] = scheduledTime.split(':').map(Number)
      const scheduledMinute = hour * 60 + minute
      if (scheduledMinute > currentMinute) continue

      const taskId = extractTaskIdFromFrontmatter(frontmatter)
      const identity = resolveAiTaskAmbientIdentity({ taskId, path: file.path })
      if (!identity || seen.has(identity)) continue
      seen.add(identity)

      candidates.push({
        identity,
        path: file.path,
        dateKey,
        scheduledTime,
        ...(taskId ? { taskId } : {}),
      })
    } catch {
      // One malformed cache entry must not block other scheduled tasks.
    }
  }

  return candidates
}

export class AiTaskAmbientCandidateFinder {
  find(
    app: AiTaskAmbientCandidateApp,
    taskFolderPath: string,
    now: Date,
  ): AiTaskAmbientCandidate[] {
    return findAiTaskAmbientCandidates(app, taskFolderPath, now)
  }
}
