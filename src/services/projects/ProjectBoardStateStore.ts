import { normalizePath } from 'obsidian'

import type { TaskChutePluginLike } from '../../types'
import { ProjectBoardState, ProjectBoardStatus } from '../../types'

const STATE_FILE_NAME = 'projectBoardState.json'

export function createDefaultProjectBoardState(): ProjectBoardState {
  return {
    hiddenStatuses: [],
    updatedAt: new Date().toISOString(),
  }
}

function normalizeState(state: unknown): ProjectBoardState {
  if (!state || typeof state !== 'object') {
    return createDefaultProjectBoardState()
  }

  const record = state as Record<string, unknown>
  const hiddenCandidates = Array.isArray(record.hiddenStatuses)
    ? (record.hiddenStatuses as unknown[])
    : []

  const hiddenStatuses: ProjectBoardStatus[] = []
  hiddenCandidates.forEach((value) => {
    if (value === 'todo' || value === 'in-progress' || value === 'done') {
      if (!hiddenStatuses.includes(value)) hiddenStatuses.push(value)
    }
  })

  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt.trim().length > 0
    ? record.updatedAt
    : new Date().toISOString()

  return {
    hiddenStatuses,
    updatedAt,
  }
}

export class ProjectBoardStateStore {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  private getConfigDir(): string {
    const configDir = (this.plugin.app.vault.configDir ?? '').trim()
    const manifestDir = this.plugin.manifest?.dir?.trim()
    if (manifestDir && manifestDir.includes('/')) {
      if (manifestDir.startsWith(configDir)) {
        return normalizePath(manifestDir)
      }
      const segments = [] as string[]
      if (configDir.length > 0) segments.push(configDir)
      segments.push(manifestDir.replace(/^\/+/, ''))
      return normalizePath(segments.join('/'))
    }

    const folderName = manifestDir && manifestDir.length > 0
      ? manifestDir
      : this.plugin.manifest?.id ?? 'taskchute-plus'
    const segments = [] as string[]
    if (configDir.length > 0) segments.push(configDir)
    segments.push('plugins', folderName)
    return normalizePath(segments.join('/'))
  }

  private getDataDir(): string {
    return normalizePath(`${this.getConfigDir()}/data`)
  }

  private getStatePath(): string {
    return normalizePath(`${this.getDataDir()}/${STATE_FILE_NAME}`)
  }

  async load(): Promise<ProjectBoardState> {
    const adapter = this.plugin.app.vault.adapter
    const path = this.getStatePath()
    try {
      if (!(await adapter.exists(path))) {
        return createDefaultProjectBoardState()
      }
      const raw = await adapter.read(path)
      if (!raw) {
        return createDefaultProjectBoardState()
      }
      const parsed = JSON.parse(raw) as unknown
      return normalizeState(parsed)
    } catch (error) {
      console.warn('[ProjectBoardStateStore] Failed to load state:', error)
      return createDefaultProjectBoardState()
    }
  }

  async save(state: ProjectBoardState): Promise<void> {
    const adapter = this.plugin.app.vault.adapter
    const dir = this.getDataDir()
    const path = this.getStatePath()
    try {
      if (!(await adapter.exists(dir))) {
        await adapter.mkdir(dir)
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('Folder already exists'))) {
        throw error
      }
    }

    const next: ProjectBoardState = {
      hiddenStatuses: [...new Set(state.hiddenStatuses.filter((status): status is ProjectBoardStatus =>
        status === 'todo' || status === 'in-progress' || status === 'done',
      ))],
      updatedAt: state.updatedAt || new Date().toISOString(),
    }

    await adapter.write(path, JSON.stringify(next, null, 2))
  }
}
