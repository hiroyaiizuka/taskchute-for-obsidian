import { App, Modal } from 'obsidian'

export type DisambiguateChoice = 'same-day' | 'next-day' | 'cancel'

export interface DisambiguateStopTimeDateOptions {
  sameDayDate: Date
  nextDayDate: Date
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
}

type CreateElOptions = {
  cls?: string | string[]
  text?: string
  type?: 'button' | 'reset' | 'submit'
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
  parent.appendChild(element)
  return element
}

function formatDateForDisplay(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${m}/${d} ${hh}:${mm}`
}

class DisambiguateStopTimeDateModal extends Modal {
  private readonly resolve: (value: DisambiguateChoice) => void
  private readonly options: DisambiguateStopTimeDateOptions
  private resolved = false

  constructor(app: App, options: DisambiguateStopTimeDateOptions, resolve: (value: DisambiguateChoice) => void) {
    super(app)
    this.resolve = resolve
    this.options = options
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

    const { tv, sameDayDate, nextDayDate } = this.options

    const header = createElCompat(contentEl, 'div', { cls: 'modal-header' })
    createElCompat(header, 'h3', {
      text: tv('forms.disambiguateStopTimeDateTitle', 'Select stop time date'),
    })

    createElCompat(contentEl, 'p', {
      cls: 'modal-message',
      text: tv(
        'forms.disambiguateStopTimeDateMessage',
        'The stop time you entered could apply to the start day or the next day.',
      ),
    })

    const buttonGroup = createElCompat(contentEl, 'div', { cls: 'form-button-group' })
    buttonGroup.classList.add('confirm-button-group')

    const sameDayLabel = tv('forms.disambiguateStopTimeSameDay', '{date} (same day)', {
      date: formatDateForDisplay(sameDayDate),
    })
    const sameDayButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'create'],
      text: sameDayLabel,
    })
    sameDayButton.addEventListener('click', () => {
      this.closeWith('same-day')
    })

    const nextDayLabel = tv('forms.disambiguateStopTimeNextDay', '{date} (next day)', {
      date: formatDateForDisplay(nextDayDate),
    })
    const nextDayButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'create'],
      text: nextDayLabel,
    })
    nextDayButton.addEventListener('click', () => {
      this.closeWith('next-day')
    })

    const cancelButton = createElCompat(buttonGroup, 'button', {
      type: 'button',
      cls: ['form-button', 'cancel'],
      text: tv('common.cancel', 'Cancel'),
    })
    cancelButton.addEventListener('click', () => {
      this.closeWith('cancel')
    })

    sameDayButton.focus()
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
    this.resolveOnce('cancel')
  }

  private closeWith(result: DisambiguateChoice): void {
    this.resolveOnce(result)
    this.close()
  }

  private resolveOnce(result: DisambiguateChoice): void {
    if (this.resolved) return
    this.resolved = true
    this.resolve(result)
  }
}

export function showDisambiguateStopTimeDateModal(
  app: App,
  options: DisambiguateStopTimeDateOptions,
): Promise<DisambiguateChoice> {
  return new Promise((resolve) => {
    const modal = new DisambiguateStopTimeDateModal(app, options, resolve)
    modal.open()
  })
}
