import TaskRowController, { TaskRowControllerHost } from '../../../src/ui/task-list/TaskRowController'
import type { TaskInstance } from '../../../src/types'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

describe('TaskRowController', () => {
  const attachCreateEl = (target: HTMLElement) => {
    const typed = target as HTMLElement & { createEl?: typeof attachCreateEl }
    typed.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const el = document.createElement(tag)
      if (options.cls) {
        el.className = options.cls as string
      }
      if (options.text) {
        el.textContent = options.text as string
      }
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          el.setAttribute(key, value)
        })
      }
      attachCreateEl(el)
      this.appendChild(el)
      return el
    }
  }

  const createHost = (overrides: Partial<TaskRowControllerHost> = {}): TaskRowControllerHost => ({
    tv: (_key, fallback) => fallback,
    startInstance: jest.fn(),
    stopInstance: jest.fn(),
    duplicateAndStartInstance: jest.fn(),
    showTimeEditModal: jest.fn(),
    calculateCrossDayDuration: (start: Date, stop: Date) => stop.getTime() - start.getTime(),
    app: {
      workspace: {
        openLinkText: jest.fn(),
      },
    },
    ...overrides,
  })

  const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance => ({
    task: {
      name: 'Sample',
      path: 'Tasks/sample.md',
      isRoutine: false,
    },
    state: 'idle',
    slotKey: 'none',
    ...overrides,
  }) as TaskInstance

  beforeEach(() => {
    document.body.innerHTML = ''
    jest.clearAllMocks()
  })

  test('renderPlayStopButton respects future task guard', () => {
    const host = createHost()
    const controller = new TaskRowController(host)
    const container = document.createElement('div')
    attachCreateEl(container)
    const inst = createInstance({ state: 'idle' })

    controller.renderPlayStopButton(container, inst, true)
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(true)
    button.click()
    expect(host.startInstance).not.toHaveBeenCalled()
  })

  test('renderPlayStopButton triggers start/stop/duplicate', () => {
    const host = createHost()
    const controller = new TaskRowController(host)
    const container = document.createElement('div')
    attachCreateEl(container)

    const idle = createInstance({ state: 'idle' })
    controller.renderPlayStopButton(container, idle, false)
    container.querySelector('button')?.click()
    expect(host.startInstance).toHaveBeenCalledWith(idle)

    container.innerHTML = ''
    controller.renderPlayStopButton(container, createInstance({ state: 'running' }), false)
    container.querySelector('button')?.click()
    expect(host.stopInstance).toHaveBeenCalled()

    container.innerHTML = ''
    controller.renderPlayStopButton(container, createInstance({ state: 'done' }), false)
    container.querySelector('button')?.click()
    expect(host.duplicateAndStartInstance).toHaveBeenCalled()
  })

  test('renderTaskName opens task path and handles failure', async () => {
    const openLinkText = jest.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue(undefined)
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const host = createHost({ app: { workspace: { openLinkText } } })
    const controller = new TaskRowController(host)
    const container = document.createElement('div')
    attachCreateEl(container)
    controller.renderTaskName(container, createInstance())
    const nameEl = container.querySelector('.task-name') as HTMLElement
    expect(nameEl).toBeTruthy()
    await nameEl.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(openLinkText).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('renderTimeRangeDisplay marks editable spans', () => {
    const host = createHost({ showTimeEditModal: jest.fn() })
    const controller = new TaskRowController(host)
    const container = document.createElement('div')
    attachCreateEl(container)
    const inst = createInstance({ startTime: new Date(2025, 9, 9, 8, 0, 0), stopTime: new Date(2025, 9, 9, 9, 0, 0) })

    controller.renderTimeRangeDisplay(container, inst)
    const range = container.querySelector('.task-time-range') as HTMLElement
    expect(range?.textContent).toContain('08:00')
    range?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(host.showTimeEditModal).toHaveBeenCalledWith(inst)
  })

  test('renderDurationDisplay renders timer for running tasks', () => {
    jest.useFakeTimers().setSystemTime(new Date('2025-10-09T08:05:15Z'))
    const host = createHost({ calculateCrossDayDuration: jest.fn(() => 3600000) })
    const controller = new TaskRowController(host)
    const container = document.createElement('div')
    attachCreateEl(container)
    const running = createInstance({ state: 'running', startTime: new Date('2025-10-09T08:00:00Z') })

    controller.renderDurationDisplay(container, running)
    const timer = container.querySelector('.task-timer-display') as HTMLElement
    expect(timer).toBeTruthy()
    controller.updateTimerDisplay(timer, running)
    expect(timer.textContent).toMatch(/00:05:1[45]/)
    jest.useRealTimers()
  })
})
