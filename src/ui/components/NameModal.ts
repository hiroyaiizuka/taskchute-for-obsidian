import { App, Modal } from 'obsidian'
import { createModalFooter } from './modalFooter'

export interface NameModalOptions {
  app: App
  title: string
  label: string
  placeholder: string
  submitText: string
  cancelText: string
  closeLabel: string
}

export interface NameModalHandle {
  overlay: HTMLElement
  content: HTMLElement
  form: HTMLFormElement
  inputGroup: HTMLElement
  input: HTMLInputElement
  warning: HTMLElement
  submitButton: HTMLButtonElement
  cancelButton: HTMLButtonElement
  close: () => void
  onClose: (handler: () => void) => void
}

/**
 * The name-entry dialog shared by task creation and project creation. Callers
 * receive the built elements so they can graft their own fields into the form
 * — task creation inserts its mode, reminder and AI sections around the input
 * and the button row.
 */
class NameModal extends Modal {
  readonly closeHandlers: Array<() => void> = []

  constructor(app: App, private readonly options: NameModalOptions) {
    super(app)
  }

  build(): Omit<NameModalHandle, 'close' | 'onClose'> {
    const { contentEl, options } = this
    this.modalEl.addClass('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-name-modal')
    this.setTitle(options.title)

    const form = contentEl.createEl('form', { cls: 'task-form' })
    const inputGroup = form.createDiv({ cls: 'form-group' })
    inputGroup.createEl('label', { cls: 'form-label', text: options.label })
    const input = inputGroup.createEl('input', {
      cls: 'form-input',
      attr: { type: 'text', placeholder: options.placeholder },
    })
    const warning = inputGroup.createDiv({
      cls: 'task-name-warning hidden',
      attr: { role: 'alert', 'aria-live': 'polite' },
    })

    const {
      buttons: [cancelButton, submitButton],
    } = createModalFooter(form, [
      { text: options.cancelText, role: 'cancel', onClick: () => this.close() },
      { text: options.submitText, role: 'primary', type: 'submit' },
    ])

    return {
      overlay: this.containerEl,
      content: this.modalEl,
      form,
      inputGroup,
      input,
      warning,
      submitButton,
      cancelButton,
    }
  }

  onClose(): void {
    this.closeHandlers.forEach((handler) => {
      try {
        handler()
      } catch (error) {
        console.error('[NameModal] Close handler failed', error)
      }
    })
    this.contentEl.empty()
  }
}

export function createNameModal(options: NameModalOptions): NameModalHandle {
  const modal = new NameModal(options.app, options)
  modal.open()
  const parts = modal.build()
  parts.input.focus()

  return {
    ...parts,
    close: () => modal.close(),
    onClose: (handler: () => void) => {
      modal.closeHandlers.push(handler)
    },
  }
}
