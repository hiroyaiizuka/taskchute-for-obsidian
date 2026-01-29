import { Notice } from 'obsidian'
import TaskTimeController, { TaskTimeControllerHost } from '../../../src/ui/time/TaskTimeController'
import type { TaskInstance } from '../../../src/types'
import TimeEditPopup from '../../../src/ui/time/TimeEditPopup'
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

jest.mock('../../../src/ui/time/TimeEditPopup', () => {
  const showMock = jest.fn()
  const ctor = jest.fn().mockImplementation(() => {
    return { show: showMock, close: jest.fn() }
  })
  return {
    __esModule: true,
    default: ctor,
    _showMock: showMock,
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
  const flushPromises = async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  const createHost = (currentDate: Date = new Date('2025-10-09T00:00:00Z')): TaskTimeControllerHost => {
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
      stopInstance: jest.fn().mockResolvedValue(undefined),
      confirmStopNextDay: jest.fn().mockResolvedValue(true),
      setCurrentInstance: jest.fn(),
      startGlobalTimer: jest.fn(),
      restartTimerService: jest.fn(),
      removeTaskLogForInstanceOnCurrentDate: jest.fn().mockResolvedValue(undefined),
      getCurrentDate: () => new Date(currentDate),
    }
  }

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
    ;(TimeEditPopup as unknown as jest.Mock).mockClear()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
    _showMock.mockClear()
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
        taskId: 'tc-task-sample',
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
    expect(host.removeTaskLogForInstanceOnCurrentDate).toHaveBeenCalledWith('inst-1', 'tc-task-sample')
    expect(host.saveRunningTasksState).toHaveBeenCalled()
    expect(host.renderTaskList).toHaveBeenCalled()
    expect(Notice).toHaveBeenCalled()
  })

  test('showStartTimePopup creates TimeEditPopup and calls show', () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const startTime = new Date(2025, 9, 10, 14, 0, 0, 0)
    const instance = {
      state: 'done',
      startTime,
      stopTime: new Date(2025, 9, 10, 15, 30, 0, 0),
    } as TaskInstance
    const anchor = document.createElement('span')

    controller.showStartTimePopup(instance, anchor)

    expect((TimeEditPopup as unknown as jest.Mock)).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
    expect(_showMock).toHaveBeenCalledTimes(1)
    const options = _showMock.mock.calls[0][0]
    expect(options.anchor).toBe(anchor)
    expect(options.currentValue).toBe('14:00')
  })

  test('showStartTimePopup starts timers and sets current instance for today', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-10-09T12:00:00Z'))

    try {
      const host = createHost(new Date('2025-10-09T00:00:00Z'))
      const controller = new TaskTimeController(host)
      const instance: TaskInstance = {
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          taskId: 'tc-task-sample',
        },
        instanceId: 'inst-1',
        state: 'idle',
        slotKey: 'none',
      } as TaskInstance
      const anchor = document.createElement('span')

      controller.showStartTimePopup(instance, anchor)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
      const options = _showMock.mock.calls[0][0]
      options.onSave('10:00')

      await flushPromises()

      expect(host.setCurrentInstance).toHaveBeenCalledWith(instance)
      expect(host.startGlobalTimer).toHaveBeenCalled()
      expect(host.restartTimerService).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('showStartTimePopup blocks future view date', () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-10-09T12:00:00Z'))

    try {
      const host = createHost(new Date('2025-10-10T00:00:00Z'))
      const controller = new TaskTimeController(host)
      const instance = {
        state: 'idle',
      } as TaskInstance
      const anchor = document.createElement('span')

      controller.showStartTimePopup(instance, anchor)

      expect((TimeEditPopup as unknown as jest.Mock)).not.toHaveBeenCalled()
      expect(Notice).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('showStopTimePopup requires startTime', () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance = {
      state: 'idle',
      startTime: undefined,
    } as TaskInstance
    const anchor = document.createElement('span')

    controller.showStopTimePopup(instance, anchor)

    expect((TimeEditPopup as unknown as jest.Mock)).not.toHaveBeenCalled()
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
        taskId: 'tc-task-sample',
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

  test('updateInstanceTimes rolls stop time into next day when needed', async () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance: TaskInstance = {
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
        taskId: 'tc-task-sample',
      },
      state: 'done',
      slotKey: 'evening',
      startTime: new Date(2025, 9, 10, 23, 0, 0, 0),
      stopTime: new Date(2025, 9, 11, 8, 0, 0, 0),
    } as TaskInstance

    const durationSpy = jest
      .spyOn(host, 'calculateCrossDayDuration')
      .mockImplementation((start, stop) => (stop!.getTime() - start!.getTime()))

    await (controller as unknown as {
      updateInstanceTimes: (inst: TaskInstance, startStr: string, stopStr: string) => Promise<void>
    }).updateInstanceTimes(instance, '23:00', '00:30')

    expect(instance.startTime?.getHours()).toBe(23)
    expect(instance.stopTime?.getDate()).toBe(instance.startTime!.getDate() + 1)
    expect(instance.stopTime?.getHours()).toBe(0)
    expect(instance.stopTime?.getMinutes()).toBe(30)
    expect(durationSpy).toHaveBeenCalled()
  })

  test('updateInstanceTimes keeps same-day stop when stop is after start', async () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance: TaskInstance = {
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
      },
      state: 'done',
      slotKey: 'morning',
      startTime: new Date(2025, 9, 10, 8, 0, 0, 0),
      stopTime: new Date(2025, 9, 10, 9, 0, 0, 0),
    } as TaskInstance

    const durationSpy = jest
      .spyOn(host, 'calculateCrossDayDuration')
      .mockImplementation((start, stop) => (stop!.getTime() - start!.getTime()))

    await (controller as unknown as {
      updateInstanceTimes: (inst: TaskInstance, startStr: string, stopStr: string) => Promise<void>
    }).updateInstanceTimes(instance, '08:30', '09:15')

    expect(instance.startTime?.getHours()).toBe(8)
    expect(instance.startTime?.getMinutes()).toBe(30)
    expect(instance.stopTime?.getHours()).toBe(9)
    expect(instance.stopTime?.getMinutes()).toBe(15)
    expect(instance.stopTime?.getDate()).toBe(instance.startTime?.getDate())
    expect(durationSpy).toHaveBeenCalled()
  })

  test('updateInstanceTimes transitions running task to done when stop time is provided', async () => {
    const host = createHost()
    const controller = new TaskTimeController(host)
    const instance: TaskInstance = {
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
        taskId: 'tc-task-sample',
      },
      instanceId: 'inst-1',
      state: 'running',
      slotKey: '8:00-12:00',
      startTime: new Date(2025, 9, 10, 10, 0, 0, 0),
    } as TaskInstance

    jest
      .spyOn(host, 'calculateCrossDayDuration')
      .mockImplementation((start, stop) => (stop!.getTime() - start!.getTime()))

    await (controller as unknown as {
      updateInstanceTimes: (inst: TaskInstance, startStr: string, stopStr: string) => Promise<void>
    }).updateInstanceTimes(instance, '10:00', '11:59')

    expect(instance.state).toBe('done')
    expect(instance.stopTime?.getHours()).toBe(11)
    expect(instance.stopTime?.getMinutes()).toBe(59)
    expect(host.executionLogService.saveTaskLog).toHaveBeenCalled()
    expect(host.saveRunningTasksState).toHaveBeenCalled()
  })

  test('showStopTimePopup rejects stop time equal to start time', async () => {
    const host = createHost(new Date('2025-10-10T00:00:00Z'))
    const controller = new TaskTimeController(host)
    const instance: TaskInstance = {
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
        taskId: 'tc-task-sample',
      },
      instanceId: 'inst-1',
      state: 'done',
      slotKey: '8:00-12:00',
      startTime: new Date(2025, 9, 10, 10, 0, 0, 0),
      stopTime: new Date(2025, 9, 10, 11, 0, 0, 0),
    } as TaskInstance
    const anchor = document.createElement('span')

    controller.showStopTimePopup(instance, anchor)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
    const options = _showMock.mock.calls[0][0]
    options.onSave('10:00')

    await flushPromises()

    expect(host.executionLogService.saveTaskLog).not.toHaveBeenCalled()
    expect(Notice).toHaveBeenCalled()
  })

  test('showStopTimePopup allows stop before start as cross-day task', async () => {
    const host = createHost(new Date('2025-10-10T00:00:00Z'))
    const controller = new TaskTimeController(host)
    host.confirmStopNextDay = jest.fn().mockResolvedValue(true)
    const instance: TaskInstance = {
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
        taskId: 'tc-task-sample',
      },
      instanceId: 'inst-1',
      state: 'done',
      slotKey: '8:00-12:00',
      startTime: new Date(2025, 9, 10, 10, 0, 0, 0),
      stopTime: new Date(2025, 9, 10, 12, 0, 0, 0),
    } as TaskInstance
    const anchor = document.createElement('span')

    controller.showStopTimePopup(instance, anchor)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
    const options = _showMock.mock.calls[0][0]
    options.onSave('09:00')

    await flushPromises()

    // Cross-day: stop (09:00) before start (10:00) is allowed
    expect(host.confirmStopNextDay).toHaveBeenCalled()
    expect(host.executionLogService.saveTaskLog).toHaveBeenCalled()
  })

  test('showStopTimePopup blocks cross-day stop when confirmation is declined', async () => {
    const host = createHost(new Date('2025-10-10T00:00:00Z'))
    const controller = new TaskTimeController(host)
    host.confirmStopNextDay = jest.fn().mockResolvedValue(false)
    const instance: TaskInstance = {
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
        taskId: 'tc-task-sample',
      },
      instanceId: 'inst-1',
      state: 'done',
      slotKey: '8:00-12:00',
      startTime: new Date(2025, 9, 10, 10, 0, 0, 0),
      stopTime: new Date(2025, 9, 10, 12, 0, 0, 0),
    } as TaskInstance
    const anchor = document.createElement('span')

    controller.showStopTimePopup(instance, anchor)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
    const options = _showMock.mock.calls[0][0]
    options.onSave('09:00')

    await flushPromises()

    expect(host.confirmStopNextDay).toHaveBeenCalled()
    expect(host.executionLogService.saveTaskLog).not.toHaveBeenCalled()
  })

  test('showStopTimePopup blocks running stop that would be in the future on today view', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-10-10T11:00:00Z'))

    try {
      const host = createHost(new Date('2025-10-10T00:00:00Z'))
      const controller = new TaskTimeController(host)
      host.confirmStopNextDay = jest.fn().mockResolvedValue(true)
      const instance: TaskInstance = {
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          taskId: 'tc-task-sample',
        },
        instanceId: 'inst-1',
        state: 'running',
        slotKey: '8:00-12:00',
        startTime: new Date(2025, 9, 10, 10, 0, 0, 0),
      } as TaskInstance
      const anchor = document.createElement('span')

      controller.showStopTimePopup(instance, anchor)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
      const options = _showMock.mock.calls[0][0]
      options.onSave('09:00')

      await flushPromises()

      expect(host.stopInstance).not.toHaveBeenCalled()
      expect(Notice).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('showStopTimePopup blocks running stop that would be in the future on past-date view', async () => {
    jest.useFakeTimers()
    const startTime = new Date(2025, 9, 10, 23, 0, 0, 0)
    const computedStop = new Date(2025, 9, 10, 1, 0, 0, 0)
    if (computedStop <= startTime) {
      computedStop.setDate(computedStop.getDate() + 1)
    }
    jest.setSystemTime(new Date(computedStop.getTime() - 30 * 60 * 1000))

    try {
      // viewDate is Oct 10 (yesterday), system date is Oct 11 (today)
      const host = createHost(new Date(2025, 9, 10, 0, 0, 0, 0))
      const controller = new TaskTimeController(host)
      host.confirmStopNextDay = jest.fn().mockResolvedValue(true)
      const instance: TaskInstance = {
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          taskId: 'tc-task-sample',
        },
        instanceId: 'inst-1',
        state: 'running',
        slotKey: '8:00-12:00',
        startTime,
      } as TaskInstance
      const anchor = document.createElement('span')

      controller.showStopTimePopup(instance, anchor)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
      const options = _showMock.mock.calls[0][0]
      options.onSave('01:00')

      await flushPromises()

      expect(host.stopInstance).not.toHaveBeenCalled()
      expect(Notice).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('showStopTimePopup routes running stop through stopInstance on today view', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-10-10T12:00:00Z'))

    try {
      const host = createHost(new Date('2025-10-10T00:00:00Z'))
      const controller = new TaskTimeController(host)
      const instance: TaskInstance = {
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          taskId: 'tc-task-sample',
        },
        instanceId: 'inst-1',
        state: 'running',
        slotKey: '8:00-12:00',
        startTime: new Date(2025, 9, 10, 10, 0, 0, 0),
      } as TaskInstance
      const anchor = document.createElement('span')

      controller.showStopTimePopup(instance, anchor)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
      const options = _showMock.mock.calls[0][0]
      options.onSave('11:00')

      await flushPromises()

      expect(host.stopInstance).toHaveBeenCalledWith(instance, expect.any(Date))
      expect(host.executionLogService.saveTaskLog).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('showStopTimePopup on past-date view still routes through stopInstance', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2025-10-11T12:00:00Z'))

    try {
      // viewDate is Oct 10 (yesterday), system date is Oct 11 (today)
      const host = createHost(new Date('2025-10-10T00:00:00Z'))
      const controller = new TaskTimeController(host)
      const instance: TaskInstance = {
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          taskId: 'tc-task-sample',
        },
        instanceId: 'inst-1',
        state: 'running',
        slotKey: '8:00-12:00',
        startTime: new Date(2025, 9, 10, 10, 0, 0, 0),
      } as TaskInstance
      const anchor = document.createElement('span')

      controller.showStopTimePopup(instance, anchor)

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { _showMock } = require('../../../src/ui/time/TimeEditPopup')
      const options = _showMock.mock.calls[0][0]
      options.onSave('11:00')

      await flushPromises()

      // Past-date view: still routes through stopInstance (timer control handled there)
      expect(host.stopInstance).toHaveBeenCalledWith(instance, expect.any(Date))
    } finally {
      jest.useRealTimers()
    }
  })
})
