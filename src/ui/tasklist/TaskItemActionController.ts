import type { TaskInstance } from '../../types'

export interface TaskItemActionHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: {
    workspace: {
      openLinkText: (path: string, sourcePath: string, newLeaf?: boolean) => Promise<void> | void
    }
  }
  registerManagedDomEvent: (target: Document | HTMLElement, event: string, handler: EventListener) => void
  showTaskCompletionModal: (inst: TaskInstance) => Promise<void> | void
  hasCommentData: (inst: TaskInstance) => Promise<boolean>
  showRoutineEditModal: (task: TaskInstance['task'], element: HTMLElement) => void
  toggleRoutine: (task: TaskInstance['task'], element?: HTMLElement) => Promise<void> | void
  showTaskSettingsTooltip: (inst: TaskInstance, element: HTMLElement) => void
  showProjectModal?: (inst: TaskInstance) => Promise<void> | void
  showUnifiedProjectModal?: (inst: TaskInstance) => Promise<void> | void
  openProjectInSplit?: (projectPath: string) => Promise<void> | void
}

export class TaskItemActionController {
  constructor(private readonly host: TaskItemActionHost) {}

  renderProject(container: HTMLElement, inst: TaskInstance): void {
    const wrapper = container.createEl('span', { cls: 'taskchute-project-display' })
    const projectTitle = inst.task.projectTitle || ''
    const normalized = projectTitle.replace(/^Project\s*-\s*/u, '')
    const displayTitle = normalized.trim().length > 0 ? normalized : projectTitle || this.host.tv('project.none', 'No project')

    if (inst.task.projectPath && projectTitle) {
      const projectButton = wrapper.createEl('span', {
        cls: 'taskchute-project-button',
        attr: {
          title: this.host.tv('project.tooltipAssigned', 'Project: {title}', { title: displayTitle }),
        },
      })
      projectButton.createEl('span', { cls: 'taskchute-project-icon', text: '📁' })
      projectButton.createEl('span', { cls: 'taskchute-project-name', text: displayTitle })
      this.host.registerManagedDomEvent(projectButton, 'click', (event) => {
        event.stopPropagation()
        if (typeof this.host.showUnifiedProjectModal === 'function') {
          void this.host.showUnifiedProjectModal(inst)
        } else if (typeof this.host.showProjectModal === 'function') {
          void this.host.showProjectModal(inst)
        }
      })

      const externalLink = wrapper.createEl('span', {
        cls: 'taskchute-external-link',
        text: '🔗',
        attr: {
          title: this.host.tv('project.openNote', 'Open project note'),
        },
      })
      this.host.registerManagedDomEvent(externalLink, 'click', (event) => {
        event.stopPropagation()
        const path = inst.task.projectPath ?? ''
        if (!path) return
        if (typeof this.host.openProjectInSplit === 'function') {
          void this.host.openProjectInSplit(path)
        } else {
          void this.host.app.workspace.openLinkText(path, '', false)
        }
      })
    } else {
      const label = this.host.tv('project.clickToSet', 'Set project')
      const placeholder = wrapper.createEl('span', {
        cls: 'taskchute-project-placeholder',
        text: label,
        attr: { title: label },
      })
      this.host.registerManagedDomEvent(placeholder, 'click', (event) => {
        event.stopPropagation()
        if (typeof this.host.showProjectModal === 'function') {
          void this.host.showProjectModal(inst)
        } else if (typeof this.host.showUnifiedProjectModal === 'function') {
          void this.host.showUnifiedProjectModal(inst)
        }
      })
    }
  }

  renderCommentButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const button = taskItem.createEl('button', {
      cls: 'comment-button',
      text: '💬',
      attr: { 'data-task-state': inst.state },
    })

    if (inst.state !== 'done') {
      button.classList.add('disabled')
      button.setAttribute('disabled', 'true')
    }

    this.host.registerManagedDomEvent(button, 'click', async (event) => {
      event.stopPropagation()
      if (inst.state !== 'done') return
      await this.host.showTaskCompletionModal(inst)
    })

    this.host.hasCommentData(inst).then((hasComment) => {
      if (hasComment) {
        button.classList.add('active')
      } else {
        button.classList.remove('active')
        if (inst.state === 'done') {
          button.classList.add('no-comment')
        }
      }
    })
  }

  renderRoutineButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const button = taskItem.createEl('button', {
      cls: `routine-button ${inst.task.isRoutine ? 'active' : ''}`,
      text: '🔄',
      attr: {
        title: inst.task.isRoutine
          ? this.host.tv('tooltips.routineAssigned', 'Routine task')
          : this.host.tv('tooltips.routineSet', 'Set as routine'),
      },
    })

    this.host.registerManagedDomEvent(button, 'click', (event) => {
      event.stopPropagation()
      if (inst.task.isRoutine) {
        this.host.showRoutineEditModal(inst.task, button)
      } else {
        void this.host.toggleRoutine(inst.task, button)
      }
    })
  }

  renderSettingsButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const button = taskItem.createEl('button', {
      cls: 'settings-task-button',
      text: '⚙️',
      attr: { title: this.host.tv('forms.taskSettings', 'Task settings') },
    })

    this.host.registerManagedDomEvent(button, 'click', (event) => {
      event.stopPropagation()
      this.host.showTaskSettingsTooltip(inst, button)
    })
  }

}

export default TaskItemActionController
