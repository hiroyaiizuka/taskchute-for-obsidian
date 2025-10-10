import { Notice } from 'obsidian'
import TaskTimeController, { TaskTimeControllerHost } from '../../../src/ui/time/TaskTimeController'
import type { TaskInstance } from '../../../src/types'
import TimeEditModal from '../../../src/ui/modals/TimeEditModal'
import ScheduledTimeModal from '../../../src/ui/modals/ScheduledTimeModal'

jest.mock('obsidian', () => {
  const Actual = jest.requireActual('obsidian')
  return {
    ...Actual,
    Notice: jest.fn(),
    TFile: class MockTFile {},
    Modal: class MockModal {},
  }
})

jest.mock('../../../src/ui/modals/TimeEditModal', () => {
  const ctor = jest.fn().mockImplementation((options) => {
    return {
      open: jest.fn(),
      options,
    }
  })
  return {
    __esModule: true,
    default: ctor,
  }
})

jest.mock('../../../src/ui/modals/ScheduledTimeModal', () => {
  const ctor = jest.fn().mockImplementation((options) => {
    return {
      open: jest.fn(),
      options,
    }
  })
  return {
    __esModule: true,
    default: ctor,
  }
})

describe('TaskTimeController', () => {
  const createHost = (): TaskTimeControllerHost => {
    return {
      tv: (_key, fallback, vars) => {
        if (vars && vars.title) {
          return fallback.replace('{title}', String(vars.title))
        }
        if (vars && vars.time) {
          return fallback.replace('{time}', String(vars.time))
        }
        return fallback
      },
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(),
          read: jest.fn(),
        },
        fileManager: {
          processFrontMatter: jest.fn(),
        },
      },
      renderTaskList: jest.fn(),
      reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
      getInstanceDisplayTitle: jest.fn(() => 'Sample Task'),
      persistSlotAssignment: jest.fn(),
      executionLogService: {
        saveTaskLog: jest.fn().mockResolvedValue(undefined),
      },
      calculateCrossDayDuration: jest.fn(() => 0),
      saveRunningTasksState: jest.fn().mockResolvedValue(undefined),
      removeTaskLogForInstanceOnCurrentDate: jest.fn().mockResolvedValue(undefined),
      getCurrentDate: () => new Date('2025-10-09T00:00:00Z'),
    }
  }

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
    ;(TimeEditModal as unknown as jest.Mock).mockClear()
    ;(ScheduledTimeModal as unknown as jest.Mock).mockClear()
  })

  test('resetTaskToIdle clears instance timing and triggers persistence', async () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance: TaskInstance = {
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
      },
      instanceId: 'inst-1',
      state: 'done',
      slotKey: '8:00-12:00',
      startTime: new Date('2025-10-09T02:00:00Z'),
      stopTime: new Date('2025-10-09T03:30:00Z'),
    } as TaskInstance

    await controller.resetTaskToIdle(instance)

    expect(instance.state).toBe('idle')
    expect(instance.startTime).toBeUndefined()
    expect(instance.stopTime).toBeUndefined()
    expect(host.removeTaskLogForInstanceOnCurrentDate).toHaveBeenCalledWith('inst-1')
    expect(host.saveRunningTasksState).toHaveBeenCalled()
    expect(host.renderTaskList).toHaveBeenCalled()
    expect(Notice).toHaveBeenCalled()
  })

  test('showTimeEditModal skips when start time is missing or state invalid', () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance = {
      state: 'running',
      startTime: undefined,
    } as TaskInstance

    controller.showTimeEditModal(instance)

    expect((TimeEditModal as unknown as jest.Mock).mock.calls.length).toBe(0)
  })

  test('showTimeEditModal wires callbacks into TimeEditModal and opens it', async () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance = {
      state: 'done',
      startTime: new Date('2025-10-10T02:00:00Z'),
      stopTime: new Date('2025-10-10T03:30:00Z'),
    } as TaskInstance

    const resetSpy = jest.spyOn(controller, 'resetTaskToIdle')
    const updateRunningSpy = jest.spyOn(
      controller as unknown as {
        updateRunningInstanceStartTime: (inst: TaskInstance, start: string) => Promise<void>
      },
      'updateRunningInstanceStartTime',
    )
    const updateTimesSpy = jest.spyOn(
      controller as unknown as {
        updateInstanceTimes: (inst: TaskInstance, start: string, stop: string) => Promise<void>
      },
      'updateInstanceTimes',
    )

    controller.showTimeEditModal(instance)

    const modalMock = TimeEditModal as unknown as jest.Mock
    expect(modalMock).toHaveBeenCalledTimes(1)
    const [options] = modalMock.mock.calls[0]
    expect(options.instance).toBe(instance)
    const modalInstance = modalMock.mock.results[0].value as { open: jest.Mock }
    expect(modalInstance.open).toHaveBeenCalledTimes(1)

    await options.callbacks.resetTaskToIdle()
    expect(resetSpy).toHaveBeenCalledWith(instance)

    await options.callbacks.updateRunningInstanceStartTime('02:15')
    expect(updateRunningSpy).toHaveBeenCalledWith(instance, '02:15')

    await options.callbacks.updateInstanceTimes('02:15', '03:30')
    expect(updateTimesSpy).toHaveBeenCalledWith(instance, '02:15', '03:30')

    resetSpy.mockRestore()
    updateRunningSpy.mockRestore()
    updateTimesSpy.mockRestore()
  })

  test('showScheduledTimeEditModal opens ScheduledTimeModal', () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance = {
      state: 'idle',
      task: {
        path: 'Tasks/sample.md',
        frontmatter: {},
        name: 'sample',
      },
    } as TaskInstance

    controller.showScheduledTimeEditModal(instance)

    const modalMock = ScheduledTimeModal as unknown as jest.Mock
    expect(modalMock).toHaveBeenCalledTimes(1)
    const [options] = modalMock.mock.calls[0]
    expect(options.instance).toBe(instance)
    const modalInstance = modalMock.mock.results[0].value as { open: jest.Mock }
    expect(modalInstance.open).toHaveBeenCalledTimes(1)
  })
})
