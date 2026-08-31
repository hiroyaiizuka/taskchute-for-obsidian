import { App, Modal } from 'obsidian'
import { createElCompat } from '../components/domCompat'
import { createModalFooter } from '../components/modalFooter'

export type DisambiguateChoice = 'same-day' | 'next-day' | 'cancel'

export interface DisambiguateStopTimeDateOptions {
  sameDayDate: Date
  nextDayDate: Date
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
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
    this.modalEl?.classList.add('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-confirm-modal')

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

    // Both dates are affirmative answers, so both are primaries. Declaring the
    // same day last puts it in the row's primary position on either platform:
    // right-most in the desktop row, top-most in the phone's reversed stack.
    const {
      buttons: [, , sameDayButton],
    } = createModalFooter(contentEl, [
      {
        text: tv('common.cancel', 'Cancel'),
        role: 'cancel',
        onClick: () => {
          this.closeWith('cancel')
        },
      },
      {
        text: tv('forms.disambiguateStopTimeNextDay', '{date} (next day)', {
          date: formatDateForDisplay(nextDayDate),
        }),
        role: 'primary',
        onClick: () => {
          this.closeWith('next-day')
        },
      },
      {
        text: tv('forms.disambiguateStopTimeSameDay', '{date} (same day)', {
          date: formatDateForDisplay(sameDayDate),
        }),
        role: 'primary',
        onClick: () => {
          this.closeWith('same-day')
        },
      },
    ])

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
    this.modalEl?.classList.remove('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-confirm-modal')
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
