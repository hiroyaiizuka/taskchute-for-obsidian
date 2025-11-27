import { normalizePath, TFile } from 'obsidian'

import type { TaskChutePluginLike } from '../../types'
import {
  ProjectBoardItem,
  ProjectBoardStatus,
  ProjectFolderUnsetError,
} from '../../types'
import { ensureFrontmatterObject } from '../../utils/frontmatter'

const DEFAULT_STATUS: ProjectBoardStatus = 'todo'

const DATE_SEP = '-'

function formatDate(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${DATE_SEP}${month}${DATE_SEP}${day}`
}

function sanitizeFileTitle(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/\p{C}+/gu, '')
    .replace(/[\\/:|<>?*"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
}

function normalizeStatus(value: unknown): ProjectBoardStatus {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'done' || normalized === 'completed') return 'done'
    if (normalized === 'in-progress' || normalized === 'in_progress' || normalized === 'in progress') {
      return 'in-progress'
    }
    if (normalized === 'todo' || normalized === 'to-do' || normalized === 'not started') {
      return 'todo'
    }
  }
  return DEFAULT_STATUS
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  return undefined
}

export interface ProjectFrontmatterSnapshot {
  status: ProjectBoardStatus
  order: number | null
  created?: string
  updated?: string
  completed?: string
  notes?: string
}

export class ProjectBoardService {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  getProjectFolderOrThrow(): string {
    const folder = this.plugin.pathManager.getProjectFolderPath()
    if (!folder || folder.trim().length === 0) {
      throw new ProjectFolderUnsetError()
    }
    return normalizePath(folder)
  }

  listProjectFiles(): TFile[] {
    const folder = this.getProjectFolderOrThrow()
    const files = this.plugin.app.vault.getMarkdownFiles()
    const prefix = folder.endsWith('/') ? folder : `${folder}/`
    return files.filter((file) => file.path === folder || file.path.startsWith(prefix))
  }

  loadProjectItems(): ProjectBoardItem[] {
    const files = this.listProjectFiles()
    return files.map((file) => this.toBoardItem(file))
  }

  async createProject(input: {
    title: string
    status: ProjectBoardStatus
  }): Promise<ProjectBoardItem> {
    const folder = this.getProjectFolderOrThrow()
    await this.plugin.pathManager.ensureFolderExists(folder)

    const today = formatDate(new Date())
    const rawTitle = input.title.trim()
    const prefixSetting = this.plugin.settings.projectTitlePrefix ?? ''
    const hasPrefix = prefixSetting.length > 0
    const prefixedTitle =
      hasPrefix && !rawTitle.startsWith(prefixSetting)
        ? `${prefixSetting}${rawTitle}`
        : rawTitle
    const displayTitle =
      hasPrefix && prefixedTitle.startsWith(prefixSetting)
        ? prefixedTitle.slice(prefixSetting.length).trimStart()
        : prefixedTitle

    const sanitizedBase = sanitizeFileTitle(prefixedTitle || rawTitle || 'project') || 'project'
    let fileBase = sanitizedBase
    let attempt = 0
    const adapter = this.plugin.app.vault.adapter
    while (await adapter.exists(normalizePath(`${folder}/${fileBase}.md`))) {
      attempt += 1
      fileBase = sanitizeFileTitle(`${sanitizedBase} ${attempt}`) || `${sanitizedBase} ${attempt}`
    }

    const filePath = normalizePath(`${folder}/${fileBase}.md`)
    const templatePath = this.plugin.settings.projectTemplatePath?.trim()
    const normalizedTemplate = templatePath ? normalizePath(templatePath) : null
    const templateFile = normalizedTemplate
      ? this.plugin.app.vault.getAbstractFileByPath(normalizedTemplate)
      : null

    let initialContent: string
    if (templateFile instanceof TFile) {
      try {
        initialContent = await this.plugin.app.vault.cachedRead(templateFile)
      } catch (error) {
        console.warn('[ProjectBoard] Failed to read project template', error)
        initialContent = ''
      }
    } else {
      const frontmatterLines: string[] = [
        '---',
        `status: ${input.status}`,
      ]
      frontmatterLines.push(`start: ${today}`)
      frontmatterLines.push('---', '')
      initialContent = frontmatterLines.join('\n')
    }

    const file = await this.plugin.app.vault.create(filePath, initialContent)

    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      delete frontmatter.title
      frontmatter.status = input.status
      delete frontmatter.priority
      if (frontmatter.order !== undefined) {
        delete frontmatter.order
      }
      frontmatter.start = today
      delete frontmatter.completed
      delete frontmatter.created
      delete frontmatter.updated
      return frontmatter
    })

    const snapshot: ProjectFrontmatterSnapshot = {
      status: input.status,
      order: null,
    }

    return {
      file,
      path: file.path,
      basename: file.basename,
      title: prefixedTitle,
      displayTitle,
      status: input.status,
      order: null,
      created: snapshot.created,
      updated: snapshot.updated,
      completed: undefined,
      notes: snapshot.notes,
      frontmatter: Object.assign(
        {
          status: input.status,
          start: today,
        },
        snapshot.notes ? { notes: snapshot.notes } : {},
      ),
    }
  }

  toBoardItem(file: TFile): ProjectBoardItem {
    const cache = this.plugin.app.metadataCache.getFileCache(file)
    const frontmatter = ensureFrontmatterObject(cache?.frontmatter)
    const status = normalizeStatus(frontmatter.status)
    const order = normalizeNumber(frontmatter.order)
    const titleField = normalizeString(frontmatter.title)
    const fullTitle = titleField ?? file.basename
    const prefixSetting = this.plugin.settings.projectTitlePrefix ?? ''
    const displayTitle =
      prefixSetting && fullTitle.startsWith(prefixSetting)
        ? fullTitle.slice(prefixSetting.length).trimStart()
        : fullTitle

    return {
      file,
      path: file.path,
      basename: file.basename,
      title: fullTitle,
      displayTitle,
      status,
      order,
      created: normalizeString(frontmatter.created),
      updated: normalizeString(frontmatter.updated),
      completed: normalizeString(frontmatter.completed),
      notes: normalizeString(frontmatter.notes),
      frontmatter: { ...frontmatter },
    }
  }

  async updateProjectFrontmatter(
    file: TFile,
    mutate: (snapshot: ProjectFrontmatterSnapshot) => void,
  ): Promise<void> {
    const snapshot = this.toSnapshot(file)
    mutate(snapshot)
    await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.status = snapshot.status
      delete frontmatter.priority
      if (snapshot.order !== null && snapshot.order !== undefined) {
        frontmatter.order = snapshot.order
      } else {
        delete frontmatter.order
      }
      delete frontmatter.created
      delete frontmatter.updated
      if (snapshot.completed) frontmatter.completed = snapshot.completed
      else delete frontmatter.completed
      if (snapshot.notes) frontmatter.notes = snapshot.notes
      else delete frontmatter.notes
      return frontmatter
    })
  }

  private toSnapshot(file: TFile): ProjectFrontmatterSnapshot {
    const item = this.toBoardItem(file)
    return {
      status: item.status,
      order: item.order ?? null,
      created: item.created,
      updated: item.updated,
      completed: item.completed,
      notes: item.notes,
    }
  }

  async updateProjectStatus(path: string, status: ProjectBoardStatus, options?: {
    markCompleted?: boolean
    order?: number | null
  }): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) {
      throw new Error(`Project file not found: ${path}`)
    }
    await this.updateProjectFrontmatter(file, (snapshot) => {
      snapshot.status = status
      snapshot.updated = undefined
      snapshot.created = undefined
      if (typeof options?.order === 'number') {
        snapshot.order = options.order
      } else if (options?.order === null) {
        snapshot.order = null
      }
      snapshot.completed = undefined
    })
  }
}
