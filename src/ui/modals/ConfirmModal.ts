import { App, Modal } from 'obsidian'

export interface ConfirmModalOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  description?: string
}

class ConfirmModal extends Modal {
  private readonly resolve: (value: boolean) => void
  private readonly titleText: string
  private readonly messageText: string
  private readonly confirmText: string
  private readonly cancelText: string
  private readonly destructive: boolean
  private readonly description?: string

  constructor(app: App, options: ConfirmModalOptions, resolve: (value: boolean) => void) {
    super(app)
    this.resolve = resolve
    this.titleText = options.title
    this.messageText = options.message
    this.confirmText = options.confirmText ?? 'OK'
    this.cancelText = options.cancelText ?? 'Cancel'
    this.destructive = options.destructive ?? false
    this.description = options.description
  }

  onOpen(): void {
    const { contentEl } = this
    while (contentEl.firstChild) {
      contentEl.removeChild(contentEl.firstChild)
    }
    this.modalEl?.classList.add('taskchute-confirm-modal')
    contentEl.classList.add('taskchute-confirm-content')

    const header = document.createElement('div')
    header.classList.add('taskchute-confirm-header')
    const titleEl = document.createElement('h3')
    titleEl.classList.add('taskchute-confirm-title')
    titleEl.textContent = this.titleText
    header.appendChild(titleEl)
    contentEl.appendChild(header)

    const messageEl = document.createElement('p')
    messageEl.classList.add('taskchute-confirm-message')
    messageEl.textContent = this.messageText
    contentEl.appendChild(messageEl)

    if (this.description) {
      const descriptionEl = document.createElement('p')
      descriptionEl.textContent = this.description
      descriptionEl.classList.add('taskchute-confirm-description')
      contentEl.appendChild(descriptionEl)
    }

    const buttonGroup = document.createElement('div')
    buttonGroup.classList.add('taskchute-confirm-actions')
    contentEl.appendChild(buttonGroup)

    const cancelButton = document.createElement('button')
    cancelButton.textContent = this.cancelText
    cancelButton.classList.add('mod-cancel')
    cancelButton.addEventListener('click', () => {
      this.closeWith(false)
    })
    buttonGroup.appendChild(cancelButton)

    const confirmButton = document.createElement('button')
    confirmButton.textContent = this.confirmText
    confirmButton.classList.add('mod-cta')
    if (this.destructive) {
      confirmButton.classList.add('mod-danger')
    }
    confirmButton.addEventListener('click', () => {
      this.closeWith(true)
    })
    buttonGroup.appendChild(confirmButton)
  }

  onClose(): void {
    while (this.contentEl.firstChild) {
      this.contentEl.removeChild(this.contentEl.firstChild)
    }
    this.contentEl.classList.remove('taskchute-confirm-content')
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
