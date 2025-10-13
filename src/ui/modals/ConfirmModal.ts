import { App, Modal } from 'obsidian'

export interface ConfirmModalOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  description?: string
}

type CreateElOptions = {
  cls?: string | string[]
  text?: string
  type?: string
  attr?: Record<string, string>
}

const createElCompat = <K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  options?: CreateElOptions,
): HTMLElementTagNameMap[K] => {
  const maybeCreateEl = (parent as HTMLElement & {
    createEl?: (tagName: string, options?: Record<string, unknown>) => HTMLElement
  }).createEl
  if (typeof maybeCreateEl === 'function') {
    return maybeCreateEl.call(parent, tag, options as Record<string, unknown>) as HTMLElementTagNameMap[K]
  }
  const element = document.createElement(tag)
  if (options?.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : [options.cls]
    element.classList.add(...classes)
  }
  if (options?.text !== undefined) {
    element.textContent = options.text
  }
  if (options?.type !== undefined && 'type' in element) {
    ;(element as HTMLButtonElement).type = options.type
  }
  if (options?.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      element.setAttribute(key, value)
    })
  }
  parent.appendChild(element)
  return element
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
    if (typeof (contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      contentEl.empty()
    } else {
      while (contentEl.firstChild) {
        contentEl.removeChild(contentEl.firstChild)
      }
    }
    this.modalEl?.classList.add('taskchute-confirm-modal')

    const header = createElCompat(contentEl, 'div', { cls: 'modal-header' })
    createElCompat(header, 'h3', { text: this.titleText })

    const messageEl = createElCompat(contentEl, 'p', { cls: 'modal-message' })
    this.messageText.split('\n').forEach((line, index) => {
      if (index > 0) {
        createElCompat(messageEl, 'br')
      }
      messageEl.appendChild(document.createTextNode(line))
    })

    if (this.description) {
      const descriptionEl = createElCompat(contentEl, 'p', { cls: 'modal-description' })
      this.description.split('\n').forEach((line, index) => {
        if (index > 0) {
          createElCompat(descriptionEl, 'br')
        }
        descriptionEl.appendChild(document.createTextNode(line))
      })
    }

    const buttonGroup = createElCompat(contentEl, 'div', { cls: 'form-button-group' })
    buttonGroup.classList.add('confirm-button-group')

    const cancelButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'cancel'],
      text: this.cancelText,
    })
    cancelButton.addEventListener('click', () => {
      this.closeWith(false)
    })

    const confirmButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', this.destructive ? 'danger' : 'create'],
      text: this.confirmText,
    })
    confirmButton.addEventListener('click', () => {
      this.closeWith(true)
    })
  }

  onClose(): void {
    if (typeof (this.contentEl as HTMLElement & { empty?: () => void }).empty === 'function') {
      this.contentEl.empty()
    } else {
      while (this.contentEl.firstChild) {
        this.contentEl.removeChild(this.contentEl.firstChild)
      }
    }
    this.modalEl?.classList.remove('taskchute-confirm-modal')
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
