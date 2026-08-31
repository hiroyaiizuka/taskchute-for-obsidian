import { App, Modal } from 'obsidian'
import { createElCompat } from '../components/domCompat'
import { createModalFooter } from '../components/modalFooter'

export interface ConfirmModalOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  description?: string
  /** Info-only dialog: drop the cancel button so OK is the single way out. */
  hideCancel?: boolean
}

class ConfirmModal extends Modal {
  private readonly resolve: (value: boolean) => void
  private readonly titleText: string
  private readonly messageText: string
  private readonly confirmText: string
  private readonly cancelText: string
  private readonly destructive: boolean
  private readonly description?: string
  private readonly hideCancel: boolean

  constructor(app: App, options: ConfirmModalOptions, resolve: (value: boolean) => void) {
    super(app)
    this.resolve = resolve
    this.titleText = options.title
    this.messageText = options.message
    this.confirmText = options.confirmText ?? 'OK'
    this.cancelText = options.cancelText ?? 'Cancel'
    this.destructive = options.destructive ?? false
    this.description = options.description
    this.hideCancel = options.hideCancel ?? false
  }

  onOpen(): void {
    const { contentEl } = this
    if (typeof (contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      contentEl.empty()
    } else {
      while (contentEl.firstChild) {
        contentEl.removeChild(contentEl.firstChild)
      }
    }
    this.modalEl?.classList.add('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-confirm-modal')
    if (this.destructive) {
      this.modalEl?.classList.add('taskchute-confirm-modal--destructive')
    }

    const header = createElCompat(contentEl, 'div', { cls: 'modal-header' })
    createElCompat(header, 'h3', { text: this.titleText })

    const messageEl = createElCompat(contentEl, 'p', { cls: 'modal-message' })
    this.messageText.split('\n').forEach((line, index) => {
      if (index > 0) {
        createElCompat(messageEl, 'br')
      }
      messageEl.appendChild(activeDocument.createTextNode(line))
    })

    if (this.description) {
      const descriptionEl = createElCompat(contentEl, 'p', { cls: 'modal-description' })
      this.description.split('\n').forEach((line, index) => {
        if (index > 0) {
          createElCompat(descriptionEl, 'br')
        }
        descriptionEl.appendChild(activeDocument.createTextNode(line))
      })
    }

    let cancelButton: HTMLButtonElement | undefined
    let confirmButton: HTMLButtonElement | undefined
    createModalFooter(contentEl, [
      ...(this.hideCancel
        ? []
        : [
            {
              text: this.cancelText,
              role: 'cancel' as const,
              ref: (button: HTMLButtonElement) => {
                cancelButton = button
              },
              onClick: () => {
                this.closeWith(false)
              },
            },
          ]),
      {
        text: this.confirmText,
        role: this.destructive ? ('danger' as const) : ('primary' as const),
        ref: (button: HTMLButtonElement) => {
          confirmButton = button
        },
        onClick: () => {
          this.closeWith(true)
        },
      },
    ])

    // A destructive dialog opens with cancel focused, so Enter does not carry
    // out the deletion by reflex.
    const defaultButton = this.destructive ? (cancelButton ?? confirmButton) : confirmButton
    defaultButton?.focus()
  }

  onClose(): void {
    if (typeof (this.contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      this.contentEl.empty()
    } else {
      while (this.contentEl.firstChild) {
        this.contentEl.removeChild(this.contentEl.firstChild)
      }
    }
    this.modalEl?.classList.remove('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-confirm-modal', 'taskchute-confirm-modal--destructive')
  }

  private closeWith(result: boolean): void {
    this.close()
    this.resolve(result)
  }
}

export function showConfirmModal(app: App, options: ConfirmModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModal(app, options, resolve)
    modal.open()
  })
}

/**
 * A dialog that only tells the user something. Reuses the confirm modal so the
 * chrome stays identical, minus the cancel button there is nothing to cancel.
 */
export function showInfoModal(
  app: App,
  options: Omit<ConfirmModalOptions, 'hideCancel' | 'cancelText' | 'destructive'>,
): Promise<void> {
  return showConfirmModal(app, { ...options, hideCancel: true }).then(() => undefined)
}
