import { Modal, Notice } from 'obsidian'
import type { TaskInstance } from '../../types'
import { t } from '../../i18n'
import { showConfirmModal } from './ConfirmModal'

export interface TimeEditModalHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getInstanceDisplayTitle: (inst: TaskInstance) => string
}

export interface TimeEditModalOptions {
  app: Modal['app']
  host: TimeEditModalHost
  instance: TaskInstance
  callbacks: {
    resetTaskToIdle: () => Promise<void>
    updateRunningInstanceStartTime: (startStr: string) => Promise<void>
    transitionToRunningWithStart: (startStr: string) => Promise<void>
    updateInstanceTimes: (startStr: string, stopStr: string) => Promise<void>
  }
}

export default class TimeEditModal extends Modal {
  constructor(private readonly options: TimeEditModalOptions) {
    super(options.app)
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.classList.add('time-edit-modal')

    const { host, instance, callbacks } = this.options
    const displayTitle = host.getInstanceDisplayTitle(instance)

    const header = contentEl.createEl('div', { cls: 'modal-header' })
    header.createEl('h3', {
      text: host.tv('forms.timeEditTitle', `Edit times for "${displayTitle}"`, {
        title: displayTitle,
      }),
    })

    const form = contentEl.createEl('form', { cls: 'task-form time-edit-form' })

    const toHM = (date?: Date) =>
      date
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : ''

    const toMinutes = (value: string): number => {
      const [hours, minutes] = value.split(':').map((n) => parseInt(n, 10))
      return hours * 60 + minutes
    }

    const isSameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()

    const preventEnterSubmit = (element: HTMLElement) => {
      element.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault()
        }
      })
    }

    const startGroup = form.createEl('div', { cls: 'form-group' })
    startGroup.createEl('label', {
      text: host.tv('forms.scheduledTimeLabel', 'Start time:'),
      cls: 'form-label',
    })
    const startInput = startGroup.createEl('input', {
      type: 'time',
      cls: 'form-input',
      value: toHM(instance.startTime),
    })

    preventEnterSubmit(startInput)

    const startClear = startGroup.createEl('button', {
      type: 'button',
      cls: 'form-button secondary',
      text: host.tv('buttons.clear', 'Clear'),
    })
    startClear.addEventListener('click', (event) => {
      event.preventDefault()
      startInput.value = ''
    })

    let stopInput: HTMLInputElement | null = null
    if (instance.state === 'done' && instance.stopTime) {
      const stopGroup = form.createEl('div', { cls: 'form-group' })
      stopGroup.createEl('label', {
        text: host.tv('forms.stopTimeLabel', 'Stop time:'),
        cls: 'form-label',
      })
      stopInput = stopGroup.createEl('input', {
        type: 'time',
        cls: 'form-input',
        value: toHM(instance.stopTime),
      })

      preventEnterSubmit(stopInput)

      const stopClear = stopGroup.createEl('button', {
        type: 'button',
        cls: 'form-button secondary',
        text: host.tv('buttons.clear', 'Clear'),
      })
      stopClear.addEventListener('click', (event) => {
        event.preventDefault()
        if (stopInput) stopInput.value = ''
      })
    }

    const description = form.createEl('p', { cls: 'modal-description time-edit-hint' })
    if (instance.state === 'running') {
      description.textContent = host.tv(
        'forms.startTimeRemovedHint',
        'Removing the scheduled start time resets the task to not started.',
      )
    } else {
      const rawText = host.tv(
        'forms.endTimeResetHint',
        'Delete end time only: back to running\nDelete both: back to not started',
      )
      const normalized = rawText.replace(/\\n/g, '\n')
      const lines = normalized.split('\n')
      description.textContent = ''
      lines.forEach((line, index) => {
        const span = document.createElement('span')
        span.textContent = line
        description.appendChild(span)
        if (index < lines.length - 1) {
          description.appendChild(document.createElement('br'))
        }
      })
    }

    const buttonGroup = form.createEl('div', { cls: 'form-button-group' })
    const cancelButton = buttonGroup.createEl('button', {
      type: 'button',
      cls: 'form-button cancel',
      text: host.tv('buttons.cancel', t('common.cancel', 'Cancel')),
    })

    buttonGroup.createEl('button', {
      type: 'submit',
      cls: 'form-button create',
      text: host.tv('buttons.save', t('common.save', 'Save')),
    })

    const closeModal = () => {
      contentEl.empty()
      contentEl.classList.remove('time-edit-modal')
      this.close()
    }

    cancelButton.addEventListener('click', () => closeModal())

    form.addEventListener('submit', (event) => {
      void (async () => {
        event.preventDefault()
        const startStr = (startInput.value || '').trim()
        const stopStr = (stopInput?.value || '').trim()

        if (instance.state === 'running') {
          if (!startStr) {
            await callbacks.resetTaskToIdle()
            closeModal()
            return
          }
          await callbacks.updateRunningInstanceStartTime(startStr)
          closeModal()
          return
        }

        if (instance.state === 'done') {
          if (!startStr && !stopStr) {
            await callbacks.resetTaskToIdle()
            closeModal()
            return
          }

          if (startStr && !stopStr) {
            await callbacks.transitionToRunningWithStart(startStr)
            closeModal()
            return
          }

          if (!startStr && stopStr) {
            new Notice(host.tv('forms.startTimeRequired', 'Start time is required'))
            return
          }

          if (startStr && stopStr) {
            const startMinutes = toMinutes(startStr)
            const stopMinutes = toMinutes(stopStr)

            if (startMinutes === stopMinutes) {
              new Notice(
                host.tv('forms.startTimeBeforeEnd', 'Scheduled start time must be before end time'),
              )
              return
            }

            const originalCrossDay = Boolean(
              instance.startTime &&
                instance.stopTime &&
                !isSameDay(instance.startTime, instance.stopTime),
            )

            if (startMinutes > stopMinutes && !originalCrossDay) {
              const confirmed = await showConfirmModal(this.app, {
                title: host.tv('forms.confirmStopNextDayTitle', 'Treat stop time as next day?'),
                message: host.tv(
                  'forms.confirmStopNextDayMessage',
                  'The stop time you entered is earlier than the start time. Save it as next day?',
                ),
                confirmText: host.tv('buttons.save', t('common.save', 'Save')),
                cancelText: host.tv('buttons.cancel', t('common.cancel', 'Cancel')),
              })
              if (!confirmed) {
                new Notice(
                  host.tv('forms.startTimeBeforeEnd', 'Scheduled start time must be before end time'),
                )
                return
              }
            }

            await callbacks.updateInstanceTimes(startStr, stopStr)
            closeModal()
            return
          }
        }
      })()
    })

    startInput.focus()
  }
}
