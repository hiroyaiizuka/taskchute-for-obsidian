import { Modal, Notice, TFile } from 'obsidian'
import { t } from '../../i18n'
import { createModalFooter } from '../components/modalFooter'
import { getScheduledTime, setScheduledTime } from '../../utils/fieldMigration'
import type { TaskInstance } from '../../types'

export interface ScheduledTimeModalHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: {
    vault: {
      getAbstractFileByPath: (path: string) => unknown
      read: (file: TFile) => Promise<string>
    }
    fileManager: {
      processFrontMatter: (
        file: TFile,
        updater: (frontmatter: Record<string, unknown>) => void,
      ) => Promise<void>
    }
  }
  reloadTasksAndRestore: (options?: { runBoundaryCheck?: boolean }) => Promise<void>
  saveScheduledTime?: (
    instance: TaskInstance,
    scheduledTime: string | undefined,
    params: { previousScheduledTime?: string; nextScheduledTime?: string },
  ) => Promise<boolean>
  onScheduledTimeSaved?: (
    instance: TaskInstance,
    params: { previousScheduledTime?: string; nextScheduledTime?: string },
  ) => Promise<void>
}

export interface ScheduledTimeModalOptions {
  host: ScheduledTimeModalHost
  instance: TaskInstance
}

export default class ScheduledTimeModal extends Modal {
  constructor(private readonly options: ScheduledTimeModalOptions) {
    super(options.host.app as unknown as Modal['app'])
  }

  onClose(): void {
    this.contentEl.empty()
  }

  onOpen(): void {
    const { host, instance } = this.options
    const { contentEl } = this
    contentEl.empty()
    this.modalEl.addClass('taskchute-modal', 'taskchute-modal--no-close', 'scheduled-time-modal')
    this.setTitle(host.tv('forms.scheduledTimeModalTitle', 'Set scheduled start time'))

    const form = contentEl.createEl('form', { cls: 'task-form scheduled-time-form' })
    const group = form.createDiv( { cls: 'form-group' })
    group.createEl('label', {
      text: host.tv('forms.scheduledTimeLabel', 'Scheduled start time:'),
      cls: 'form-label',
    })
    const current = getScheduledTime(instance.task.frontmatter || {})
    const input = group.createEl('input', {
      type: 'time',
      cls: 'form-input',
      value: current || '',
    })

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
      }
    })

    const descriptionText = host.tv(
      'forms.startTimeInfo',
      'Set the scheduled start time. Leave empty to clear it.',
    )
    const description = form.createEl('p', { cls: 'modal-description' })
    descriptionText.split('\n').forEach((line, index) => {
      if (index > 0) {
        description.createEl('br')
      }
      description.appendChild(activeDocument.createTextNode(line))
    })

    createModalFooter(form, [
      { text: t('common.cancel', 'Cancel'), role: 'cancel', onClick: () => this.close() },
      { text: host.tv('buttons.save', 'Save'), role: 'primary', type: 'submit' },
    ])

    const close = () => this.close()

    form.addEventListener('submit', (event) => {
      void (async () => {
        event.preventDefault()
        const value = input.value.trim()
        const previousScheduledTime = getScheduledTime(instance.task.frontmatter || {}) || undefined
        const nextScheduledTime = value || undefined
        const params = {
          previousScheduledTime,
          nextScheduledTime,
        }
        try {
          const handledByHost = typeof host.saveScheduledTime === 'function'
            ? await host.saveScheduledTime(instance, nextScheduledTime, params)
            : false

          if (!handledByHost) {
            const path = instance.task.path
            if (!path) {
              new Notice(host.tv('notices.taskFileMissing', 'Task file not found'))
              return
            }
            const file = host.app.vault.getAbstractFileByPath(path)
            if (!(file instanceof TFile)) {
              new Notice(host.tv('notices.taskFileMissing', 'Task file not found'))
              return
            }
            await host.app.fileManager.processFrontMatter(file, (frontmatter) => {
              setScheduledTime(frontmatter, value || undefined, { preferNew: true })
            })
          }

          if (typeof host.onScheduledTimeSaved === 'function') {
            try {
              await host.onScheduledTimeSaved(instance, params)
            } catch (error) {
              console.warn('[ScheduledTimeModal] Failed to sync duplicate slot', error)
            }
          }
          await host.reloadTasksAndRestore({ runBoundaryCheck: true })
          new Notice(
            value
              ? host.tv('forms.startTimeUpdated', 'Scheduled start time set to {time}', { time: value })
              : host.tv('forms.startTimeDeleted', 'Removed scheduled start time'),
          )
          close()
        } catch (error) {
          console.error('[ScheduledTimeModal] Failed to update scheduled time', error)
          new Notice(host.tv('forms.startTimeUpdateFailed', 'Failed to update scheduled start time'))
        }
      })()
    })
  }
}
