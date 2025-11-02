import { Notice, TFile } from 'obsidian'
import { TaskData, TaskInstance, TaskChutePluginLike, ProjectBoardStatus } from '../../types'
import ProjectSettingsModal from '../modals/ProjectSettingsModal'

export interface ProjectControllerHost {
  app: TaskChutePluginLike['app']
  plugin: TaskChutePluginLike
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getInstanceDisplayTitle: (inst: TaskInstance) => string
  renderTaskList: () => void
  getTaskListElement: () => HTMLElement | null | undefined
  registerDisposer?: (cleanup: () => void) => void
}

export default class ProjectController {
  constructor(private readonly host: ProjectControllerHost) {}

  async updateTaskProject(inst: TaskInstance, projectName: string): Promise<void> {
    try {
      const displayTitle = this.host.getInstanceDisplayTitle(inst)
      let file: TFile | null = inst.task.file instanceof TFile ? inst.task.file : null
      if (!file && inst.task.path) {
        const byPath = this.host.app.vault.getAbstractFileByPath(inst.task.path)
        file = byPath instanceof TFile ? byPath : null
      }
      if (!file) {
        const taskFolderPath = this.host.plugin.pathManager.getTaskFolderPath()
        const fallbackBase = inst.task.name || displayTitle
        const fallbackPath = `${taskFolderPath}/${fallbackBase}.md`
        const byFallback = this.host.app.vault.getAbstractFileByPath(fallbackPath)
        file = byFallback instanceof TFile ? byFallback : null
      }

      if (!file) {
        new Notice(
          this.host.tv('project.fileMissing', 'Task file "{title}.md" not found', {
            title: displayTitle,
          }),
        )
        return
      }

      await this.host.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (projectName) {
          frontmatter.project = `[[${projectName}]]`
        } else {
          delete frontmatter.project
          delete frontmatter.project_path
        }
        return frontmatter
      })

      inst.task.project = projectName || undefined
      const projectFolderPath = this.host.plugin.pathManager.getProjectFolderPath()
      inst.task.projectPath = projectName && projectFolderPath
        ? `${projectFolderPath}/${projectName}.md`
        : undefined
      inst.task.projectTitle = projectName || undefined

      this.host.renderTaskList()

