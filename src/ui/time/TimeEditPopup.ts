import { Notice } from 'obsidian'

export interface TimeEditPopupOptions {
  anchor: HTMLElement
  currentValue: string
  viewDate: Date
  validationDate?: Date
  tv?: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  onSave: (value: string) => void
  onCancel: () => void
}

export default class TimeEditPopup {
  private containerEl: HTMLDivElement | null = null
  private removeClickAway: (() => void) | null = null

  show(options: TimeEditPopupOptions): void {
    this.close()

    const { anchor, currentValue, viewDate, validationDate, onSave, onCancel } = options

    const container = document.createElement('div')
    container.classList.add('taskchute-time-popup')
    this.containerEl = container

    const input = document.createElement('input')
    input.type = 'time'
    input.value = currentValue
    input.classList.add('taskchute-time-popup-input')
    container.appendChild(input)

    // Position below anchor
    document.body.appendChild(container)
    const rect = anchor.getBoundingClientRect()
    container.style.setProperty('--time-popup-left', `${rect.left}px`)
    container.style.setProperty('--time-popup-top', `${rect.bottom + 4}px`)

    // Validation helper
    const isSameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()

    const validationBase = validationDate ?? viewDate
    const isValidationDateToday = isSameDay(validationBase, new Date())

    const toMinutes = (value: string): number => {
      const [hours, minutes] = value.split(':').map((n) => parseInt(n, 10))
      return hours * 60 + minutes
    }

    const handleSave = () => {
      const val = input.value.trim()
      if (val && isValidationDateToday) {
        const now = new Date()
        const nowMinutes = now.getHours() * 60 + now.getMinutes()
        if (toMinutes(val) > nowMinutes) {
          const message = options.tv
            ? options.tv('forms.timeNotFuture', 'Time cannot be in the future')
            : 'Time cannot be in the future'
          new Notice(message)
          return
        }
      }
      onSave(val)
      this.close()
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSave()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        this.close()
      }
    })

    // Click-away to save
    const clickAway = (e: MouseEvent) => {
      if (this.containerEl && !this.containerEl.contains(e.target as Node)) {
        handleSave()
      }
    }
    setTimeout(() => {
      document.addEventListener('click', clickAway, true)
    }, 0)
    this.removeClickAway = () => document.removeEventListener('click', clickAway, true)

    input.focus()
  }

  close(): void {
    if (this.removeClickAway) {
      this.removeClickAway()
      this.removeClickAway = null
    }
    if (this.containerEl) {
      this.containerEl.remove()
      this.containerEl = null
    }
  }
}
