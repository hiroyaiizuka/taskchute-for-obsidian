import { TFile } from 'obsidian'
import TaskScheduleController, { TaskScheduleControllerHost } from '../../../src/ui/task/TaskScheduleController'
import type { TaskInstance } from '../../../src/types'

jest.mock('obsidian', () => {
  const Actual = jest.requireActual('obsidian')
  return {
    ...Actual,
    Notice: jest.fn(),
    TFile: class MockTFile {},
  }
})

describe('TaskScheduleController', () => {
  const createCalendarFactory = () => {
    const handles: Array<{ open: jest.Mock; close: jest.Mock; options: unknown }> = []

    const factory = jest.fn((options) => {
      const open = jest.fn()
      const close = jest.fn(() => {
        options.onClose?.()
      })
      if (typeof options.registerDisposer === 'function') {
        options.registerDisposer(() => close())
      }
      const handle = { open, close, options }
      handles.push(handle)
      return handle
    })

    return { factory, handles }
  }

  const createHost = (overrides: Partial<TaskScheduleControllerHost> = {}) => {
    const vault = {
      getAbstractFileByPath: jest.fn((path: string) => {
        if (path === 'TASKS/sample.md') {
          const file = new (TFile)()
          file.path = path
          return file
        }
        return null
      }),
    }

    const fileManager = {
      processFrontMatter: jest.fn().mockResolvedValue(undefined),
    }

    const host: TaskScheduleControllerHost = {
      tv: (_key, fallback) => fallback,
      getInstanceDisplayTitle: () => 'Sample',
      reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
      app: {
        vault,
        fileManager,
      },
      getCurrentDate: () => new Date('2025-10-09T00:00:00Z'),
      registerDisposer: jest.fn(),
      ...overrides,
    }

    return { host, vault, fileManager }
  }

  const createInstance = (overrides: Partial<TaskInstance> = {}): TaskInstance => ({
    task: {
      path: overrides.task?.path ?? 'TASKS/sample.md',
      frontmatter: overrides.task?.frontmatter ?? {},
      name: overrides.task?.name ?? 'sample',
    },
    ...overrides,
  } as TaskInstance)

  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('moveTaskToDate writes frontmatter and reloads', async () => {
    const { host, fileManager } = createHost()
    const controller = new TaskScheduleController(host)
    const instance = createInstance()

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
  })

  test('moveTaskToDate migrates a running-task record before structural move and reload', async () => {
    const moveRunningTaskToDate = jest.fn().mockResolvedValue(1)
    const { host, fileManager } = createHost({ moveRunningTaskToDate })
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      state: 'running',
      instanceId: 'running-instance',
    })

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveRunningTaskToDate).toHaveBeenCalledWith(instance, '2025-10-10')
    const structuralMoveOrder =
      fileManager.processFrontMatter.mock.invocationCallOrder[0] ?? 0
    const runningRecordMoveOrder =
      moveRunningTaskToDate.mock.invocationCallOrder[0] ?? 0
    const reloadOrder =
      (host.reloadTasksAndRestore as jest.Mock).mock.invocationCallOrder[0] ?? 0
    expect(runningRecordMoveOrder).toBeLessThan(structuralMoveOrder)
    expect(structuralMoveOrder).toBeLessThan(reloadOrder)
  })

  test('moveTaskToDate does not migrate a running-task record for an idle task', async () => {
    const moveRunningTaskToDate = jest.fn().mockResolvedValue(1)
    const { host } = createHost({ moveRunningTaskToDate })
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      state: 'idle',
      instanceId: 'idle-instance',
    })

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveRunningTaskToDate).not.toHaveBeenCalled()
    expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
  })

  test('moveTaskToDate aborts before structural mutation when running-task migration fails', async () => {
    const moveRunningTaskToDate = jest.fn().mockRejectedValue(new Error('disk full'))
    const { host, fileManager } = createHost({ moveRunningTaskToDate })
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      state: 'running',
      instanceId: 'running-instance',
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveRunningTaskToDate).toHaveBeenCalledTimes(1)
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled()
    expect(host.reloadTasksAndRestore).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('moveTaskToDate aborts before structural mutation when no running-task record matches', async () => {
    const moveRunningTaskToDate = jest.fn().mockResolvedValue(0)
    const { host, fileManager } = createHost({ moveRunningTaskToDate })
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      state: 'running',
      instanceId: 'missing-running-instance',
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveRunningTaskToDate).toHaveBeenCalledTimes(1)
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled()
    expect(host.reloadTasksAndRestore).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('moveTaskToDate compensates the running-task record when structural mutation fails', async () => {
    const moveRunningTaskToDate = jest.fn().mockResolvedValue(1)
    const { host, fileManager } = createHost({ moveRunningTaskToDate })
    fileManager.processFrontMatter.mockRejectedValue(new Error('frontmatter write failed'))
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      state: 'running',
      instanceId: 'running-instance',
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveRunningTaskToDate.mock.calls).toEqual([
      [instance, '2025-10-10'],
      [instance, '2025-10-09'],
    ])
    expect(host.reloadTasksAndRestore).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  test('moveTaskToDate keeps the migrated record when only reload fails after structural success', async () => {
    const moveRunningTaskToDate = jest.fn().mockResolvedValue(1)
    const reloadTasksAndRestore = jest.fn().mockRejectedValue(new Error('reload failed'))
    const { host } = createHost({
      moveRunningTaskToDate,
      reloadTasksAndRestore,
    })
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      state: 'running',
      instanceId: 'running-instance',
    })
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveRunningTaskToDate).toHaveBeenCalledTimes(1)
    expect(moveRunningTaskToDate).toHaveBeenCalledWith(instance, '2025-10-10')
    errorSpy.mockRestore()
  })

  test('moveTaskToDate keeps non-routine slot assignment across date move', async () => {
    const moveNonRoutineSlotOverrideToDate = jest.fn().mockResolvedValue(undefined)
    const { host } = createHost({
      moveNonRoutineSlotOverrideToDate,
    })
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      slotKey: '16:00-0:00',
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
        isRoutine: false,
      },
    })

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveNonRoutineSlotOverrideToDate).toHaveBeenCalledWith(instance, '2025-10-10')
  })

  test('moveTaskToDate does not copy slot assignment for routine task', async () => {
    const moveNonRoutineSlotOverrideToDate = jest.fn().mockResolvedValue(undefined)
    const { host } = createHost({
      moveNonRoutineSlotOverrideToDate,
    })
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      slotKey: '16:00-0:00',
      task: {
        path: 'TASKS/sample.md',
        frontmatter: {},
        name: 'sample',
        isRoutine: true,
      },
    })

    await controller.moveTaskToDate(instance, '2025-10-10')

    expect(moveNonRoutineSlotOverrideToDate).not.toHaveBeenCalled()
  })

  test('clearTaskTargetDate removes frontmatter and reloads', async () => {
    const { host, fileManager } = createHost()
    const controller = new TaskScheduleController(host)
    const instance = createInstance({
      task: {
        path: 'TASKS/sample.md',
        frontmatter: { target_date: '2025-10-01' },
        name: 'sample',
      },
    })

    await controller.clearTaskTargetDate(instance)

    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(host.reloadTasksAndRestore).toHaveBeenCalled()
  })

  test('showTaskMoveDatePicker creates calendar, registers disposer, and opens it', () => {
    const { host } = createHost()
    const { factory, handles } = createCalendarFactory()
    const controller = new TaskScheduleController(host, { createCalendar: factory })
    const instance = createInstance()
    const anchor = document.createElement('button')

    controller.showTaskMoveDatePicker(instance, anchor)

    expect(factory).toHaveBeenCalled()
    expect(handles[0]?.open).toHaveBeenCalled()
    expect(host.registerDisposer).toHaveBeenCalledTimes(1)

    const disposer = (host.registerDisposer as jest.Mock).mock.calls[0][0] as () => void
    disposer()
    expect(handles[0]?.close).toHaveBeenCalledTimes(1)
  })

  test('showTaskMoveDatePicker uses current view date even when target_date exists', () => {
    const { host } = createHost()
    const { factory, handles } = createCalendarFactory()
    const controller = new TaskScheduleController(host, { createCalendar: factory })
    const instance = createInstance({
      task: {
        path: 'TASKS/sample.md',
        frontmatter: { target_date: '2025-10-20' },
        name: 'sample',
      },
    })
    const anchor = document.createElement('button')

    controller.showTaskMoveDatePicker(instance, anchor)

    const options = handles[0]?.options as { initialDate: Date }
    const expected = host.getCurrentDate()
    expect(options.initialDate.getFullYear()).toBe(expected.getFullYear())
    expect(options.initialDate.getMonth()).toBe(expected.getMonth())
    expect(options.initialDate.getDate()).toBe(expected.getDate())
  })

  test('showTaskMoveDatePicker closes existing calendar before opening new one', () => {
    const { host } = createHost()
    const { factory, handles } = createCalendarFactory()
    const controller = new TaskScheduleController(host, { createCalendar: factory })
    const instance = createInstance()
    const anchor = document.createElement('button')

    controller.showTaskMoveDatePicker(instance, anchor)
    controller.showTaskMoveDatePicker(instance, anchor)

    expect(handles[0]?.close).toHaveBeenCalled()
    expect(handles[1]?.open).toHaveBeenCalled()
  })

  describe('duplicate instance move behavior', () => {
    test('running duplicate move to its current date is an idempotent no-op', async () => {
      const moveDuplicateInstanceToDate = jest.fn().mockResolvedValue(undefined)
      const removeDuplicateInstanceFromCurrentDate = jest.fn().mockResolvedValue(undefined)
      const moveRunningTaskToDate = jest.fn().mockResolvedValue(1)
      const { host, fileManager } = createHost({
        isDuplicateInstance: jest.fn().mockReturnValue(true),
        moveDuplicateInstanceToDate,
        removeDuplicateInstanceFromCurrentDate,
        moveRunningTaskToDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        instanceId: 'live-duplicate',
        state: 'running',
      })

      await controller.moveTaskToDate(instance, '2025-10-09')

      expect(moveDuplicateInstanceToDate).not.toHaveBeenCalled()
      expect(removeDuplicateInstanceFromCurrentDate).not.toHaveBeenCalled()
      expect(moveRunningTaskToDate).not.toHaveBeenCalled()
      expect(fileManager.processFrontMatter).not.toHaveBeenCalled()
      expect(host.reloadTasksAndRestore).not.toHaveBeenCalled()
    })

    test('running duplicate structural failure restores its running-task record', async () => {
      const moveDuplicateInstanceToDate = jest
        .fn()
        .mockRejectedValue(new Error('target dayState write failed'))
      const removeDuplicateInstanceFromCurrentDate = jest.fn().mockResolvedValue(undefined)
      const moveRunningTaskToDate = jest.fn().mockResolvedValue(1)
      const { host } = createHost({
        isDuplicateInstance: jest.fn().mockReturnValue(true),
        moveDuplicateInstanceToDate,
        removeDuplicateInstanceFromCurrentDate,
        moveRunningTaskToDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        instanceId: 'live-duplicate',
        state: 'running',
      })
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)

      await controller.moveTaskToDate(instance, '2025-10-10')

      expect(moveRunningTaskToDate.mock.calls).toEqual([
        [instance, '2025-10-10'],
        [instance, '2025-10-09'],
      ])
      expect(removeDuplicateInstanceFromCurrentDate).not.toHaveBeenCalled()
      expect(host.reloadTasksAndRestore).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    test('moveTaskToDate for duplicate instance should NOT modify frontmatter, only call moveDuplicateInstanceToDate', async () => {
      const moveDuplicateInstanceToDate = jest.fn().mockResolvedValue(undefined)
      const isDuplicateInstance = jest.fn().mockReturnValue(true)
      const { host, fileManager } = createHost({
        isDuplicateInstance,
        moveDuplicateInstanceToDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({ instanceId: 'dup-123' })

      await controller.moveTaskToDate(instance, '2025-10-10')

      // frontmatter should NOT be modified for duplicate instances
      expect(fileManager.processFrontMatter).not.toHaveBeenCalled()
      // moveDuplicateInstanceToDate should be called instead
      expect(moveDuplicateInstanceToDate).toHaveBeenCalledWith(instance, '2025-10-10')
      expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
    })

    test('moveTaskToDate for non-duplicate instance should modify frontmatter as before', async () => {
      const moveDuplicateInstanceToDate = jest.fn().mockResolvedValue(undefined)
      const isDuplicateInstance = jest.fn().mockReturnValue(false)
      const { host, fileManager } = createHost({
        isDuplicateInstance,
        moveDuplicateInstanceToDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance()

      await controller.moveTaskToDate(instance, '2025-10-10')

      // frontmatter should be modified for non-duplicate instances
      expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
      // moveDuplicateInstanceToDate should NOT be called
      expect(moveDuplicateInstanceToDate).not.toHaveBeenCalled()
      expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
    })

    test('moveTaskToDate for duplicate instance should remove it from current date duplicatedInstances', async () => {
      const removeDuplicateInstanceFromCurrentDate = jest.fn().mockResolvedValue(undefined)
      const moveDuplicateInstanceToDate = jest.fn().mockResolvedValue(undefined)
      const isDuplicateInstance = jest.fn().mockReturnValue(true)
      const { host, fileManager } = createHost({
        isDuplicateInstance,
        moveDuplicateInstanceToDate,
        removeDuplicateInstanceFromCurrentDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({ instanceId: 'dup-123' })

      await controller.moveTaskToDate(instance, '2025-10-10')

      expect(fileManager.processFrontMatter).not.toHaveBeenCalled()
      expect(removeDuplicateInstanceFromCurrentDate).toHaveBeenCalledWith(instance)
      expect(moveDuplicateInstanceToDate).toHaveBeenCalledWith(instance, '2025-10-10')
    })

    test('moveTaskToDate without isDuplicateInstance should fallback to frontmatter modification (backward compatibility)', async () => {
      // When host does not provide isDuplicateInstance, treat as non-duplicate
      const { host, fileManager } = createHost()
      const controller = new TaskScheduleController(host)
      const instance = createInstance()

      await controller.moveTaskToDate(instance, '2025-10-10')

      expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
      expect(host.reloadTasksAndRestore).toHaveBeenCalledTimes(1)
    })
  })

  describe('routine move to past date', () => {
    test('hides routine on current date when moved to past', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host, fileManager } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          isRoutine: true,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-08')

      expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
      expect(hideRoutineInstanceForDate).toHaveBeenCalledWith(instance, '2025-10-09')
    })

    test('does not hide when target is future', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          isRoutine: true,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-10')

      expect(hideRoutineInstanceForDate).not.toHaveBeenCalled()
    })

    test('does not hide non-routine even when target is past', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: {},
          name: 'sample',
          isRoutine: false,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-08')

      expect(hideRoutineInstanceForDate).not.toHaveBeenCalled()
    })

    test('hides previous target date when retargeting', async () => {
      const hideRoutineInstanceForDate = jest.fn().mockResolvedValue(undefined)
      const { host } = createHost({
        hideRoutineInstanceForDate,
      })
      const controller = new TaskScheduleController(host)
      const instance = createInstance({
        task: {
          path: 'TASKS/sample.md',
          frontmatter: { target_date: '2025-10-24' },
          name: 'sample',
          isRoutine: true,
        },
      })

      await controller.moveTaskToDate(instance, '2025-10-17')

      expect(hideRoutineInstanceForDate).toHaveBeenCalledWith(instance, '2025-10-24')
    })
  })
})
