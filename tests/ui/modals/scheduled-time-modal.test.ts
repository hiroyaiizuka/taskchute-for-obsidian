import { Notice, TFile } from 'obsidian'
import type { TaskInstance } from '../../../src/types'
import ScheduledTimeModal from '../../../src/ui/modals/ScheduledTimeModal'

jest.mock('obsidian', () => {
  const applyDomHelpers = (el: HTMLElement) => {
    ;(el as unknown as { empty: () => void }).empty = function empty() {
      while (this.firstChild) {
        this.removeChild(this.firstChild)
      }
    }

    ;(el as unknown as {
      createEl: (
        tag: string,
        options?: {
          cls?: string | string[]
          text?: string
          type?: string
          attr?: Record<string, string>
          value?: string
        },
      ) => HTMLElement
    }).createEl = function createEl(tag: string, options = {}) {
      const child = document.createElement(tag)
      applyDomHelpers(child)

      const cls = options.cls
      if (cls) {
        const classes = Array.isArray(cls) ? cls : cls.split(/\s+/).filter(Boolean)
        child.classList.add(...classes)
      }
      if (typeof options.text === 'string') {
        child.textContent = options.text
      }
      if (options.type) {
        ;(child as HTMLInputElement).type = options.type
      }
      if (typeof options.value === 'string') {
        ;(child as HTMLInputElement).value = options.value
      }
      if (options.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          child.setAttribute(key, value)
        })
      }

      this.appendChild(child)
      return child
    }
  }

  class MockApp {}
  class Modal {
    app: MockApp
    modalEl: HTMLElement
    contentEl: HTMLElement

    constructor(app: MockApp) {
      this.app = app
      this.modalEl = document.createElement('div')
      this.modalEl.classList.add('modal')
      applyDomHelpers(this.modalEl)
      this.contentEl = document.createElement('div')
      applyDomHelpers(this.contentEl)
      this.modalEl.appendChild(this.contentEl)
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
    Notice: jest.fn(),
    TFile: class MockTFile {},
  }
})

jest.mock('../../../src/utils/fieldMigration', () => {
  return {
    getScheduledTime: jest.fn(() => '08:30'),
    setScheduledTime: jest.fn(),
  }
})

const { getScheduledTime, setScheduledTime } = jest.requireMock('../../../src/utils/fieldMigration') as {
  getScheduledTime: jest.Mock<string, [Record<string, unknown>]>
  setScheduledTime: jest.Mock<void, [Record<string, unknown>, string | undefined, { preferNew: boolean }]>
}

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('ScheduledTimeModal', () => {
  const createHost = () => {
    const file = new TFile()
    return {
      tv: (_key: string, fallback: string, vars?: Record<string, string | number>) => {
        if (vars && vars.time) {
          return fallback.replace('{time}', String(vars.time))
        }
        return fallback
      },
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(() => file),
          read: jest.fn(),
        },
        fileManager: {
          processFrontMatter: jest.fn(async (_: TFile, updater: (frontmatter: Record<string, unknown>) => void) => {
            const fm: Record<string, unknown> = {}
            updater(fm)
          }),
        },
      },
      reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
    }
  }

  const createInstance = (): TaskInstance => ({
    task: {
      path: 'Tasks/sample.md',
      frontmatter: {},
      name: 'sample',
    },
  } as TaskInstance)

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
    getScheduledTime.mockClear()
    setScheduledTime.mockClear()
    document.body.innerHTML = ''
  })

  test('initializes input with scheduled time and saves new value', async () => {
    const host = createHost()
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const input = document.querySelector('.scheduled-time-form input[type="time"]') as HTMLInputElement
    expect(input.value).toBe('08:30')

    input.value = '09:15'
    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(host.app.vault.getAbstractFileByPath).toHaveBeenCalledWith('Tasks/sample.md')
    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(setScheduledTime).toHaveBeenCalledWith(expect.any(Object), '09:15', { preferNew: true })
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: true })
    expect(Notice).toHaveBeenCalled()
    expect(document.querySelector('.scheduled-time-modal')).toBeNull()
  })

  test('clearing value removes scheduled time', async () => {
    const host = createHost()
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const input = document.querySelector('.scheduled-time-form input[type="time"]') as HTMLInputElement
    input.value = ''
    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(setScheduledTime).toHaveBeenCalledWith(expect.any(Object), undefined, { preferNew: true })
  })

  test('shows notice when task file is missing', async () => {
    const host = createHost()
    host.app.vault.getAbstractFileByPath = jest.fn(() => null)
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(Notice).toHaveBeenCalled()
    expect(host.app.fileManager.processFrontMatter).not.toHaveBeenCalled()
  })
})
