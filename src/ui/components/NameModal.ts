import { attachCloseButtonIcon } from './iconUtils'

export interface NameModalOptions {
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
  closeButton: HTMLButtonElement
  close: () => void
  onClose: (handler: () => void) => void
}

function appendEl<T extends HTMLElement>(parent: HTMLElement, tag: string, options: {
  cls?: string
  text?: string
  attr?: Record<string, string>
} = {}): T {
  const element = document.createElement(tag) as T
  if (options.cls) {
    element.classList.add(...options.cls.split(' ').filter(Boolean))
  }
  if (options.text !== undefined) {
    element.textContent = options.text
  }
  if (options.attr) {
    Object.entries(options.attr).forEach(([key, value]) => {
      if (value !== undefined) {
        element.setAttribute(key, value)
      }
    })
  }
  parent.appendChild(element)
  return element
}

export function createNameModal(options: NameModalOptions): NameModalHandle {
  const overlay = document.createElement('div')
  overlay.className = 'task-modal-overlay'

  const content = appendEl<HTMLDivElement>(overlay, 'div', { cls: 'task-modal-content' })

  const header = appendEl<HTMLDivElement>(content, 'div', { cls: 'modal-header' })
  appendEl<HTMLHeadingElement>(header, 'h3', { text: options.title })
  const closeButton = appendEl<HTMLButtonElement>(header, 'button', {
    cls: 'modal-close-button',
    attr: {
      'aria-label': options.closeLabel,
      title: options.closeLabel,
      type: 'button',
    },
  })
  attachCloseButtonIcon(closeButton)

  const form = appendEl<HTMLFormElement>(content, 'form', { cls: 'task-form' })
  const inputGroup = appendEl<HTMLDivElement>(form, 'div', { cls: 'form-group' })
  appendEl<HTMLLabelElement>(inputGroup, 'label', {
    text: options.label,
    cls: 'form-label',
  })
  const input = appendEl<HTMLInputElement>(inputGroup, 'input', {
    cls: 'form-input',
    attr: { type: 'text', placeholder: options.placeholder },
  })

  const warning = appendEl<HTMLDivElement>(inputGroup, 'div', {
    cls: 'task-name-warning hidden',
    attr: { role: 'alert', 'aria-live': 'polite' },
  })

  const buttonGroup = appendEl<HTMLDivElement>(form, 'div', { cls: 'form-button-group' })
  const cancelButton = appendEl<HTMLButtonElement>(buttonGroup, 'button', {
    cls: 'form-button cancel',
    text: options.cancelText,
    attr: { type: 'button' },
  })
  const submitButton = appendEl<HTMLButtonElement>(buttonGroup, 'button', {
    cls: 'form-button create',
    text: options.submitText,
    attr: { type: 'submit' },
  })

  const closeHandlers: Array<() => void> = []
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    closeHandlers.forEach((handler) => {
      try {
        handler()
      } catch (error) {
        console.error('[NameModal] Close handler failed', error)
      }
    })
    if (overlay.parentElement) {
      overlay.parentElement.removeChild(overlay)
    }
  }

  const registerCloseHandler = (handler: () => void) => {
    closeHandlers.push(handler)
  }

  closeButton.addEventListener('click', close)
  cancelButton.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close()
    }
  })

  document.body.appendChild(overlay)
  input.focus()

  return {
    overlay,
    content,
    form,
    inputGroup,
    input,
    warning,
    submitButton,
    cancelButton,
    closeButton,
    close,
    onClose: registerCloseHandler,
  }
}
