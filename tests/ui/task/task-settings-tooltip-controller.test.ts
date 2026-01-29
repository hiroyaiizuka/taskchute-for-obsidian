import TaskSettingsTooltipController, {
  type TaskSettingsTooltipHost,
} from '../../../src/ui/task/TaskSettingsTooltipController'
import TaskTimeController, {
  type TaskTimeControllerHost,
} from '../../../src/ui/time/TaskTimeController'
import type { TaskInstance } from '../../../src/types'
import { Notice } from 'obsidian'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

const NoticeMock = Notice as unknown as jest.Mock

const ensureCreateEl = () => {
  const proto = HTMLElement.prototype as unknown as {
    createEl?: (
      tag: string,
      options?: { cls?: string; text?: string; attr?: Record<string, string> }
    ) => HTMLElement
  }
  if (!proto.createEl) {
    proto.createEl = function (this: HTMLElement, tag: string, options = {}) {
      const element = document.createElement(tag)
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
      this.appendChild(element)
      return element
    }
  }
}

describe('TaskSettingsTooltipController', () => {
  beforeAll(() => {
    ensureCreateEl()
  })

  beforeEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    document.body.innerHTML = ''
    NoticeMock?.mockClear?.()
  })

  const createHost = (overrides: Partial<TaskSettingsTooltipHost> = {}): TaskSettingsTooltipHost => ({
    tv: (_key, fallback) => fallback,
    resetTaskToIdle: jest.fn().mockResolvedValue(undefined),
    showScheduledTimeEditModal: jest.fn().mockResolvedValue(undefined),
    showTaskMoveDatePicker: jest.fn(),
    duplicateInstance: jest.fn().mockResolvedValue(undefined),
    deleteRoutineTask: jest.fn().mockResolvedValue(undefined),
    deleteNonRoutineTask: jest.fn().mockResolvedValue(undefined),
    hasExecutionHistory: jest.fn().mockResolvedValue(false),
    showDeleteConfirmDialog: jest.fn().mockResolvedValue(true),
    ...overrides,
  })

  const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance => ({
    instanceId: 'inst-1',
    state: 'running',
    task: {
      path: 'Tasks/sample.md',
      isRoutine: false,
      name: 'Sample task',
      taskId: 'tc-task-sample',
    },
    ...overrides,
  }) as TaskInstance

  const queryTooltipItem = (text: string): HTMLElement => {
    const tooltip = document.querySelector('.task-settings-tooltip') as HTMLElement
    if (!tooltip) {
      throw new Error('tooltip not found')
    }
    const items = Array.from(tooltip.querySelectorAll<HTMLElement>('.tooltip-item'))
    const match = items.find((item) => item.textContent?.includes(text))
    if (!match) {
      throw new Error(`tooltip item not found for text: ${text}`)
    }
    return match
  }

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const createTimeController = () => {
  const saveRunningTasksState = jest.fn().mockResolvedValue(undefined)
  const removeTaskLog = jest.fn().mockResolvedValue(undefined)
  const host: TaskTimeControllerHost = {
    tv: (_key, fallback) => fallback,
    app: {
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
        read: jest.fn(async () => ''),
      },
      fileManager: {
        processFrontMatter: jest.fn(async () => {}),
      },
    },
    renderTaskList: jest.fn(),
    reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
    getInstanceDisplayTitle: () => 'Sample task',
    persistSlotAssignment: jest.fn(),
    executionLogService: {
      saveTaskLog: jest.fn().mockResolvedValue(undefined),
    },
    calculateCrossDayDuration: jest.fn(() => 0),
    saveRunningTasksState,

    stopInstance: jest.fn().mockResolvedValue(undefined),
    confirmStopNextDay: jest.fn().mockResolvedValue(true),
    setCurrentInstance: jest.fn(),
    startGlobalTimer: jest.fn(),
    restartTimerService: jest.fn(),
    removeTaskLogForInstanceOnCurrentDate: removeTaskLog,
    getCurrentDate: () => new Date('2025-10-09T00:00:00Z'),
  }

  const controller = new TaskTimeController(host)
  return { controller, host, saveRunningTasksState, removeTaskLog }
}

  test('duplicate action invokes host and closes tooltip', async () => {
    const host = createHost()
    const controller = new TaskSettingsTooltipController(host)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    const instance = createInstance()
    controller.show(instance, anchor)

    const duplicateItem = queryTooltipItem('Duplicate')
    duplicateItem.click()
    await flush()

    expect(host.duplicateInstance).toHaveBeenCalledTimes(1)
    expect(host.duplicateInstance).toHaveBeenCalledWith(instance)
    expect(document.querySelector('.task-settings-tooltip')).toBeNull()
  })

  test('delete routes to routine handler when routine or has history', async () => {
    const host = createHost({ hasExecutionHistory: jest.fn().mockResolvedValue(true) })
    const controller = new TaskSettingsTooltipController(host)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const instance = createInstance({
      task: { path: 'Tasks/routine.md', isRoutine: true, name: 'Routine' },
    })

    controller.show(instance, anchor)
    const deleteItem = queryTooltipItem('Delete')
    deleteItem.click()
    await flush()

    expect(host.showDeleteConfirmDialog).toHaveBeenCalledWith(instance)
    expect(host.deleteRoutineTask).toHaveBeenCalledTimes(1)
    expect(host.deleteRoutineTask).toHaveBeenCalledWith(instance)
    expect(host.deleteNonRoutineTask).not.toHaveBeenCalled()
  })

  test('delete routes to non routine handler when no history', async () => {
    const host = createHost({ hasExecutionHistory: jest.fn().mockResolvedValue(false) })
    const controller = new TaskSettingsTooltipController(host)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const instance = createInstance({ task: { path: 'Tasks/task.md', isRoutine: false, name: 'Task' } })

    controller.show(instance, anchor)
    const deleteItem = queryTooltipItem('Delete')
    deleteItem.click()
    await flush()

    expect(host.showDeleteConfirmDialog).toHaveBeenCalledWith(instance)
    expect(host.deleteNonRoutineTask).toHaveBeenCalledTimes(1)
    expect(host.deleteRoutineTask).not.toHaveBeenCalled()
  })

  test('reset item disables itself for idle tasks', () => {
    const host = createHost()
    const controller = new TaskSettingsTooltipController(host)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const instance = createInstance({ state: 'idle' })

    controller.show(instance, anchor)
    const resetItem = queryTooltipItem('Reset')
    expect(resetItem.classList.contains('disabled')).toBe(true)
    resetItem.click()
    expect(host.resetTaskToIdle).not.toHaveBeenCalled()
  })

  test('move action opens date picker and tooltip cleans up on outside click', () => {
    jest.useFakeTimers()
    const host = createHost()
    const controller = new TaskSettingsTooltipController(host)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const instance = createInstance()

    controller.show(instance, anchor)
    const moveItem = queryTooltipItem('Move task')
    moveItem.click()
    expect(host.showTaskMoveDatePicker).toHaveBeenCalledWith(instance, anchor)

    jest.runOnlyPendingTimers()
    document.body.click()
    expect(document.querySelector('.task-settings-tooltip')).toBeNull()
    jest.useRealTimers()
  })

  test('show replaces existing tooltip', () => {
    const host = createHost()
    const controller = new TaskSettingsTooltipController(host)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)

    controller.show(createInstance(), anchor)
    const first = document.querySelectorAll('.task-settings-tooltip')
    expect(first).toHaveLength(1)

    const anchor2 = document.createElement('button')
    document.body.appendChild(anchor2)
    controller.show(createInstance({ instanceId: 'inst-2' }), anchor2)
    const tooltips = document.querySelectorAll('.task-settings-tooltip')
    expect(tooltips).toHaveLength(1)
    expect(host.duplicateInstance).not.toHaveBeenCalled()
  })

  test('reset action delegates to TaskTimeController', async () => {
    const { controller: timeController, saveRunningTasksState, removeTaskLog, host: timeHost } =
      createTimeController()
    const host = createHost({
      resetTaskToIdle: (inst) => timeController.resetTaskToIdle(inst),
      showScheduledTimeEditModal: (inst) => timeController.showScheduledTimeEditModal(inst),
    })
    const controller = new TaskSettingsTooltipController(host)
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const instance = createInstance({
      state: 'running',
      startTime: new Date('2025-10-09T08:00:00Z'),
      stopTime: new Date('2025-10-09T09:00:00Z'),
    })

    controller.show(instance, anchor)
    const resetItem = queryTooltipItem('Reset to not started')
    resetItem.click()
    await flush()

    expect(saveRunningTasksState).toHaveBeenCalledTimes(1)
    expect(removeTaskLog).toHaveBeenCalledWith(instance.instanceId, instance.task?.taskId)
    expect(timeHost.renderTaskList).toHaveBeenCalledTimes(1)
    expect(instance.state).toBe('idle')
    expect(instance.startTime).toBeUndefined()
    expect(document.querySelector('.task-settings-tooltip')).toBeNull()
  })
})