      const message = projectName
        ? this.host.tv('project.linked', 'Linked "{title}" to {project}', {
            title: displayTitle,
            project: projectName,
          })
        : this.host.tv('project.unlinked', 'Removed project link from "{title}"', {
            title: displayTitle,
          })
      new Notice(message)
    } catch (error) {
      console.error('Failed to update project:', error)
      new Notice(this.host.tv('notices.projectUpdateFailed', 'Failed to update project'))
    }
  }

  async showProjectModal(inst: TaskInstance): Promise<void> {
    await this.showUnifiedProjectModal(inst)
  }

  async showUnifiedProjectModal(inst: TaskInstance): Promise<void> {
    try {
      const projectsFolder = this.host.plugin.pathManager.getProjectFolderPath()
      if (!projectsFolder) {
        new Notice(
          this.host.tv(
            'notices.projectFolderUnset',
            'Project files location is not set. Open settings to choose a folder.',
          ),
        )
        const settingApi = this.host.app.setting
        try {
          const manifestId = this.host.plugin?.manifest?.id
          if (settingApi && manifestId) {
            settingApi.open()
            settingApi.openTabById(manifestId)
          }
        } catch {
          // ignore setting API issues
        }
        return
      }

      const displayTitle = this.host.getInstanceDisplayTitle(inst)
      const projectFiles = await this.getProjectFiles()
      const modal = new ProjectSettingsModal(this.host.app, {
        app: this.host.app,
        plugin: this.host.plugin,
        tv: (key, fallback, vars) => this.host.tv(key, fallback, vars),
        displayTitle,
        projectFiles,
        currentProjectPath: inst.task.projectPath ?? undefined,
        onSubmit: async (projectPath) => {
          await this.setProjectForTask(inst.task, projectPath)
          this.updateProjectDisplay(inst)
        },
      })
      this.host.registerDisposer?.(() => modal.close())
      modal.open()
    } catch (error) {
      console.error('Failed to show project modal:', error)
      new Notice(this.host.tv('notices.projectPickerFailed', 'Failed to open project picker'))
    }
  }

  async getProjectFiles(): Promise<TFile[]> {
    const projectFolderPath = this.host.plugin.pathManager.getProjectFolderPath()
    if (!projectFolderPath) return []

    const prefix = projectFolderPath.endsWith('/')
      ? projectFolderPath
      : `${projectFolderPath}/`

    const files = this.host.app.vault.getMarkdownFiles()
    const inScope = files.filter((file) => file.path.startsWith(prefix))

    const filtered = inScope.filter((file) => {
      const cache = this.host.app.metadataCache.getFileCache(file)
      const statusValue = cache?.frontmatter?.status
      const status = normalizeProjectModalStatus(statusValue)
      return status === 'todo' || status === 'in-progress'
    })

    return filtered.sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }),
    )
  }

  async setProjectForTask(task: TaskData, projectPath: string): Promise<void> {
    try {
      if (!task.file || !(task.file instanceof TFile)) {
        new Notice(this.host.tv('notices.taskFileMissing', 'Task file not found'))
        return
      }

      await this.host.app.fileManager.processFrontMatter(task.file, (frontmatter) => {
        if (projectPath) {
          const projectFile = this.host.app.vault.getAbstractFileByPath(projectPath)
        if (projectFile instanceof TFile) {
          frontmatter.project = `[[${projectFile.basename}]]`
          delete frontmatter.project_path
        } else {
          frontmatter.project = `[[${projectPath.split('/').pop() ?? projectPath}]]`
          delete frontmatter.project_path
        }
        } else {
          delete frontmatter.project
          delete frontmatter.project_path
        }
        return frontmatter
      })

      if (projectPath) {
        const projectFile = this.host.app.vault.getAbstractFileByPath(projectPath)
        if (projectFile instanceof TFile) {
          task.projectPath = projectPath
          task.projectTitle = projectFile.basename
        } else {
          task.projectPath = projectPath
          task.projectTitle = projectPath.split('/').pop() ?? projectPath
        }
      } else {
        task.projectPath = undefined
        task.projectTitle = undefined
      }

      new Notice(this.host.tv('project.settingsSaved', 'Project settings saved'))
    } catch (error) {
      console.error('Failed to set project:', error)
      new Notice(this.host.tv('notices.projectSetFailed', 'Failed to set project'))
    }
  }

  updateProjectDisplay(inst: TaskInstance): void {
    const taskList = this.host.getTaskListElement()
    if (!taskList) return
    const taskItem = taskList.querySelector(`[data-task-path="${inst.task.path}"]`) as HTMLElement | null
    if (!taskItem) return

    const projectDisplay = taskItem.querySelector('.taskchute-project-display') as HTMLElement | null
    if (!projectDisplay) return

    projectDisplay.empty()
    if (inst.task.projectPath && inst.task.projectTitle) {
      const prefix = this.host.plugin.settings.projectTitlePrefix ?? ''
      let displayName = inst.task.projectTitle
      if (prefix && displayName.startsWith(prefix)) {
        displayName = displayName.slice(prefix.length).trimStart()
      }
      if (!displayName || displayName.length === 0) {
        displayName = inst.task.projectTitle || this.host.tv('project.none', 'No project')
      }

      const projectButton = projectDisplay.createEl('span', {
        cls: 'taskchute-project-button',
        attr: {
          title: this.host.tv('project.tooltipAssigned', 'Project: {title}', { title: displayName }),
        },
      })
      projectButton.createEl('span', { cls: 'taskchute-project-icon', text: '📁' })
      projectButton.createEl('span', { cls: 'taskchute-project-name', text: displayName })
      projectButton.addEventListener('click', async (event) => {
        event.stopPropagation()
        await this.showUnifiedProjectModal(inst)
      })

      const externalLink = projectDisplay.createEl('span', {
        cls: 'taskchute-external-link',
        text: '🔗',
        attr: { title: this.host.tv('project.openNote', 'Open project note') },
      })
      externalLink.addEventListener('click', async (event) => {
        event.stopPropagation()
        if (inst.task.projectPath) {
          await this.openProjectInSplit(inst.task.projectPath)
        }
      })
    } else {
      const placeholderLabel = this.host.tv('project.clickToSet', 'Click to set project')
      const placeholder = projectDisplay.createEl('span', {
        cls: 'taskchute-project-placeholder',
        text: placeholderLabel,
        attr: { title: placeholderLabel },
      })
      placeholder.addEventListener('click', async (event) => {
        event.stopPropagation()
        await this.showProjectModal(inst)
      })
    }
  }

  async openProjectInSplit(projectPath: string): Promise<void> {
    try {
      const file = this.host.app.vault.getAbstractFileByPath(projectPath)
      if (file instanceof TFile) {
        const leaf = this.host.app.workspace.getLeaf('split')
        await leaf.openFile(file)
      } else {
        new Notice(
          this.host.tv('project.fileMissingPath', 'Project file not found: {path}', {
            path: projectPath,
          }),
        )
      }
    } catch (error) {
      console.error('Failed to open project:', error)
      new Notice(this.host.tv('notices.projectOpenFailed', 'Failed to open project file'))
    }
  }
}
function normalizeProjectModalStatus(value: unknown): ProjectBoardStatus {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'done' || normalized === 'completed') {
      return 'done'
    }
    if (normalized === 'in-progress' || normalized === 'in_progress' || normalized === 'in progress') {
      return 'in-progress'
    }
    if (normalized === 'todo' || normalized === 'to-do' || normalized === 'not started') {
      return 'todo'
    }
  }
  return 'todo'
}
