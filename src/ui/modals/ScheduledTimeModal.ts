import { Modal, Notice, TFile } from 'obsidian'
import { t } from '../../i18n'
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
}

export interface ScheduledTimeModalOptions {
  host: ScheduledTimeModalHost
  instance: TaskInstance
}

export default class ScheduledTimeModal extends Modal {
  constructor(private readonly options: ScheduledTimeModalOptions) {
    super(options.host.app as unknown as Modal['app'])
  }

  onOpen(): void {
    const { host, instance } = this.options
    const { contentEl } = this
    contentEl.empty()
    contentEl.classList.add('scheduled-time-modal')

    const title = host.tv('forms.scheduledTimeModalTitle', 'Set scheduled start time')
    const header = contentEl.createEl('div', { cls: 'modal-header' })
    header.createEl('h3', { text: title })

    const form = contentEl.createEl('form', { cls: 'task-form scheduled-time-form' })
    const group = form.createEl('div', { cls: 'form-group' })
    group.createEl('label', {
      text: host.tv('forms.scheduledTimeLabel', 'Scheduled start time:'),
      cls: 'form-label',
    })
    const current = getScheduledTime(instance.task.frontmatter || {})
    const input = group.createEl('input', {
      type: 'time',
      cls: 'form-input',
      value: current || '',
    }) as HTMLInputElement

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
      }
    })

    const descriptionText = host.tv(
      'forms.startTimeInfo',
      'Set the scheduled start time. Leave empty to clear it.',
    )
    const description = contentEl.createEl('p', { cls: 'modal-description' })
    descriptionText.split('\n').forEach((line, index) => {
      if (index > 0) {
        description.createEl('br')
      }
      description.appendChild(document.createTextNode(line))
    })

    const footer = form.createEl('div', { cls: 'form-button-group' })
    const cancelButton = footer.createEl('button', {
      type: 'button',
      cls: 'form-button cancel',
      text: t('common.cancel', 'Cancel'),
    })
    footer.createEl('button', {
      type: 'submit',
      cls: 'form-button create',
      text: host.tv('buttons.save', 'Save'),
    })

    const close = () => {
      contentEl.empty()
      contentEl.classList.remove('scheduled-time-modal')
      this.close()
    }

    cancelButton.addEventListener('click', () => close())

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const value = input.value.trim()
      try {
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
    })
  }
}
