import type { TaskInstance } from '../../types'

export interface TaskSelectionControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getContainer: () => HTMLElement
  duplicateInstance: (inst: TaskInstance) => Promise<TaskInstance | void>
  deleteTask: (inst: TaskInstance) => Promise<void>
  resetTaskToIdle: (inst: TaskInstance) => Promise<void>
  showDeleteConfirmDialog: (inst: TaskInstance) => Promise<boolean>
  notify: (message: string) => void
}

export default class TaskSelectionController {
  private selectedInstance: TaskInstance | null = null
  private selectedElement: HTMLElement | null = null

  constructor(private readonly host: TaskSelectionControllerHost) {}

  getSelectedInstance(): TaskInstance | null {
    return this.selectedInstance
  }

  select(inst: TaskInstance, element: HTMLElement): void {
    if (this.selectedElement === element) {
      return
    }

    this.clearHighlight()
    this.selectedInstance = inst
    this.selectedElement = element
    element.classList.add('keyboard-selected')
  }

  clear(): void {
    this.selectedInstance = null
    this.clearHighlight()
  }

  async duplicateSelectedTask(): Promise<void> {
    if (!this.selectedInstance) {
      this.showNotSelectedNotice()
      return
    }
    await this.host.duplicateInstance(this.selectedInstance)
    this.clear()
  }

  async deleteSelectedTask(): Promise<void> {
    const inst = this.selectedInstance
    if (!inst) {
      this.showNotSelectedNotice()
      return
    }

    const confirmed = await this.host.showDeleteConfirmDialog(inst)
    if (!confirmed) return

    await this.host.deleteTask(inst)
    this.clear()
  }

  async resetSelectedTask(): Promise<void> {
    if (!this.selectedInstance) {
      this.showNotSelectedNotice()
      return
    }
    if (this.selectedInstance.state === 'idle') {
      const message = this.host.tv('status.alreadyNotStarted', 'This task is already not started')
      this.host.notify(message)
      return
    }
    await this.host.resetTaskToIdle(this.selectedInstance)
    this.clear()
  }

  handleContainerClick(event: MouseEvent): void {
    const target = event.target
    if (target instanceof HTMLElement && target.closest('.task-item')) {
      return
    }
    this.clear()
  }

  private clearHighlight(): void {
    const container = this.host.getContainer()
    container
      .querySelectorAll('.task-item.keyboard-selected')
      .forEach((el) => el.classList.remove('keyboard-selected'))
    if (this.selectedElement) {
      this.selectedElement.classList.remove('keyboard-selected')
      this.selectedElement = null
    }
  }

  private showNotSelectedNotice(): void {
    const message = this.host.tv('notices.taskNotSelected', 'No task selected')
    this.host.notify(message)
  }
}
