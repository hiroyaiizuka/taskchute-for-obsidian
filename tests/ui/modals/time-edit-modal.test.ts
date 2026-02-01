import { App, Notice } from 'obsidian'
import type { TaskInstance } from '../../../src/types'
import TimeEditModal from '../../../src/ui/modals/TimeEditModal'
import { showConfirmModal } from '../../../src/ui/modals/ConfirmModal'

type TimeEditModalCallbacks = Required<
  Exclude<ConstructorParameters<typeof TimeEditModal>[0], undefined>['callbacks']
>

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
  }
})

jest.mock('../../../src/ui/modals/ConfirmModal', () => ({
  showConfirmModal: jest.fn(() => Promise.resolve(true)),
}))


describe('TimeEditModal', () => {
  const createHost = () => ({
    tv: (_key: string, fallback: string) => fallback,
    getInstanceDisplayTitle: () => 'Sample Task',
  })

  const createCallbacks = (): TimeEditModalCallbacks => ({
    resetTaskToIdle: jest.fn().mockResolvedValue(undefined),
    updateRunningInstanceStartTime: jest.fn().mockResolvedValue(undefined),
    transitionToRunningWithStart: jest.fn().mockResolvedValue(undefined),
    updateInstanceTimes: jest.fn().mockResolvedValue(undefined),
  })

  const openModal = (instance: TaskInstance, callbacks: TimeEditModalCallbacks) => {
    const modal = new TimeEditModal({
      app: new App(),
      host: createHost(),
      instance,
      callbacks,
    })
    modal.open()
    return modal
  }

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
    document.body.innerHTML = ''
    ;(showConfirmModal as jest.MockedFunction<typeof showConfirmModal>).mockReset()
  })

  test('running task: clearing start resets to idle', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'running',
      startTime: new Date('2025-10-10T02:00:00Z'),
    } as TaskInstance

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    startInput.value = ''

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(callbacks.resetTaskToIdle).toHaveBeenCalledTimes(1)
    expect(callbacks.updateRunningInstanceStartTime).not.toHaveBeenCalled()
  })

  test('running task: saving start time calls updateRunningInstanceStartTime', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'running',
      startTime: new Date('2025-10-10T02:00:00Z'),
    } as TaskInstance

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    startInput.value = '03:45'

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(callbacks.updateRunningInstanceStartTime).toHaveBeenCalledWith('03:45')
    expect(callbacks.resetTaskToIdle).not.toHaveBeenCalled()
  })

  test('done task: clearing both times resets to idle', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'done',
      startTime: new Date('2025-10-10T02:00:00Z'),
      stopTime: new Date('2025-10-10T03:30:00Z'),
    } as TaskInstance

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    const stopInput = form.querySelectorAll('input[type="time"]')[1] as HTMLInputElement
    startInput.value = ''
    stopInput.value = ''

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(callbacks.resetTaskToIdle).toHaveBeenCalledTimes(1)
    expect(callbacks.transitionToRunningWithStart).not.toHaveBeenCalled()
    expect(callbacks.updateInstanceTimes).not.toHaveBeenCalled()
  })

  test('done task: clearing stop only transitions to running', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'done',
      startTime: new Date('2025-10-10T02:00:00Z'),
      stopTime: new Date('2025-10-10T03:30:00Z'),
    } as TaskInstance

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    const stopInput = form.querySelectorAll('input[type="time"]')[1] as HTMLInputElement
    startInput.value = '02:15'
    stopInput.value = ''

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(callbacks.transitionToRunningWithStart).toHaveBeenCalledWith('02:15')
    expect(callbacks.resetTaskToIdle).not.toHaveBeenCalled()
    expect(callbacks.updateInstanceTimes).not.toHaveBeenCalled()
  })

  test('done task: earlier stop time asks for confirmation and cancels when declined', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'done',
      startTime: new Date('2025-10-10T08:00:00Z'),
      stopTime: new Date('2025-10-10T09:00:00Z'),
    } as TaskInstance

    const confirmMock = showConfirmModal as jest.MockedFunction<typeof showConfirmModal>
    confirmMock.mockResolvedValueOnce(false)

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    const stopInput = form.querySelectorAll('input[type="time"]')[1] as HTMLInputElement
    startInput.value = '08:00'
    stopInput.value = '07:00'

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(Notice).toHaveBeenCalled()
    expect(callbacks.updateInstanceTimes).not.toHaveBeenCalled()
  })

  test('done task: earlier stop time proceeds when confirmation accepted', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'done',
      startTime: new Date('2025-10-10T08:00:00Z'),
      stopTime: new Date('2025-10-10T09:00:00Z'),
    } as TaskInstance

    const confirmMock = showConfirmModal as jest.MockedFunction<typeof showConfirmModal>
    confirmMock.mockResolvedValueOnce(true)

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    const stopInput = form.querySelectorAll('input[type="time"]')[1] as HTMLInputElement
    startInput.value = '08:00'
    stopInput.value = '07:00'

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(callbacks.updateInstanceTimes).toHaveBeenCalledWith('08:00', '07:00')
    expect(Notice).not.toHaveBeenCalled()
  })

  test('done task: cross-day adjustment skips confirmation', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'done',
      startTime: new Date(2025, 9, 10, 23, 0, 0, 0),
      stopTime: new Date(2025, 9, 11, 8, 0, 0, 0),
    } as TaskInstance

    const confirmMock = showConfirmModal as jest.MockedFunction<typeof showConfirmModal>

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    const stopInput = form.querySelectorAll('input[type="time"]')[1] as HTMLInputElement
    startInput.value = '23:00'
    stopInput.value = '00:30'

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(confirmMock).not.toHaveBeenCalled()
    expect(callbacks.updateInstanceTimes).toHaveBeenCalledWith('23:00', '00:30')
  })

  test('done task: valid times call updateInstanceTimes', async () => {
    const callbacks = createCallbacks()
    const instance = {
      state: 'done',
      startTime: new Date('2025-10-10T02:00:00Z'),
      stopTime: new Date('2025-10-10T03:30:00Z'),
    } as TaskInstance

    openModal(instance, callbacks)

    const form = document.querySelector('.time-edit-form') as HTMLFormElement
    const startInput = form.querySelector('input[type="time"]') as HTMLInputElement
    const stopInput = form.querySelectorAll('input[type="time"]')[1] as HTMLInputElement
    startInput.value = '02:15'
    stopInput.value = '03:45'

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()

    expect(callbacks.updateInstanceTimes).toHaveBeenCalledWith('02:15', '03:45')
    expect(callbacks.resetTaskToIdle).not.toHaveBeenCalled()
  })
})
