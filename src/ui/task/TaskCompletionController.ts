import { Notice, TFile, App } from 'obsidian'
import { t } from '../../i18n'
import { ProjectNoteSyncService } from '../../features/project/services/ProjectNoteSyncService'
import type { TaskInstance, PathManagerLike } from '../../types'
import type { TaskLogEntry, TaskLogSnapshot } from '../../types/ExecutionLog'
import { parseTaskLogSnapshot } from '../../utils/executionLogUtils'

export interface TaskCompletionControllerHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  renderTaskList: () => void
  getInstanceDisplayTitle: (inst: TaskInstance) => string
  calculateCrossDayDuration: (start?: Date, stop?: Date) => number
  getCurrentDate: () => Date
  app: Pick<App, 'vault' | 'fileManager'>
  plugin: {
    pathManager: Pick<PathManagerLike, 'getLogDataPath' | 'ensureFolderExists' | 'getProjectFolderPath' | 'getTaskFolderPath' | 'getReviewDataPath' | 'getLogYearPath' | 'ensureYearFolder' | 'validatePath'>
  }
}

export default class TaskCompletionController {
  constructor(private readonly host: TaskCompletionControllerHost) {}

  async showTaskCompletionModal(inst: TaskInstance): Promise<void> {
    const existingComment = await this.getExistingTaskComment(inst)
    const displayTitle = this.host.getInstanceDisplayTitle(inst)

    const modal = document.createElement('div')
    modal.className = 'taskchute-comment-modal'
    const modalContent = modal.createEl('div', { cls: 'taskchute-comment-content' })

    const header = modalContent.createEl('div', { cls: 'taskchute-modal-header' })
    const headerText = existingComment
      ? this.host.tv('comment.editTitle', `✏️ Edit comment for "${displayTitle}"`, {
          title: displayTitle,
        })
      : this.host.tv(
          'comment.completedTitle',
          `🎉 Great job! "${displayTitle}" completed`,
          { title: displayTitle },
        )
    header.createEl('h2', { text: headerText })

    if (inst.state === 'done' && typeof inst.actualTime === 'number') {
      const timeInfo = modalContent.createEl('div', { cls: 'taskchute-time-info' })
      const duration = this.formatDuration(inst.actualTime)
      timeInfo.createEl('div', {
        cls: 'time-duration',
        text: this.host.tv('comment.duration', `Duration: ${duration}`, {
          duration,
        }),
      })

      if (inst.startTime && inst.stopTime) {
        const startStr = this.toTimeString(inst.startTime)
        const stopStr = this.toTimeString(inst.stopTime)
        timeInfo.createEl('div', {
          cls: 'time-range',
          text: this.host.tv('comment.timeRange', `Start: ${startStr} End: ${stopStr}`, {
            start: startStr,
            end: stopStr,
          }),
        })
      }
    }

    const ratingSection = modalContent.createEl('div', {
      cls: 'taskchute-rating-section',
    })
    ratingSection.createEl('h3', {
      text: this.host.tv('comment.question', 'How was this task?'),
    })

    const focusRating = this.createRatingGroup(ratingSection, {
      labelKey: 'comment.focusLabel',
      fallback: 'Focus:',
      initial: this.convertToFiveScale(existingComment?.focusLevel ?? 0),
    })

    const energyRating = this.createRatingGroup(ratingSection, {
      labelKey: 'comment.energyLabel',
      fallback: 'Energy:',
      initial: this.convertToFiveScale(existingComment?.energyLevel ?? 0),
    })

    const commentSection = modalContent.createEl('div', {
      cls: 'taskchute-comment-section',
    })
    commentSection.createEl('label', {
      text: this.host.tv('comment.fieldLabel', 'Notes / learnings / improvements:'),
      cls: 'comment-label',
    })
    const commentInput = commentSection.createEl('textarea', {
      cls: 'taskchute-comment-textarea',
      placeholder: this.host.tv(
        'comment.placeholder',
        'Share any thoughts, learnings, or improvements for next time...',
      ),
    }) as HTMLTextAreaElement
    if (existingComment?.executionComment) {
      commentInput.value = existingComment.executionComment
    }

    const buttonGroup = modalContent.createEl('div', {
      cls: 'taskchute-comment-actions',
    })
    const cancelButton = buttonGroup.createEl('button', {
      type: 'button',
      cls: 'taskchute-button-cancel',
      text: t('common.cancel', 'Cancel'),
    })
    const saveButton = buttonGroup.createEl('button', {
      type: 'button',
      cls: 'taskchute-button-save',
      text: this.host.tv('buttons.save', 'Save'),
    })

    let modalClosed = false
    const closeModal = () => {
      if (modalClosed) return
      modalClosed = true
      document.removeEventListener('keydown', handleEsc)
      modal.removeEventListener('click', handleBackdrop)
      modal.remove()
    }

    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeModal()
      }
    }
    const handleBackdrop = (event: MouseEvent) => {
      if (event.target === modal) {
        closeModal()
      }
    }

    cancelButton.addEventListener('click', closeModal)
    saveButton.addEventListener('click', async () => {
      const focusValue = parseInt(focusRating.getAttribute('data-rating') || '0', 10)
      const energyValue = parseInt(energyRating.getAttribute('data-rating') || '0', 10)
      await this.saveTaskComment(inst, {
        comment: commentInput.value,
        energy: energyValue,
        focus: focusValue,
      })
      closeModal()
      this.host.renderTaskList()
    })

    document.addEventListener('keydown', handleEsc)
    modal.addEventListener('click', handleBackdrop)
    document.body.appendChild(modal)
    commentInput.focus()
  }

  async hasCommentData(inst: TaskInstance): Promise<boolean> {
    try {
      const existing = await this.getExistingTaskComment(inst)
      if (!existing) return false
      const comment = (existing.executionComment || '').toString().trim()
      return Boolean(comment.length || (existing.focusLevel ?? 0) > 0 || (existing.energyLevel ?? 0) > 0)
    } catch {
      return false
    }
  }

  private createRatingGroup(
    container: HTMLElement,
    options: { labelKey: string; fallback: string; initial: number },
  ): HTMLElement {
    const group = container.createEl('div', { cls: 'rating-group' })
    group.createEl('label', {
      text: this.host.tv(options.labelKey, options.fallback),
      cls: 'rating-label',
    })
    const ratingEl = group.createEl('div', {
      cls: 'star-rating',
      attr: { 'data-rating': options.initial.toString() },
    })
    for (let i = 1; i <= 5; i += 1) {
      const star = ratingEl.createEl('span', {
        cls: `star ${i <= options.initial ? 'taskchute-star-filled' : 'taskchute-star-empty'}`,
        text: '⭐',
      })
      star.addEventListener('click', () => this.setRating(ratingEl, i))
      star.addEventListener('mouseenter', () => this.highlightRating(ratingEl, i))
      star.addEventListener('mouseleave', () => this.resetRatingHighlight(ratingEl))
    }
    this.updateRatingDisplay(ratingEl, options.initial)
    return ratingEl
  }

  private setRating(ratingEl: HTMLElement, value: number): void {
    ratingEl.setAttribute('data-rating', value.toString())
    this.updateRatingDisplay(ratingEl, value)
  }

  private highlightRating(ratingEl: HTMLElement, value: number): void {
    this.updateRatingDisplay(ratingEl, value)
  }

  private resetRatingHighlight(ratingEl: HTMLElement): void {
    const current = parseInt(ratingEl.getAttribute('data-rating') || '0', 10)
    this.updateRatingDisplay(ratingEl, current)
  }

  private updateRatingDisplay(ratingEl: HTMLElement, value: number): void {
    ratingEl.querySelectorAll('.star').forEach((star, index) => {
      const element = star as HTMLElement
      if (index < value) {
        element.classList.add('taskchute-star-filled')
        element.classList.remove('taskchute-star-empty')
      } else {
        element.classList.add('taskchute-star-empty')
        element.classList.remove('taskchute-star-filled')
      }
    })
  }

  private convertToFiveScale(value: number): number {
    if (!Number.isFinite(value)) return 0
    if (value <= 0) return 0
    if (value > 5) {
      return Math.min(5, Math.ceil(value / 2))
    }
    return value
  }

  private async getExistingTaskComment(inst: TaskInstance): Promise<TaskLogEntry | null> {
    if (!inst.instanceId) {
      return null
    }
    try {
      const { logFilePath, dateKey } = this.getLogPaths()
      const file = this.host.app.vault.getAbstractFileByPath(logFilePath)
      if (!file || !(file instanceof TFile)) {
        return null
      }
      const raw = await this.host.app.vault.read(file)
      const snapshot = parseTaskLogSnapshot(raw)
      const entries = snapshot.taskExecutions[dateKey] ?? []
      return entries.find((entry) => entry.instanceId === inst.instanceId) ?? null
    } catch {
      return null
    }
  }

  private async saveTaskComment(
    inst: TaskInstance,
    data: { comment: string; energy: number; focus: number },
  ): Promise<void> {
    const { logFilePath, logDataPath, dateKey } = this.getLogPaths()
    const vault = this.host.app.vault
    const file = vault.getAbstractFileByPath(logFilePath)
    if (this.host.plugin.pathManager.ensureFolderExists) {
      await this.host.plugin.pathManager.ensureFolderExists(logDataPath)
    }

    let snapshot: TaskLogSnapshot = { taskExecutions: {}, dailySummary: {} }
    if (file && file instanceof TFile) {
      const raw = await vault.read(file)
      snapshot = parseTaskLogSnapshot(raw)
    }

    const entries = snapshot.taskExecutions[dateKey] ?? []
    const idx = entries.findIndex((entry) => entry.instanceId === inst.instanceId)

    const startTime = this.toTimeString(inst.startTime)
    const stopTime = this.toTimeString(inst.stopTime)
    const durationSec = inst.startTime && inst.stopTime
      ? Math.floor(this.host.calculateCrossDayDuration(inst.startTime, inst.stopTime) / 1000)
      : 0

    const payload: TaskLogEntry = {
      instanceId: inst.instanceId,
      taskPath: inst.task?.path || '',
      taskName: inst.task?.name || '',
      executionComment: data.comment.trim(),
      focusLevel: data.focus,
      energyLevel: data.energy,
      startTime,
      stopTime,
      duration: durationSec,
      isCompleted: inst.state === 'done',
      project_path: inst.task?.projectPath || null,
      project: inst.task?.projectTitle ? `[[${inst.task.projectTitle}]]` : null,
      timestamp: new Date().toISOString(),
    }

    const previousEntry = idx >= 0 ? { ...entries[idx] } : null
    if (idx >= 0) {
      entries[idx] = {
        ...entries[idx],
        ...payload,
        lastCommentUpdate: new Date().toISOString(),
      }
    } else {
      entries.push(payload)
    }
    snapshot.taskExecutions[dateKey] = entries

    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`
    if (file && file instanceof TFile) {
      await vault.modify(file, serialized)
    } else {
      await vault.create(logFilePath, serialized)
    }

    if (
      payload.executionComment &&
      (inst.task?.projectPath || inst.task?.projectTitle) &&
      this.hasCommentChanged(previousEntry, payload)
    ) {
      await this.syncCommentToProject(inst, payload.executionComment as string)
    }

    if (!snapshot.dailySummary[dateKey]) {
      snapshot.dailySummary[dateKey] = {}
    }

    new Notice(this.host.tv('comment.saved', 'Comment saved'))
  }

  private hasCommentChanged(
    oldEntry: TaskLogEntry | null,
    newEntry: TaskLogEntry,
  ): boolean {
    const oldComment = (oldEntry?.executionComment ?? '').toString().trim()
    const newComment = (newEntry.executionComment ?? '').toString().trim()
    return oldComment !== newComment
  }

  private async syncCommentToProject(inst: TaskInstance, executionComment: string): Promise<void> {
    try {
      const syncManager = new ProjectNoteSyncService(
        this.host.app as unknown as App,
        this.host.plugin.pathManager as unknown as PathManagerLike,
      )
      const projectPath = await syncManager.getProjectNotePath(inst)
      if (!projectPath) {
        return
      }
      await syncManager.updateProjectNote(projectPath, inst, { executionComment })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        this.host.tv('project.noteSyncFailed', 'Failed to update project note: {message}', {
          message,
        }),
      )
    }
  }

  private getLogPaths(): { logFilePath: string; logDataPath: string; dateKey: string } {
    const current = this.host.getCurrentDate()
    const year = current.getFullYear()
    const month = String(current.getMonth() + 1).padStart(2, '0')
    const day = String(current.getDate()).padStart(2, '0')
    const monthKey = `${year}-${month}`
    const dateKey = `${monthKey}-${day}`
    const logDataPath = this.host.plugin.pathManager.getLogDataPath()
    return {
      logFilePath: `${logDataPath}/${monthKey}-tasks.json`,
      logDataPath,
      dateKey,
    }
  }

  private toTimeString(date?: Date): string {
    if (!date) return ''
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${hours}:${minutes}:${seconds}`
  }

  private formatDuration(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
      return '00:00:00'
    }
    const total = Math.floor(totalSeconds)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
  }
}
