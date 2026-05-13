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

const setActiveDocument = (doc: Document): void => {
  ;(globalThis as typeof globalThis & { activeDocument: Document }).activeDocument = doc
}

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

  describe('project menu item', () => {
    test('appendProject renders menu item when host supports showProjectModal', () => {
      const showProjectModal = jest.fn()
      const host = createHost({ showProjectModal })
      const controller = new TaskSettingsTooltipController(host)
      const anchor = document.createElement('button')
      document.body.appendChild(anchor)
      const instance = createInstance()

      controller.show(instance, anchor)

      const tooltip = document.querySelector('.task-settings-tooltip') as HTMLElement
      const items = Array.from(tooltip.querySelectorAll<HTMLElement>('.tooltip-item'))
      const projectItem = items.find((item) => item.textContent?.includes('project'))
      expect(projectItem).toBeTruthy()
    })

    test('appendProject invokes showProjectModal on click and closes tooltip', async () => {
      const showProjectModal = jest.fn()
      const host = createHost({ showProjectModal })
      const controller = new TaskSettingsTooltipController(host)
      const anchor = document.createElement('button')
      document.body.appendChild(anchor)
      const instance = createInstance()

      controller.show(instance, anchor)
      const tooltip = document.querySelector('.task-settings-tooltip') as HTMLElement
      const items = Array.from(tooltip.querySelectorAll<HTMLElement>('.tooltip-item'))
      const projectItem = items.find((item) => item.textContent?.includes('project'))
      projectItem?.click()
      await flush()

      expect(showProjectModal).toHaveBeenCalledWith(instance)
      expect(document.querySelector('.task-settings-tooltip')).toBeNull()
    })

    test('appendProject is not rendered when host lacks showProjectModal', () => {
      const host = createHost({ showProjectModal: undefined })
      const controller = new TaskSettingsTooltipController(host)
      const anchor = document.createElement('button')
      document.body.appendChild(anchor)
      const instance = createInstance()

      controller.show(instance, anchor)

      const tooltip = document.querySelector('.task-settings-tooltip') as HTMLElement
      const items = Array.from(tooltip.querySelectorAll<HTMLElement>('.tooltip-item'))
      const projectItem = items.find((item) => item.textContent?.includes('project'))
      expect(projectItem).toBeUndefined()
    })
  })

  describe('recipe menu item', () => {
    test('does not render when recipe feature is disabled', () => {
      const showRecipeSelectModal = jest.fn()
      const host = createHost({
        showRecipeSelectModal,
        isRecipeFeatureEnabled: jest.fn(() => false),
      })
      const controller = new TaskSettingsTooltipController(host)
      const anchor = document.createElement('button')
      document.body.appendChild(anchor)
      const instance = createInstance({
        task: {
          path: 'Tasks/sample.md',
          name: 'Sample task',
          recipePath: 'TaskChute/Recipes/Gym.md',
        },
      })

      controller.show(instance, anchor)

      const tooltip = document.querySelector('.task-settings-tooltip') as HTMLElement
      expect(tooltip.textContent).not.toContain('レシピ')
    })

    test('shows set recipe when linked recipe is no longer available', () => {
      const showRecipeSelectModal = jest.fn()
      const host = createHost({
        showRecipeSelectModal,
        hasRecipeAssigned: jest.fn(() => false),
      })
      const controller = new TaskSettingsTooltipController(host)
      const anchor = document.createElement('button')
      document.body.appendChild(anchor)
      const instance = createInstance({
        task: {
          path: 'Tasks/sample.md',
          name: 'Sample task',
          recipePath: 'TaskChute/Recipes/Missing.md',
        },
      })

      controller.show(instance, anchor)

      expect(queryTooltipItem('レシピを設定')).toBeTruthy()
      const tooltip = document.querySelector('.task-settings-tooltip') as HTMLElement
      expect(tooltip.textContent).not.toContain('レシピを変更')
    })

    test('shows change recipe when linked recipe is available', () => {
      const showRecipeSelectModal = jest.fn()
      const host = createHost({
        showRecipeSelectModal,
        hasRecipeAssigned: jest.fn(() => true),
      })
      const controller = new TaskSettingsTooltipController(host)
      const anchor = document.createElement('button')
      document.body.appendChild(anchor)
      const instance = createInstance({
        task: {
          path: 'Tasks/sample.md',
          name: 'Sample task',
          recipePath: 'TaskChute/Recipes/Gym.md',
        },
      })

      controller.show(instance, anchor)

      expect(queryTooltipItem('レシピを変更')).toBeTruthy()
    })
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

  test('positions tooltip using the active document window', () => {
    const originalActiveDocument = activeDocument
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const popoutDocument = iframe.contentDocument
    const popoutWindow = iframe.contentWindow
    if (!popoutDocument || !popoutWindow) {
      throw new Error('iframe window unavailable')
    }
    Object.defineProperty(popoutWindow, 'innerWidth', { configurable: true, value: 120 })
    Object.defineProperty(popoutWindow, 'innerHeight', { configurable: true, value: 100 })
    const anchor = popoutDocument.createElement('button')
    popoutDocument.body.appendChild(anchor)
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 80,
        right: 110,
        bottom: 90,
        left: 100,
        width: 10,
        height: 10,
        x: 100,
        y: 80,
        toJSON: () => ({}),
      } as DOMRect),
    })
    const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('task-settings-tooltip')) {
        return {
          top: 0,
          right: 50,
          bottom: 40,
          left: 0,
          width: 50,
          height: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect
      }
      return {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
    const host = createHost()
    const controller = new TaskSettingsTooltipController(host)

    try {
      setActiveDocument(popoutDocument)
      controller.show(createInstance(), anchor)

      const tooltip = popoutDocument.querySelector<HTMLElement>('.task-settings-tooltip')
      expect(tooltip?.style.getPropertyValue('--taskchute-tooltip-left')).toBe('60px')
      expect(tooltip?.style.getPropertyValue('--taskchute-tooltip-top')).toBe('35px')
    } finally {
      popoutDocument.querySelector('.task-settings-tooltip')?.remove()
      setActiveDocument(originalActiveDocument)
      rectSpy.mockRestore()
      iframe.remove()
    }
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
