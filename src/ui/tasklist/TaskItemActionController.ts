import { Platform } from 'obsidian'
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

  /**
   * Register both click and touchend events for mobile compatibility.
   * On mobile, touchend fires before click, allowing immediate response.
   * Only triggers on actual taps (not scrolls) by checking touch movement distance.
   */
  private registerTapEvent(element: HTMLElement, handler: (event: Event) => void): void {
    // Always register click for desktop
    this.host.registerManagedDomEvent(element, 'click', handler)

    // On mobile, also register touch events for immediate response
    if (Platform?.isMobile) {
      const TAP_THRESHOLD = 10 // Max pixels of movement to still count as a tap
      let touchStartX = 0
      let touchStartY = 0

      this.host.registerManagedDomEvent(element, 'touchstart', (event) => {
        if (event instanceof TouchEvent && event.touches.length > 0) {
          touchStartX = event.touches[0].clientX
          touchStartY = event.touches[0].clientY
          // Stop propagation to prevent parent elements from receiving touch events
          event.stopPropagation()
        }
      })

      this.host.registerManagedDomEvent(element, 'touchend', (event) => {
        if (!(event instanceof TouchEvent)) return

        // Stop propagation first
        event.stopPropagation()

        // Check if touch moved too much (indicates scroll, not tap)
        if (event.changedTouches.length > 0) {
          const touch = event.changedTouches[0]
          const deltaX = Math.abs(touch.clientX - touchStartX)
          const deltaY = Math.abs(touch.clientY - touchStartY)

          if (deltaX > TAP_THRESHOLD || deltaY > TAP_THRESHOLD) {
            // This was a scroll, not a tap - ignore
            return
          }
        }

        event.preventDefault() // Prevent click from firing
        handler(event)
      })
    }
  }

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
      this.registerTapEvent(projectButton, (event) => {
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
      this.registerTapEvent(externalLink, (event) => {
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
      this.registerTapEvent(placeholder, (event) => {
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

    this.registerTapEvent(button, (event) => {
      void (async () => {
        event.stopPropagation()
        if (inst.state !== 'done') return
        await this.host.showTaskCompletionModal(inst)
      })()
    })

    void this.host.hasCommentData(inst).then((hasComment) => {
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

    this.registerTapEvent(button, (event) => {
      event.stopPropagation()
      if (inst.task.isRoutine) {
        // Delay modal opening to ensure touch events are fully processed
        // This prevents touch events from propagating to modal content
        setTimeout(() => {
          this.host.showRoutineEditModal(inst.task, button)
        }, 50)
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

    this.registerTapEvent(button, (event) => {
      event.stopPropagation()
      this.host.showTaskSettingsTooltip(inst, button)
    })
  }

}

export default TaskItemActionController
