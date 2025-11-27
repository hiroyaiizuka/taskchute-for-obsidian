import { TFile } from 'obsidian'
import type { TaskChutePluginLike } from '../types'

export const TASK_ID_FRONTMATTER_KEY = 'taskId'
const LEGACY_TASK_ID_KEYS = ['taskchuteId'] as const

function readTaskIdValue(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const raw = frontmatter[key]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function syncTaskIdFrontmatter(frontmatter: Record<string, unknown>, taskId: string): void {
  frontmatter[TASK_ID_FRONTMATTER_KEY] = taskId
  for (const legacyKey of LEGACY_TASK_ID_KEYS) {
    // Remove legacy keys (always different from current key by design)
    delete frontmatter[legacyKey]
  }
}

export function extractTaskIdFromFrontmatter(frontmatter?: Record<string, unknown>): string | undefined {
  if (!frontmatter) return undefined
  const primary = readTaskIdValue(frontmatter, TASK_ID_FRONTMATTER_KEY)
  if (primary) {
    return primary
  }
  for (const legacyKey of LEGACY_TASK_ID_KEYS) {
    const legacy = readTaskIdValue(frontmatter, legacyKey)
    if (legacy) {
      return legacy
    }
  }
  return undefined
}

export function generateTaskId(): string {
  try {
    const cryptoApi = globalThis.crypto as Crypto | undefined
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return `tc-task-${cryptoApi.randomUUID()}`
    }
  } catch (error) {
    console.warn('[TaskIdManager] randomUUID unavailable, falling back', error)
  }
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `tc-task-${timestamp}-${random}`
}

export class TaskIdManager {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  async ensureAllTaskIds(): Promise<void> {
    try {
      const folderPath = this.plugin.pathManager.getTaskFolderPath?.()
      if (!folderPath) return
      const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`
      const files = this.plugin.app.vault.getMarkdownFiles?.() ?? []
      for (const file of files) {
        if (!file.path.startsWith(prefix)) continue
        try {
          await this.ensureTaskIdForFile(file)
        } catch (error) {
          this.plugin._log?.('warn', '[TaskIdManager] Failed to assign taskId', file.path, error)
        }
      }
    } catch (error) {
      this.plugin._log?.('warn', '[TaskIdManager] Failed to ensure task IDs', error)
    }
  }

  async ensureTaskIdForFile(file: TFile): Promise<string | null> {
    const cached = this.plugin.app.metadataCache.getFileCache(file)
    const existing = extractTaskIdFromFrontmatter(cached?.frontmatter as Record<string, unknown> | undefined)
    if (existing) {
      if (cached?.frontmatter && cached.frontmatter[TASK_ID_FRONTMATTER_KEY] !== existing) {
        await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
          syncTaskIdFrontmatter(frontmatter as Record<string, unknown>, existing)
        })
      }
      return existing
    }

    let assigned: string | null = null
    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const current = extractTaskIdFromFrontmatter(frontmatter as Record<string, unknown>)
      if (current) {
        syncTaskIdFrontmatter(frontmatter as Record<string, unknown>, current)
        assigned = current
        return
      }
      const nextId = generateTaskId()
      syncTaskIdFrontmatter(frontmatter as Record<string, unknown>, nextId)
      assigned = nextId
    })
    return assigned
  }
}
