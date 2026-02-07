import { App } from 'obsidian'
import { showDisambiguateStopTimeDateModal } from '../../../src/ui/modals/DisambiguateStopTimeDateModal'

jest.mock('obsidian', () => {
  class MockApp {}

  class Modal {
    static lastModal: Modal | null = null
    app: MockApp
    modalEl: HTMLElement
    contentEl: HTMLElement

    constructor(app: MockApp) {
      this.app = app
      this.modalEl = document.createElement('div')
      this.contentEl = document.createElement('div')
      this.modalEl.appendChild(this.contentEl)
      Modal.lastModal = this
    }

    open(): void {
      document.body.appendChild(this.modalEl)
      const maybeOnOpen = (this as unknown as { onOpen?: () => void }).onOpen
      if (typeof maybeOnOpen === 'function') {
        maybeOnOpen.call(this)
      }
    }

    close(): void {
      const maybeOnClose = (this as unknown as { onClose?: () => void }).onClose
      if (typeof maybeOnClose === 'function') {
        maybeOnClose.call(this)
      }
      if (this.modalEl.parentElement) {
        this.modalEl.parentElement.removeChild(this.modalEl)
      }
    }
  }

  return {
    App: MockApp,
    Modal,
    __getLastModal: () => Modal.lastModal,
  }
})

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 50): Promise<T> => {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        if (error instanceof Error) {
          reject(error)
          return
        }
        reject(new Error(String(error)))
      },
    )
  })
}

describe('DisambiguateStopTimeDateModal', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('resolves cancel when closed implicitly without button click', async () => {
    const promise = showDisambiguateStopTimeDateModal(new App(), {
      sameDayDate: new Date(2025, 9, 1, 22, 30, 0, 0),
      nextDayDate: new Date(2025, 9, 2, 22, 30, 0, 0),
      tv: (_key, fallback, vars) => {
        if (vars && vars.date) {
          return fallback.replace('{date}', String(vars.date))
        }
        return fallback
      },
    })

    const modal = jest.requireMock('obsidian').__getLastModal()
    expect(modal).toBeTruthy()

    modal?.close()

    await expect(withTimeout(promise)).resolves.toBe('cancel')
  })
})
